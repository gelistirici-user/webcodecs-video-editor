// Oynatma motoru: video/ses öğe havuzu, saat, ses ölçerleri
import { store } from './store.js';
import { layersAt, drawFrame, audioGain } from './compositor.js';
import { clamp, EPS } from './utils.js';
import { buildChain, ensureWorklet, afxActive } from './audiofx.js';
import { isRemapped, speedAt, srcTimeAt, srcSpan, bakeClipAudio, decodeSegment, WindowSource } from './timemap.js';

const LOOKAHEAD = 1.5;

export class Player {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.pool = new Map(); // clipId -> { el, kind, mediaId, gain }
    this.images = new Map(); // mediaId -> HTMLImageElement
    this.playing = false;
    this.rate = 1;
    this.loop = false;
    this.audioCtx = null;
    this.master = null;
    this.analysers = [];
    this._raf = null;
    this._renderQueued = false;
    this.onFrame = null;
    this.quality = 1; // önizleme çözünürlük çarpanı
    store.on('change', () => this.requestRender());
    store.on('playhead', () => { if (!this.playing) this.requestRender(); });
    store.on('media-cache', () => this.requestRender());
  }

  ensureAudio() {
    if (this.audioCtx) { if (this.audioCtx.state === 'suspended') this.audioCtx.resume(); return; }
    const ac = new AudioContext({ latencyHint: 'playback' });
    this.audioCtx = ac;
    this.master = ac.createGain();
    const splitter = ac.createChannelSplitter(2);
    this.analysers = [ac.createAnalyser(), ac.createAnalyser()];
    this.analysers.forEach((a) => { a.fftSize = 1024; a.smoothingTimeConstant = 0.2; });
    this.master.connect(splitter);
    splitter.connect(this.analysers[0], 0);
    splitter.connect(this.analysers[1], 1);
    this.master.connect(ac.destination);
    // mevcut öğeleri bağla
    for (const e of this.pool.values()) if (e.kind === 'audio') this.connectAudio(e);
  }

  connectAudio(entry) {
    if (!this.audioCtx || entry.gain) return;
    try {
      entry.src = this.audioCtx.createMediaElementSource(entry.el);
      entry.gain = this.audioCtx.createGain();
      entry.fxIn = this.audioCtx.createGain();
      entry.src.connect(entry.fxIn);
      entry.fxIn.connect(entry.gain).connect(this.master);
      entry.afxKey = '';
    } catch { /* bağlanamadı: öğe sesi doğrudan çalar */ }
  }

  // klip ses efektleri değiştiyse zinciri yeniden kur: fxIn -> [zincir] -> gain
  applyAfx(entry, afx) {
    if (!entry.fxIn) return;
    const key = afxActive(afx) ? JSON.stringify(afx) : '';
    if (entry.afxKey === key) return;
    entry.afxKey = key;
    const ac = this.audioCtx;
    const rebuild = (ok) => {
      if (entry.afxKey !== key) return;
      try { entry.fxIn.disconnect(); } catch { /* */ }
      if (entry.chain) { try { entry.chain.output.disconnect(); } catch { /* */ } }
      entry.chain = null;
      if (!key) { entry.fxIn.connect(entry.gain); return; }
      entry.chain = buildChain(ac, afx, ok);
      entry.fxIn.connect(entry.chain.input);
      entry.chain.output.connect(entry.gain);
    };
    if (afx?.denoise > 0) ensureWorklet(ac).then(rebuild); else rebuild(false);
  }

  levels() {
    if (!this.analysers.length || !this.playing) return [0, 0];
    return this.analysers.map((a) => {
      const d = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(d);
      let pk = 0;
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
      return pk;
    });
  }

  mediaMap() { return new Map(store.project.media.map((m) => [m.id, m])); }

  getEntry(clip, media) {
    let e = this.pool.get(clip.id);
    if (e && e.url === media.url) return e;
    if (e) this.release(clip.id);
    if (media.offline || !media.url) return null;
    const track = store.track(clip.trackId);
    const kind = track.kind;
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.playsInline = true;
    el.preservesPitch = false;
    if (kind === 'video') el.muted = true;
    el.src = media.url;
    el.addEventListener('seeked', () => { if (!this.playing) this.requestRender(); });
    el.addEventListener('loadeddata', () => { if (!this.playing) this.requestRender(); });
    e = { el, kind, mediaId: media.id, url: media.url, gain: null };
    this.pool.set(clip.id, e);
    if (kind === 'audio') this.connectAudio(e);
    return e;
  }

  release(id) {
    const e = this.pool.get(id);
    if (!e) return;
    try { e.el.pause(); e.el.removeAttribute('src'); e.el.load(); } catch { /* */ }
    this.stopBaked(e);
    e.rev?.dispose();
    this.pool.delete(id);
  }

  image(media) {
    let img = this.images.get(media.id);
    if (img && img.src === media.url) return img;
    const cached = store.mediaCache.get(media.id)?.image;
    if (cached) { this.images.set(media.id, cached); return cached; }
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => this.requestRender();
    img.src = media.url;
    this.images.set(media.id, img);
    return img;
  }

  // Görünür ve yakındaki klipler için öğeleri hazırla, uzak olanları bırak
  syncPool(t, layers, mm) {
    const P = store.project;
    const keep = new Set();
    for (const c of P.clips) {
      if (c.type !== 'media') continue;
      const m = mm.get(c.mediaId);
      if (!m || m.kind === 'image') continue;
      const tr = store.track(c.trackId);
      if (!tr) continue;
      if (tr.kind === 'audio' && m.kind !== 'audio' && !m.hasAudio) continue;
      const near = t >= c.start - LOOKAHEAD && t < c.start + c.duration + 0.5;
      if (!near) continue;
      keep.add(c.id);
      const e = this.getEntry(c, m);
      if (!e) continue;
      // yaklaşan klipleri giriş karesinde beklet
      const active = t >= c.start - EPS && t < c.start + c.duration;
      const inLayer = layers.some((L) => L.clip && L.clip.id === c.id);
      const s0 = srcTimeAt(c, c.start, m);
      if (!active && !inLayer && e.el.paused && Math.abs(e.el.currentTime - s0) > 0.05 && e.el.readyState >= 1) e.el.currentTime = s0;
    }
    for (const id of [...this.pool.keys()]) if (!keep.has(id)) this.release(id);
    return keep;
  }

  // ---------- hız eşlemeli ses (rampa/ters) ----------
  // klibin kaynak aralığını çöz (rampa/ters ses için)
  mediaAudio(m, c) {
    const a = c.in - 0.1, b = c.in + srcSpan(c) + 0.1;
    return decodeSegment(m.url, a, b).catch(() => null);
  }
  playBaked(e, c, m, local) {
    if (!this.audioCtx || !e.gain) return;
    const key = `${c.start}|${c.in}|${c.duration}|${c.speed}|${c.reverse}|${JSON.stringify(c.kf?.speed || null)}`;
    if (e.bakeKey !== key) {
      this.stopBaked(e);
      e.bakeKey = key; e.baked = null;
      this.mediaAudio(m, c).then((buf) => { if (buf && e.bakeKey === key) e.baked = bakeClipAudio(c, buf, m.duration); });
      return;
    }
    if (!e.baked) return;
    const now = this.audioCtx.currentTime;
    if (e.node) {
      const expected = e.nodeLocal + (now - e.nodeAt);
      if (Math.abs(expected - local) < 0.15) return;
      this.stopBaked(e, true);
    }
    const n = this.audioCtx.createBufferSource();
    n.buffer = e.baked;
    n.connect(e.fxIn || e.gain);
    n.start(0, clamp(local, 0, e.baked.duration));
    e.node = n; e.nodeAt = now; e.nodeLocal = local;
  }
  stopBaked(e, keepKey = false) {
    if (e.node) { try { e.node.stop(); e.node.disconnect(); } catch { /* */ } e.node = null; }
    if (!keepKey && !e.bakeKey) e.baked = null;
  }

  requestRender() {
    if (this.playing || this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => { this._renderQueued = false; this.renderAt(store.playhead, false); });
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.requestRender();
    }
  }

  renderAt(t, playing) {
    const P = store.project;
    const mm = this.mediaMap();
    const layers = layersAt(P, t, mm);
    this.syncPool(t, layers, mm);
    const fps = P.settings.fps;

    // video öğelerini zamanla
    const activeVideo = new Set();
    for (const L of layers) {
      if (!L.clip || L.clip.type !== 'media') continue;
      const m = mm.get(L.clip.mediaId);
      if (!m || m.kind !== 'video') continue;
      const e = this.pool.get(L.clip.id);
      if (!e) continue;
      activeVideo.add(L.clip.id);
      if (L.clip.reverse && playing) {
        // ters oynatma: video öğesi geriye oynayamaz; kareler pencereli çözücüden gelir
        if (!e.el.paused) e.el.pause();
        if (!e.rev) { e.rev = new WindowSource(m.url, { maxW: 640, win: 1, keep: 3 }); }
        e.rev.prefetch(L.srcTime);
      } else this.syncElement(e, L.srcTime, speedAt(L.clip, t), playing, fps);
    }
    // ses klipleri
    const tracks = store.audioTracks();
    const solo = tracks.some((tr) => tr.solo);
    for (const c of P.clips) {
      const e = this.pool.get(c.id);
      if (!e) continue;
      if (e.kind === 'video') { if (!activeVideo.has(c.id) && !e.el.paused) e.el.pause(); continue; }
      const tr = store.track(c.trackId);
      const active = t >= c.start - EPS && t < c.start + c.duration - EPS;
      const remap = isRemapped(c);
      if (active && this._prerolling && !remap) {
        // ön hazırlık: ses öğesini başlangıç konumuna getir (duraklatılmış)
        this.syncElement(e, srcTimeAt(c, t, mm.get(c.mediaId)), c.speed, false, fps);
        continue;
      }
      if (!active || !playing) { if (!e.el.paused) e.el.pause(); this.stopBaked(e); continue; }
      const m = mm.get(c.mediaId);
      let g = audioGain(c, t) * (tr.volume ?? 1) * (P.master ?? 1);
      if (tr.muted || (solo && !tr.solo)) g = 0;
      if (e.gain) e.gain.gain.setTargetAtTime(g, this.audioCtx.currentTime, 0.015);
      else e.el.volume = clamp(g, 0, 1);
      this.applyAfx(e, c.afx);
      if (remap) {
        // hız rampası / ters: önceden hesaplanmış ses tamponu çalınır
        if (!e.el.paused) e.el.pause();
        this.playBaked(e, c, m, t - c.start);
      } else {
        this.stopBaked(e);
        this.syncElement(e, srcTimeAt(c, t, m), c.speed, true, fps, 0.12);
      }
    }

    // Yeni yüklenen bir video henüz kare vermediyse siyah kare yerine önceki kareyi koru
    const waiting = layers.some((L) => {
      if (!L.clip || L.clip.type !== 'media') return false;
      const m = mm.get(L.clip.mediaId);
      if (!m || m.offline || m.kind !== 'video') return false;
      const e = this.pool.get(L.clip.id);
      if (e && e.rev && playing && L.clip.reverse) return !e.rev.frameAt(L.srcTime) && e.el.readyState < 2;
      return !e || e.el.readyState < 2;
    });
    if (waiting) {
      const now = performance.now();
      if (this._holdSince == null) this._holdSince = now;
      if (now - this._holdSince < 1500) {
        if (!playing) setTimeout(() => this.requestRender(), 120);
        this.onFrame?.(t, layers);
        return;
      }
    }
    this._holdSince = null;
    const W = this.canvas.width, H = this.canvas.height;
    drawFrame(this.ctx, W, H, P, t, layers, (L) => {
      const m = mm.get(L.clip.mediaId);
      if (!m || m.offline) return { offline: true };
      if (m.kind === 'image') { const img = this.image(m); return img.complete && img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null; }
      const e = this.pool.get(L.clip.id);
      if (e && e.rev && playing && L.clip.reverse) {
        const fc = e.rev.frameAt(L.srcTime);
        if (fc) return { el: fc, w: fc.width, h: fc.height };
      }
      if (!e || e.el.readyState < 2) return null;
      return { el: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
    });
    if (layers.length === 0 && P.clips.length === 0) this.drawEmpty(W, H);
    this.onFrame?.(t, layers);
  }

  drawEmpty(W, H) {
    const c = this.ctx;
    c.save();
    c.fillStyle = '#5f6470';
    c.font = `${Math.round(H * 0.035)}px "Segoe UI", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('Medyayı zaman çizelgesine sürükleyin', W / 2, H / 2);
    c.restore();
  }

  syncElement(e, srcTime, speed, playing, fps, tol = 0.2) {
    const el = e.el;
    if (el.readyState < 1) return;
    if (playing && this.rate > 0) {
      const base = clamp(speed * this.rate, 0.0625, 16);
      const drift = el.currentTime - srcTime; // + : öğe ileride
      const now = performance.now();
      // büyük kayma: seyrek ve yalnızca önceki konumlama bittiyse atla (sürekli seek sesi tamamen susturur)
      const hard = Math.max(0.6, tol * this.rate * 3);
      if (Math.abs(drift) > hard && !el.seeking && (!e.lastSeek || now - e.lastSeek > 800)) {
        // konumlama gecikmesini (ölçülen) telafi ederek ileri atla
        if (!e.seekHook) { e.seekHook = true; el.addEventListener('seeked', () => { if (e.seekAt) { e.seekLat = clamp((performance.now() - e.seekAt) / 1000, 0.02, 0.25); e.seekAt = 0; } }); }
        el.currentTime = srcTime + (e.seekLat ?? 0.12) * base;
        e.lastSeek = now; e.seekAt = now;
      }
      // küçük kayma: hızı hafifçe ayarlayarak yakala
      let r = base;
      if (Math.abs(drift) > 0.02 && Math.abs(drift) <= hard) r = base * clamp(1 - drift * 0.5, 0.92, 1.08);
      if (Math.abs(el.playbackRate - r) > 0.002) el.playbackRate = r;
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - srcTime) > 0.5 / fps && !el.seeking) el.currentTime = srcTime + 0.0001;
    }
  }

  // ---------- taşıma ----------
  play(rate = 1) {
    this.ensureAudio();
    this.rate = rate;
    const end = this.endTime();
    if (rate > 0 && store.playhead >= end - EPS) store.setPlayhead(this.startTime());
    if (this.playing) { this._t0 = store.playhead; this._n0 = performance.now(); return; }
    this.playing = true;
    this._t0 = store.playhead;
    this._n0 = performance.now();
    store.emit('transport', true);
    // ön hazırlık (preroll): etkin medya öğeleri konumlanıp hazır olana kadar saati başlatma
    this._prerolling = true;
    try { this.renderAt(store.playhead, false); } finally { this._prerolling = false; }
    const startAt = store.playhead;
    const tStart = performance.now();
    const active = [...this.pool.entries()].filter(([id]) => {
      const c = store.clip(id);
      return c && startAt >= c.start - EPS && startAt < c.start + c.duration;
    }).map(([, e]) => e);
    const go = () => {
      if (!this.playing) return;
      const ready = active.every((e) => e.el.readyState >= 3 && !e.el.seeking);
      if (!ready && performance.now() - tStart < 1500) { this._wait = setTimeout(go, 15); return; }
      this._t0 = store.playhead; this._n0 = performance.now();
      this._raf = requestAnimationFrame(loop);
    };
    const loop = () => {
      if (!this.playing) return;
      let t = this._t0 + ((performance.now() - this._n0) / 1000) * this.rate;
      const endT = this.endTime();
      if (this.rate > 0 && t >= endT) {
        if (this.loop) { this._t0 = this.startTime(); this._n0 = performance.now(); t = this._t0; }
        else { store.setPlayhead(endT); this.pause(); return; }
      }
      if (this.rate < 0 && t <= 0) { store.setPlayhead(0); this.pause(); return; }
      store.playhead = Math.max(0, t);
      store.emit('playhead', store.playhead);
      this.renderAt(store.playhead, this.rate > 0);
      this._raf = requestAnimationFrame(loop);
    };
    go();
  }

  startTime() { const P = store.project; return P.inPoint != null && this.loop ? P.inPoint : 0; }
  endTime() {
    const P = store.project;
    const d = store.duration();
    if (P.outPoint != null && P.outPoint > store.playhead - EPS) return Math.min(P.outPoint, Math.max(d, P.outPoint));
    return d;
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._wait);
    for (const e of this.pool.values()) { e.el.pause(); this.stopBaked(e, true); }
    store.setPlayhead(store.playhead);
    store.emit('transport', false);
    this.requestRender();
  }

  toggle() { this.playing ? this.pause() : this.play(1); }

  shuttle(dir) {
    if (dir === 0) return this.pause();
    if (!this.playing || Math.sign(this.rate) !== dir) return this.play(dir);
    const next = clamp(Math.abs(this.rate) * 2, 1, 8) * dir;
    this.play(next);
  }

  // Kare yakalama (anlık görüntü)
  snapshotBlob() {
    return new Promise((r) => this.canvas.toBlob(r, 'image/png'));
  }
}
