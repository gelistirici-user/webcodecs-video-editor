// Oynatma motoru: video/ses öğe havuzu, saat, ses ölçerleri
import { store } from './store.js';
import { layersAt, drawFrame, audioGain, collectInstances, seqView, MC } from './compositor.js';
import { clamp, EPS } from './utils.js';
import { buildChain, ensureWorklet, afxActive } from './audiofx.js';
import { previewUrl } from './proxy.js';
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
    store.on('proxy', () => { for (const k of [...this.pool.keys()]) this.release(k); this.requestRender(); });
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

  getEntry(key, kind, media) {
    let e = this.pool.get(key);
    const url = previewUrl(media);
    if (e && e.url === url && e.kind === kind) return e;
    if (e) this.release(key);
    if (media.offline || !url) return null;
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.playsInline = true;
    el.preservesPitch = false;
    if (kind === 'video') el.muted = true;
    // her öğeye ayrı adres (aynı sunucu adındaki eşzamanlı istek sınırına takılmasın; ana süreç adı yok sayar)
    el.src = url.startsWith('media://file/') ? url.replace('media://file/', `media://p${(this._elN = (this._elN || 0) + 1)}/`) : url;
    el.addEventListener('seeked', () => { if (!this.playing) this.requestRender(); });
    el.addEventListener('loadeddata', () => { if (!this.playing) this.requestRender(); });
    e = { el, kind, mediaId: media.id, url, gain: null };
    this.pool.set(key, e);
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

  // Görünür ve yakındaki klipler (iç içe sekanslar dahil) için öğeleri hazırla, uzak olanları bırak
  syncPool(insts, mm) {
    const keep = new Set();
    for (const I of insts) {
      const c = I.clip;
      const m = mm.get(c.mediaId);
      if (!m || m.kind === 'image') continue;
      if (I.kind === 'audio' && m.kind !== 'audio' && !m.hasAudio) continue;
      if (I.kind === 'video' && m.kind !== 'video') continue;
      keep.add(I.key);
      const e = this.getEntry(I.key, I.kind, m);
      if (!e) continue;
      // yaklaşan klipleri giriş karesinde beklet
      if (!I.active && e.el.paused && e.el.readyState >= 1) {
        const s0 = srcTimeAt(c, Math.max(c.start, Math.min(I.t, c.start + c.duration)), m);
        if (Math.abs(e.el.currentTime - s0) > 0.05) e.el.currentTime = s0;
      }
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
    const insts = collectInstances(P, t, LOOKAHEAD);
    this.syncPool(insts, mm);
    const fps = P.settings.fps;
    const live = new Set();

    for (const I of insts) {
      const c = I.clip;
      const e = this.pool.get(I.key);
      if (!e || !I.active) continue;
      const m = mm.get(c.mediaId);
      live.add(I.key);
      if (I.kind === 'video') {
        if (c.reverse && playing) {
          // ters oynatma: video öğesi geriye oynayamaz; kareler pencereli çözücüden gelir
          if (!e.el.paused) e.el.pause();
          if (!e.rev) e.rev = new WindowSource(m.url, { maxW: 640, win: 1, keep: 3 });
          e.rev.prefetch(srcTimeAt(c, I.t, m));
        } else this.syncElement(e, srcTimeAt(c, I.t, m), speedAt(c, I.t), playing, fps);
        continue;
      }
      // ses
      const remap = isRemapped(c);
      if (this._prerolling && !remap) { this.syncElement(e, srcTimeAt(c, I.t, m), c.speed, false, fps); continue; }
      if (!playing) { if (!e.el.paused) e.el.pause(); this.stopBaked(e); continue; }
      const g = audioGain(c, I.t) * I.gain * (P.master ?? 1);
      if (e.gain) e.gain.gain.setTargetAtTime(g, this.audioCtx.currentTime, 0.015);
      else e.el.volume = clamp(g, 0, 1);
      this.applyAfx(e, c.afx);
      if (remap) {
        // hız rampası / ters: önceden hesaplanmış ses tamponu çalınır
        if (!e.el.paused) e.el.pause();
        this.playBaked(e, c, m, I.t - c.start);
      } else {
        this.stopBaked(e);
        this.syncElement(e, srcTimeAt(c, I.t, m), c.speed, true, fps, 0.12);
      }
    }
    // etkin olmayan öğeleri durdur
    for (const [key, e] of this.pool) if (!live.has(key)) { if (!e.el.paused) e.el.pause(); this.stopBaked(e); }

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
      const e = this.pool.get(L.poolKey || L.clip.id);
      if (e && e.rev && playing && L.clip.reverse) {
        const fc = e.rev.frameAt(L.srcTime);
        if (fc) return { el: fc, w: fc.width, h: fc.height };
      }
      if (!e || e.el.readyState < 2) return null;
      return { el: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
    });
    if (layers.length === 0 && P.clips.length === 0) this.drawEmpty(W, H);
    if (MC.allAngles) this.drawMulticamGrid(t, mm, playing);
    this.onFrame?.(t, layers);
  }

  // Çok kameralı ızgara: oynatma kafasındaki çok kameralı klibin tüm açıları
  drawMulticamGrid(t, mm, playing) {
    const P = store.project;
    const vts = store.videoTracks();
    let c = null;
    for (let i = vts.length - 1; i >= 0 && !c; i--) c = P.clips.find((x) => x.trackId === vts[i].id && x.multicam && t >= x.start - EPS && t < x.start + x.duration - EPS) || null;
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    this.mcLayout = null;
    if (!c) return;
    const all = seqView(P, c, 'video', true);
    if (!all) return;
    const angles = all.tracks.filter((x) => x.kind === 'video');
    const n = angles.length, cols = n <= 1 ? 1 : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols);
    const tw = W / cols, th = H / rows;
    const ti = srcTimeAt(c, t);
    if (!this.tile || this.tile.width !== Math.round(tw) || this.tile.height !== Math.round(th)) { this.tile = document.createElement('canvas'); this.tile.width = Math.round(tw); this.tile.height = Math.round(th); }
    const tctx = this.tile.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    angles.forEach((tr, i) => {
      const view = { ...all, tracks: [tr], clips: all.clips.filter((k) => k.trackId === tr.id) };
      const pk = c.id + '/';
      const layers = layersAt(view, ti, mm).map((L) => (L.clip ? { ...L, poolKey: pk + L.clip.id } : L));
      drawFrame(tctx, this.tile.width, this.tile.height, view, ti, layers, (L) => {
        const m = mm.get(L.clip.mediaId);
        const e = this.pool.get(L.poolKey);
        if (!m || !e || e.el.readyState < 2) return null;
        return { el: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
      });
      const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
      ctx.drawImage(this.tile, x, y, tw, th);
      const on = (c.angle || 0) === i;
      ctx.lineWidth = on ? Math.max(3, W / 300) : 1;
      ctx.strokeStyle = on ? (playing ? '#ff3b3b' : '#ffd34d') : 'rgba(255,255,255,0.25)';
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, tw - ctx.lineWidth, th - ctx.lineWidth);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const fs = Math.max(11, Math.round(H / 28));
      ctx.font = `600 ${fs}px "Segoe UI", sans-serif`;
      const label = `${i + 1}  ${tr.name}`;
      ctx.fillRect(x + 6, y + 6, ctx.measureText(label).width + 12, fs + 8);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.fillText(label, x + 12, y + 10);
    });
    ctx.restore();
    this.mcLayout = { cols, rows, n };
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
    const active = collectInstances(store.project, startAt, 0).filter((I) => I.active).map((I) => this.pool.get(I.key)).filter(Boolean);
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
