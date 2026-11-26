// Zaman çizelgesi: çizim + etkileşim (seç, taşı, kırp, böl, sürükle-bırak, geçiş, fade tutamaçları)
import { store, makeClip } from './store.js';
import { thumbAt } from './media.js';
import { clamp, formatTC, EPS, uid, h } from './utils.js';
import { icon, contextMenu, toast, promptDialog } from './ui.js';
import { TRANSITIONS, COLOR_PRESETS, ANIMATIONS } from './compositor.js';
import { kfTimes, hasKf } from './keyframes.js';
import { srcTimeAt } from './timemap.js';

export const drag = { payload: null }; // panelden sürüklenen öğe
const RULER_H = 30;
const ROW_H = { video: 62, audio: 54 };
const EDGE = 7;
const COLORS = {
  video: ['#3b63c4', '#5b84e8'], audio: ['#22805a', '#39b07d'], image: ['#7a4fc0', '#9c74e0'],
  text: ['#b86f1e', '#e09a46'], color: ['#a8406f', '#d06495'], offline: ['#7a2b2b', '#a33'],
};

export class Timeline {
  constructor(root, player) {
    this.root = root;
    this.player = player;
    this.pps = 40;
    this.tool = 'select';
    this.snapping = true;
    this.linked = true;
    this.headers = root.querySelector('.tl-headers-inner');
    this.scroller = root.querySelector('.tl-scroll');
    this.spacer = root.querySelector('.tl-spacer');
    this.canvas = root.querySelector('.tl-canvas');
    this.ruler = root.querySelector('.tl-ruler');
    this.ctx = this.canvas.getContext('2d');
    this.rctx = this.ruler.getContext('2d');
    this.op = null;
    this.hover = null;
    this.snapLine = null;
    this.ghost = null;
    this._queued = false;
    this.bind();
    store.on('change', (d) => { if (!d?.live) this.buildHeaders(); this.request(); });
    store.on('selection', () => this.request());
    store.on('playhead', () => { this.followPlayhead(); this.request(); });
    store.on('media-cache', () => this.request());
    store.on('load', () => { this.scroller.scrollLeft = 0; this.zoomToFit(); });
    this._availH = this.scroller.clientHeight;
    new ResizeObserver(() => {
      const hh = this.scroller.clientHeight;
      if (Math.abs(hh - this._availH) > 2) { this._availH = hh; this.buildHeaders(); }
      this.request();
    }).observe(this.scroller);
    this.buildHeaders();
  }

  // ---------- düzen ----------
  rows() {
    const P = store.project;
    const v = P.tracks.filter((t) => t.kind === 'video').reverse();
    const a = P.tracks.filter((t) => t.kind === 'audio');
    const out = [];
    // Küçük ekranlarda izleri sığacak kadar daralt (alt sınır: okunabilir yükseklik)
    const full = v.length * ROW_H.video + 6 + a.length * ROW_H.audio;
    const k = this._availH ? clamp((this._availH - 14) / full, 0.62, 1) : 1;
    const vh = Math.round(ROW_H.video * k), ah = Math.round(ROW_H.audio * k);
    let y = 0;
    for (const t of v) { out.push({ track: t, y, h: vh }); y += vh; }
    y += 6; // video/ses ayırıcı
    for (const t of a) { out.push({ track: t, y, h: ah }); y += ah; }
    this._splitY = v.length * vh;
    return out;
  }
  rowAt(y) { return this.rows().find((r) => y >= r.y && y < r.y + r.h) || null; }
  rowOf(trackId) { return this.rows().find((r) => r.track.id === trackId); }
  t2x(t) { return t * this.pps - this.scroller.scrollLeft; }
  x2t(x) { return Math.max(0, (x + this.scroller.scrollLeft) / this.pps); }
  local(e) {
    const r = this.scroller.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top + this.scroller.scrollTop };
  }

  request() {
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => { this._queued = false; this.draw(); });
  }

  setZoom(pps, anchorX = null) {
    const old = this.pps;
    pps = clamp(pps, 2, 600);
    if (Math.abs(pps - old) < 1e-6) return;
    const ax = anchorX ?? this.t2x(store.playhead);
    const tAnchor = (ax + this.scroller.scrollLeft) / old;
    this.pps = pps;
    this.updateSpacer();
    this.scroller.scrollLeft = Math.max(0, tAnchor * pps - ax);
    this.request();
    store.emit('zoom', pps);
  }
  zoomToFit() {
    const w = this.scroller.clientWidth - 40;
    const d = Math.max(store.duration(), 10);
    this.setZoom(w / d, 0);
    this.scroller.scrollLeft = 0;
  }
  updateSpacer() {
    const d = Math.max(store.duration() + 30, this.scroller.clientWidth / this.pps + 5);
    const rows = this.rows();
    const last = rows[rows.length - 1];
    this.spacer.style.width = Math.ceil(d * this.pps) + 'px';
    this.spacer.style.height = (last ? last.y + last.h + 40 : 200) + 'px';
  }

  followPlayhead() {
    if (!this.player.playing || this.op) return;
    const x = this.t2x(store.playhead);
    const w = this.scroller.clientWidth;
    if (x > w - 30 || x < 0) this.scroller.scrollLeft += x - 40;
  }

  // ---------- iz başlıkları ----------
  buildHeaders() {
    const rows = this.rows();
    this.headers.innerHTML = '';
    for (const r of rows) {
      const t = r.track;
      const isV = t.kind === 'video';
      const el = h('div', { class: `tl-head ${t.kind}${t.locked ? ' locked' : ''}`, style: { top: r.y + 'px', height: r.h + 'px' } });
      const name = h('span', { class: 'tl-name', title: 'Yeniden adlandırmak için çift tıklayın' }, t.name);
      name.ondblclick = async () => {
        const n = await promptDialog('İzi yeniden adlandır', 'İz adı', t.name);
        if (n) store.transact('İz adı', () => { store.track(t.id).name = n.slice(0, 24); });
      };
      const btn = (ic, title, active, fn, cls = '') => {
        const b = h('button', { class: `tl-hbtn ${active ? 'on' : ''} ${cls}`, title, 'aria-label': title, 'aria-pressed': String(!!active), html: typeof ic === 'string' && ic.length < 12 ? icon(ic, 15) : ic });
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
      };
      const toggles = h('div', { class: 'tl-hbtns' });
      if (isV) toggles.append(btn(t.hidden ? 'eyeOff' : 'eye', t.hidden ? 'İzi göster' : 'İzi gizle', t.hidden, () => store.transact('İz görünürlüğü', () => { store.track(t.id).hidden = !t.hidden; })));
      else {
        toggles.append(btn(t.muted ? 'mute' : 'speaker', t.muted ? 'Sesi aç' : 'Sessize al (M)', t.muted, () => store.transact('İz sesi', () => { store.track(t.id).muted = !t.muted; })));
        toggles.append(btn('<b>S</b>', 'Solo', t.solo, () => store.transact('Solo', () => { store.track(t.id).solo = !t.solo; }), 'solo'));
      }
      toggles.append(btn(t.locked ? 'lock' : 'unlock', t.locked ? 'Kilidi aç' : 'İzi kilitle', t.locked, () => store.transact('İz kilidi', () => { store.track(t.id).locked = !t.locked; })));
      el.append(h('span', { class: 'tl-kind', html: icon(isV ? 'film' : 'music', 13) }), name, toggles);
      el.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Video izi ekle', action: () => store.transact('İz ekle', () => store.addTrack('video')) },
          { label: 'Ses izi ekle', action: () => store.transact('İz ekle', () => store.addTrack('audio')) },
          '-',
          { label: `"${t.name}" izini sil`, danger: true, action: () => store.transact('İz sil', () => { if (!store.removeTrack(t.id)) toast('Her türden en az bir iz kalmalı', 'warn'); }) },
        ]);
      };
      this.headers.append(el);
    }
    const sep = h('div', { class: 'tl-head-sep', style: { top: this._splitY + 'px' } });
    this.headers.append(sep);
    const last = rows[rows.length - 1];
    const add = h('div', { class: 'tl-addtracks', style: { top: (last.y + last.h + 6) + 'px' } });
    const b1 = h('button', { class: 'chip', title: 'Video izi ekle', html: icon('plus', 13) + ' Video' });
    b1.onclick = () => store.transact('İz ekle', () => store.addTrack('video'));
    const b2 = h('button', { class: 'chip', title: 'Ses izi ekle', html: icon('plus', 13) + ' Ses' });
    b2.onclick = () => store.transact('İz ekle', () => store.addTrack('audio'));
    add.append(b1, b2);
    this.headers.append(add);
    this.updateSpacer();
  }

  // ---------- çizim ----------
  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.scroller.clientWidth, H = this.scroller.clientHeight;
    for (const [cv, w, hh] of [[this.canvas, W, H], [this.ruler, W, RULER_H]]) {
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
        cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
        cv.style.width = w + 'px'; cv.style.height = hh + 'px';
      }
    }
    this.canvas.style.transform = `translate(${this.scroller.scrollLeft}px, ${this.scroller.scrollTop}px)`;
    this.headers.style.transform = `translateY(${-this.scroller.scrollTop}px)`;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const sy = this.scroller.scrollTop;
    const P = store.project;
    const rows = this.rows();
    const t0 = this.x2t(0), t1 = this.x2t(W);

    // izler
    for (const r of rows) {
      const y = r.y - sy;
      if (y > H || y + r.h < 0) continue;
      ctx.fillStyle = r.track.kind === 'video' ? '#1b1e24' : '#191c21';
      ctx.fillRect(0, y, W, r.h);
      if (r.track.locked) {
        ctx.save(); ctx.beginPath(); ctx.rect(0, y, W, r.h); ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 6;
        for (let x = -H; x < W + H; x += 18) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + r.h, y + r.h); ctx.stroke(); }
        ctx.restore();
      }
      ctx.fillStyle = '#0f1115';
      ctx.fillRect(0, y + r.h - 1, W, 1);
    }
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, this._splitY - sy, W, 6);

    // giriş/çıkış aralığı
    if (P.inPoint != null || P.outPoint != null) {
      const a = this.t2x(P.inPoint ?? 0), b = this.t2x(P.outPoint ?? store.duration());
      ctx.fillStyle = 'rgba(80,140,255,0.06)';
      ctx.fillRect(a, 0, b - a, H);
    }

    // klipler
    const mm = new Map(P.media.map((m) => [m.id, m]));
    for (const c of P.clips) {
      if (c.start > t1 || c.start + c.duration < t0) continue;
      const r = rows.find((x) => x.track.id === c.trackId);
      if (!r) continue;
      this.drawClip(ctx, c, r, sy, mm, W);
    }

    if (!P.clips.length && !this.ghost) {
      ctx.fillStyle = '#4a505c';
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Medya panelinden klipleri buraya sürükleyin  ·  Dosyaları doğrudan da bırakabilirsiniz', W / 2, Math.min(H / 2, this._splitY - sy + 20));
      ctx.textAlign = 'left';
    }

    // sürükleme hayaleti
    if (this.ghost) {
      for (const g of this.ghost.items) {
        const r = this.rowOf(g.trackId);
        if (!r) continue;
        const x = this.t2x(g.start), w = g.duration * this.pps;
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.strokeStyle = '#ffd34d';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.roundRect(x + 0.5, r.y - sy + 3.5, Math.max(4, w - 1), r.h - 7, 5); ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (this.ghost.cut) {
        const r = this.rowOf(this.ghost.cut.trackId);
        const x = this.t2x(this.ghost.cut.t);
        ctx.fillStyle = 'rgba(255,211,77,0.35)';
        ctx.fillRect(x - 12, r.y - sy + 2, 24, r.h - 4);
      }
      if (this.ghost.clipId) {
        const c = store.clip(this.ghost.clipId);
        const r = c && this.rowOf(c.trackId);
        if (r) { ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 2; ctx.strokeRect(this.t2x(c.start) + 1, r.y - sy + 3, c.duration * this.pps - 2, r.h - 6); }
      }
    }

    // seçim kutusu
    if (this.op?.type === 'marquee' && this.op.moved) {
      const { x0, y0, x1, y1 } = this.op;
      ctx.fillStyle = 'rgba(90,150,255,0.12)';
      ctx.strokeStyle = 'rgba(120,170,255,0.8)';
      ctx.lineWidth = 1;
      const x = Math.min(x0, x1) - this.scroller.scrollLeft, y = Math.min(y0, y1) - sy;
      ctx.fillRect(x, y, Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }

    // işaretçi çizgileri
    for (const m of P.markers) {
      const x = this.t2x(m.t);
      if (x < -2 || x > W + 2) continue;
      ctx.fillStyle = (m.color || '#4fc3f7') + '55';
      ctx.fillRect(Math.round(x), 0, 1, H);
    }

    // jilet önizlemesi
    if (this.tool === 'razor' && this.hover?.clip && !this.op) {
      const x = this.t2x(this.hover.t);
      const r = this.rowOf(this.hover.clip.trackId);
      ctx.fillStyle = '#ff5a5a';
      ctx.fillRect(Math.round(x), r.y - sy, 1.5, r.h);
    }

    // yakalama çizgisi
    if (this.snapLine != null) {
      const x = this.t2x(this.snapLine);
      ctx.fillStyle = '#ffd34d';
      ctx.fillRect(Math.round(x), 0, 1, H);
    }

    // oynatma kafası
    const px = Math.round(this.t2x(store.playhead)) + 0.5;
    ctx.fillStyle = '#ff4d4d';
    ctx.fillRect(px - 0.5, 0, 1.5, H);

    this.drawRuler(W);
  }

  drawClip(ctx, c, r, sy, mm, W) {
    const m = c.type === 'media' ? mm.get(c.mediaId) : null;
    const isAudio = r.track.kind === 'audio';
    const kind = c.type === 'media' ? (m?.offline || !m ? 'offline' : isAudio ? 'audio' : m.kind) : c.type;
    const [base, light] = COLORS[kind] || COLORS.video;
    const x = this.t2x(c.start), w = Math.max(2, c.duration * this.pps);
    const y = r.y - sy + 2, hh = r.h - 4;
    const sel = store.selection.has(c.id);
    const lockedTrack = r.track.locked;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y, w - 1, hh, 4);
    ctx.clip();
    ctx.fillStyle = base;
    ctx.globalAlpha = (r.track.hidden || r.track.muted || c.muted) ? 0.45 : 1;
    ctx.fillRect(x, y, w, hh);
    // başlık şeridi
    ctx.fillStyle = light;
    ctx.fillRect(x, y, w, 15);
    const bodyY = y + 15, bodyH = hh - 15;

    // içerik
    if (kind === 'video' || kind === 'image') {
      const th = bodyH;
      const cache = store.mediaCache.get(c.mediaId);
      const sample = cache?.poster;
      if (sample) {
        const tw = Math.max(20, th * (sample.width / sample.height));
        const startX = Math.max(x, -tw);
        const firstI = Math.floor((startX - x) / tw);
        for (let i = firstI; x + i * tw < Math.min(x + w, W); i++) {
          const tx = x + i * tw;
          const mt = srcTimeAt(c, c.start + (i * tw + tw / 2) / this.pps);
          const img = kind === 'image' ? sample : thumbAt(c.mediaId, mt);
          if (img) ctx.drawImage(img, tx, bodyY, tw, th);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(x, bodyY, w, bodyH);
      }
    } else if (kind === 'audio') {
      const cache = store.mediaCache.get(c.mediaId);
      if (cache?.peaks) {
        const { peaks, peaksRate } = cache;
        const mid = bodyY + bodyH / 2;
        ctx.fillStyle = 'rgba(200,255,225,0.75)';
        const xs = Math.max(x, 0), xe = Math.min(x + w, W);
        for (let px = Math.floor(xs); px < xe; px += 1) {
          let tt = srcTimeAt(c, c.start + (px - x) / this.pps);
          let tt2 = srcTimeAt(c, c.start + (px + 1 - x) / this.pps);
          if (tt2 < tt) [tt, tt2] = [tt2, tt];
          let mx = 0;
          for (let k = Math.floor(tt * peaksRate); k <= Math.floor(tt2 * peaksRate); k++) if (peaks[k] > mx) mx = peaks[k];
          const a = Math.min(1, mx * c.volume) * (bodyH / 2 - 2);
          ctx.fillRect(px, mid - a, 1, a * 2 || 1);
        }
      }
      // ses seviyesi çizgisi
      const vy = bodyY + bodyH * (1 - clamp(c.volume / 2, 0, 1));
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x, Math.round(vy), w, 1);
    } else if (kind === 'text') {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '600 12px "Segoe UI", sans-serif';
      ctx.fillText('T  ' + (c.text.content.split('\n')[0] || '').slice(0, 60), x + 8, bodyY + bodyH / 2 + 4);
    } else if (kind === 'color') {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, c.fill); g.addColorStop(1, c.gradient ? c.fill2 : c.fill);
      ctx.fillStyle = g;
      ctx.fillRect(x + 4, bodyY + 4, w - 8, bodyH - 8);
    } else if (kind === 'offline') {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '600 11px "Segoe UI", sans-serif';
      ctx.fillText('Medya bulunamadı', x + 8, bodyY + bodyH / 2 + 4);
    }

    // fade üçgenleri
    const fi = isAudio ? c.audioFadeIn : c.fadeIn, fo = isAudio ? c.audioFadeOut : c.fadeOut;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (fi > 0) { ctx.beginPath(); ctx.moveTo(x, bodyY); ctx.lineTo(x + fi * this.pps, bodyY); ctx.lineTo(x, y + hh); ctx.fill(); }
    if (fo > 0) { ctx.beginPath(); ctx.moveTo(x + w, bodyY); ctx.lineTo(x + w - fo * this.pps, bodyY); ctx.lineTo(x + w, y + hh); ctx.fill(); }

    // geçiş
    if (c.transitionIn && !isAudio) {
      const d = c.transitionIn.duration * this.pps;
      const prev = store.clipsOn(c.trackId).find((k) => Math.abs(k.start + k.duration - c.start) < 1e-3);
      const tx = prev ? x - d / 2 : x;
      ctx.restore(); ctx.save();
      ctx.beginPath(); ctx.roundRect(tx, y + 15, d, hh - 15, 3); ctx.clip();
      ctx.fillStyle = 'rgba(20,20,30,0.75)'; ctx.fillRect(tx, y, d, hh);
      ctx.strokeStyle = 'rgba(255,211,77,0.7)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(tx, y + hh); ctx.lineTo(tx + d, y + 15); ctx.moveTo(tx, y + 15); ctx.lineTo(tx + d, y + hh); ctx.stroke();
      ctx.restore(); ctx.save();
      ctx.beginPath(); ctx.roundRect(x + 0.5, y, w - 1, hh, 4); ctx.clip();
    }

    // etiket
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.font = '600 11px "Segoe UI", sans-serif';
    let label = c.type === 'text' ? 'Metin' : c.type === 'color' ? 'Renk' : (m?.name || 'Medya');
    const badges = [];
    if (c.reverse) badges.push('◀');
    if (hasKf(c, 'speed')) badges.push('rampa');
    else if (c.speed !== 1) badges.push(`${Math.round(c.speed * 100)}%`);
    if (!isAudio && (c.color.preset !== 'none' || c.color.brightness || c.color.contrast || c.color.saturation || c.color.temperature)) badges.push('fx');
    if (c.linkId) badges.push('🔗');
    if (badges.length) label = badges.join(' ') + '  ' + label;
    ctx.fillText(label, Math.max(x, 0) + 6, y + 11.5);
    ctx.restore();

    // kenarlık
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeStyle = sel ? '#ffffff' : 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.roundRect(x + (sel ? 1 : 0.5), y + (sel ? 1 : 0.5), w - (sel ? 2 : 1), hh - (sel ? 2 : 1), 4);
    ctx.stroke();
    if (lockedTrack) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x, y, w, hh); }
    // anahtar kareler (klibin altında elmaslar)
    if (c.kf) {
      const ky = y + hh - 6;
      ctx.lineWidth = 1;
      for (const tt of kfTimes(c)) {
        const kx = Math.round(this.t2x(tt)) + 0.5;
        ctx.beginPath(); ctx.moveTo(kx, ky - 4); ctx.lineTo(kx + 4, ky); ctx.lineTo(kx, ky + 4); ctx.lineTo(kx - 4, ky); ctx.closePath();
        ctx.fillStyle = sel ? '#ffd34d' : 'rgba(255,211,77,0.55)'; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
      }
    }

    // fade tutamaçları (üzerine gelince)
    if (this.hover?.clip?.id === c.id && !this.op && this.tool === 'select' && w > 30) {
      ctx.fillStyle = '#fff';
      for (const hx of [x + fi * this.pps, x + w - fo * this.pps]) {
        ctx.beginPath(); ctx.arc(clamp(hx, x + 5, x + w - 5), y + 7.5, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  drawRuler(W) {
    const ctx = this.rctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, W, RULER_H);
    const fps = store.fps;
    // uygun aralık seçimi
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    let major = steps.find((s) => s * this.pps >= 80) || 3600;
    const minorDiv = major >= 1 ? (major % 5 === 0 ? 5 : 4) : 5;
    const t0 = this.x2t(0), t1 = this.x2t(W);
    ctx.fillStyle = '#5b6170';
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    const minor = major / minorDiv;
    for (let t = Math.floor(t0 / minor) * minor; t <= t1 + minor; t += minor) {
      const x = Math.round(this.t2x(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.fillRect(x, isMajor ? 12 : 21, 1, isMajor ? RULER_H - 12 : RULER_H - 21);
      if (isMajor) {
        ctx.fillStyle = '#9aa0ad';
        const label = major < 1 ? formatTC(t, fps).slice(3) : formatTC(t, fps).slice(0, 8);
        ctx.fillText(label, x + 4, 2);
        ctx.fillStyle = '#5b6170';
      }
    }
    const P = store.project;
    // giriş/çıkış
    if (P.inPoint != null || P.outPoint != null) {
      const a = this.t2x(P.inPoint ?? 0), b = this.t2x(P.outPoint ?? store.duration());
      ctx.fillStyle = 'rgba(80,140,255,0.35)';
      ctx.fillRect(a, RULER_H - 6, b - a, 6);
    }
    // işaretçiler
    for (const m of P.markers) {
      const x = this.t2x(m.t);
      ctx.fillStyle = m.color || '#4fc3f7';
      ctx.beginPath(); ctx.moveTo(x - 5, 12); ctx.lineTo(x + 5, 12); ctx.lineTo(x + 5, 20); ctx.lineTo(x, 25); ctx.lineTo(x - 5, 20); ctx.fill();
    }
    // oynatma kafası
    const px = Math.round(this.t2x(store.playhead));
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath(); ctx.moveTo(px - 6, RULER_H - 12); ctx.lineTo(px + 7, RULER_H - 12); ctx.lineTo(px + 7, RULER_H - 6); ctx.lineTo(px + 0.5, RULER_H); ctx.lineTo(px - 6, RULER_H - 6); ctx.fill();
    ctx.fillStyle = '#0d0e11';
    ctx.fillRect(0, RULER_H - 1, W, 1);
  }

  // ---------- isabet ----------
  hit(e) {
    const p = this.local(e);
    const row = this.rowAt(p.y);
    const t = this.x2t(p.x - this.scroller.scrollLeft + this.scroller.scrollLeft);
    const res = { x: p.x, y: p.y, t: this.x2t(p.x), row, clip: null, edge: null, fade: null };
    if (!row) return res;
    const clips = store.clipsOn(row.track.id);
    const tt = res.t;
    for (const c of clips) {
      const x0 = c.start * this.pps, x1 = (c.start + c.duration) * this.pps;
      const ax = p.x + this.scroller.scrollLeft;
      if (ax >= x0 - EDGE && ax <= x1 + EDGE) {
        const inside = ax >= x0 && ax <= x1;
        const w = x1 - x0;
        const nearL = Math.abs(ax - x0) <= Math.min(EDGE, w / 3), nearR = Math.abs(ax - x1) <= Math.min(EDGE, w / 3);
        if (!inside && !nearL && !nearR) continue;
        // fade tutamağı: yalnızca başlık şeridinde (altındaki kenar bölgesi kırpma içindir)
        const relY = p.y - row.y;
        const isAudio = row.track.kind === 'audio';
        const fi = isAudio ? c.audioFadeIn : c.fadeIn, fo = isAudio ? c.audioFadeOut : c.fadeOut;
        if (relY >= 1 && relY <= 17 && w > 30) {
          const hx1 = clamp(x0 + fi * this.pps, x0 + 5, x1 - 5), hx2 = clamp(x1 - fo * this.pps, x0 + 5, x1 - 5);
          if (Math.abs(ax - hx1) <= 6) { res.clip = c; res.fade = 'in'; return res; }
          if (Math.abs(ax - hx2) <= 6) { res.clip = c; res.fade = 'out'; return res; }
        }
        res.clip = c;
        if (nearL) res.edge = 'left'; else if (nearR) res.edge = 'right';
        // aynı noktada iki klip varsa: kenar tercihi sağdakine
        if (nearR) {
          const next = clips.find((k) => k !== c && Math.abs(k.start - (c.start + c.duration)) < 1e-3);
          if (next && ax > x1 - 1) { res.clip = next; res.edge = 'left'; }
        }
        return res;
      }
    }
    void t; void tt;
    return res;
  }

  snapTargets(excludeIds) {
    const P = store.project;
    const out = [0, store.playhead];
    for (const c of P.clips) { if (excludeIds.has(c.id)) continue; out.push(c.start, c.start + c.duration); }
    for (const m of P.markers) out.push(m.t);
    if (P.inPoint != null) out.push(P.inPoint);
    if (P.outPoint != null) out.push(P.outPoint);
    return out;
  }
  // verilen kenar zamanları için en yakın yakalama düzeltmesi
  snapDelta(edges, excludeIds, force = false) {
    if (!this.snapping && !force) return { d: 0, at: null };
    const thr = 9 / this.pps;
    let best = { d: 0, at: null, dist: thr };
    const targets = this.snapTargets(excludeIds);
    for (const e of edges) for (const t of targets) {
      const dist = Math.abs(t - e);
      if (dist < best.dist) best = { d: t - e, at: t, dist };
    }
    return best;
  }

  // ---------- olaylar ----------
  bind() {
    const sc = this.scroller;
    sc.addEventListener('scroll', () => this.request());
    sc.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.altKey) {
        e.preventDefault();
        const r = sc.getBoundingClientRect();
        this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left);
      } else if (e.shiftKey) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    this.ruler.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.ruler.getBoundingClientRect();
      if (e.ctrlKey || e.altKey) this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left);
      else sc.scrollLeft += e.deltaY + e.deltaX;
    }, { passive: false });

    // cetvel: oynatma kafası sürükleme
    this.ruler.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.player.pause();
      this.ruler.setPointerCapture(e.pointerId);
      const set = (ev) => {
        const r = this.ruler.getBoundingClientRect();
        let t = this.x2t(ev.clientX - r.left);
        if (this.snapping && !ev.shiftKey) {
          const s = this.snapDelta([t], new Set(), false);
          if (s.at != null && s.at !== store.playhead) t = s.at;
        }
        store.setPlayhead(t);
      };
      set(e);
      const mv = (ev) => set(ev);
      const up = () => { this.ruler.removeEventListener('pointermove', mv); this.ruler.removeEventListener('pointerup', up); };
      this.ruler.addEventListener('pointermove', mv);
      this.ruler.addEventListener('pointerup', up);
    });
    this.ruler.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = this.ruler.getBoundingClientRect();
      const t = this.x2t(e.clientX - r.left);
      const near = store.project.markers.find((m) => Math.abs(m.t - t) * this.pps < 7);
      contextMenu(e.clientX, e.clientY, [
        { label: 'Buraya işaretçi ekle', action: () => store.transact('İşaretçi', (P) => P.markers.push({ id: uid('mk'), t: Math.round(t * store.fps) / store.fps, color: '#4fc3f7', label: '' })) },
        near && { label: 'İşaretçiyi yeniden adlandır', action: async () => { const n = await promptDialog('İşaretçi', 'Not', near.label || ''); if (n != null) store.transact('İşaretçi', () => { store.project.markers.find((m) => m.id === near.id).label = n; }); } },
        near && { label: 'İşaretçiyi sil', danger: true, action: () => store.transact('İşaretçi sil', (P) => { P.markers = P.markers.filter((m) => m.id !== near.id); }) },
        '-',
        { label: 'Giriş/Çıkış noktalarını temizle', disabled: store.project.inPoint == null && store.project.outPoint == null, action: () => store.transact('Giriş/Çıkış', (P) => { P.inPoint = null; P.outPoint = null; }) },
      ]);
    });
    this.ruler.addEventListener('mousemove', (e) => {
      const r = this.ruler.getBoundingClientRect();
      const t = this.x2t(e.clientX - r.left);
      const near = store.project.markers.find((m) => Math.abs(m.t - t) * this.pps < 7);
      this.ruler.title = near ? (near.label || 'İşaretçi') + ' — ' + formatTC(near.t, store.fps) : '';
    });

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => { if (!this.op) { this.hover = null; this.request(); } });
    this.canvas.addEventListener('dblclick', (e) => {
      const hit = this.hit(e);
      if (hit.clip) store.emit('focus-inspector', hit.clip.id);
    });
    this.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onContext(e); });

    // sürükle-bırak
    sc.addEventListener('dragover', (e) => this.onDragOver(e));
    sc.addEventListener('dragleave', (e) => { if (!sc.contains(e.relatedTarget)) { this.ghost = null; this.request(); } });
    sc.addEventListener('drop', (e) => this.onDrop(e));
  }

  cursorFor(hit, e) {
    if (this.tool === 'razor') return hit.clip ? 'crosshair' : 'default';
    if (hit.fade) return 'ew-resize';
    if (hit.edge) return hit.edge === 'left' ? 'w-resize' : 'e-resize';
    if (hit.clip) return e.altKey ? 'copy' : 'grab';
    return 'default';
  }

  onMove(e) {
    if (this.op) return this.onDrag(e);
    const hit = this.hit(e);
    const prev = this.hover;
    this.hover = hit;
    this.canvas.style.cursor = this.cursorFor(hit, e);
    if (this.tool === 'razor' && hit.clip && this.snapping && !e.shiftKey) {
      const s = this.snapDelta([hit.t], new Set([hit.clip.id]));
      if (s.at != null) hit.t = s.at;
    }
    if (prev?.clip?.id !== hit.clip?.id || this.tool === 'razor') this.request();
  }

  onDown(e) {
    if (e.button === 1) { // orta tuş: kaydırarak gez
      e.preventDefault();
      this.op = { type: 'pan', x: e.clientX, y: e.clientY, sl: this.scroller.scrollLeft, st: this.scroller.scrollTop };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const hit = this.hit(e);
    this.canvas.setPointerCapture(e.pointerId);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const clip = hit.clip;

    if (clip && store.track(clip.trackId).locked) { toast('İz kilitli', 'warn'); return; }

    if (clip && this.tool === 'razor') {
      let t = hit.t;
      if (this.snapping && !e.shiftKey) { const s = this.snapDelta([t], new Set([clip.id])); if (s.at != null) t = s.at; }
      t = Math.round(t * store.fps) / store.fps;
      store.transact('Böl', () => { this.linked && !e.altKey ? store.splitAt([clip], t) : store.splitClip(clip, t); });
      return;
    }

    if (clip && hit.fade) {
      store.begin();
      this.op = { type: 'fade', clip, which: hit.fade, audio: store.track(clip.trackId).kind === 'audio' };
      return;
    }

    if (clip) {
      const group = this.linked && !e.altKey ? store.linked(clip) : [clip];
      const ids = group.map((c) => c.id);
      if (additive) store.select(ids, store.selection.has(clip.id) ? 'toggle' : 'add');
      else if (!store.selection.has(clip.id)) store.select(ids);
    }

    if (clip && hit.edge) {
      store.begin();
      const edge = hit.edge;
      const edgeT = edge === 'left' ? clip.start : clip.start + clip.duration;
      const partners = (this.linked && !e.altKey ? store.linked(clip) : [clip]).filter((c) => Math.abs((edge === 'left' ? c.start : c.start + c.duration) - edgeT) < 1e-3);
      this.op = { type: 'trim', edge, clip, partners, orig: partners.map((c) => ({ ...c })), x0: hit.x };
      return;
    }

    if (clip) {
      const moving = store.selectedClips().filter((c) => !store.track(c.trackId).locked);
      store.begin();
      this.op = {
        type: 'move', x0: hit.x, y0: hit.y, clip, moved: false, dup: e.altKey,
        items: moving.map((c) => ({ c, start: c.start, trackId: c.trackId })),
        rowIdx: this.kindIndex(clip.trackId),
      };
      return;
    }

    // boş alan: seçim kutusu / oynatma kafası
    if (!additive) store.select([]);
    this.op = { type: 'marquee', x0: hit.x + this.scroller.scrollLeft, y0: hit.y, x1: hit.x + this.scroller.scrollLeft, y1: hit.y, moved: false, base: additive ? new Set(store.selection) : new Set(), t: hit.t, gapRow: hit.row };
  }

  kindIndex(trackId) {
    const t = store.track(trackId);
    const list = t.kind === 'video' ? store.videoTracks() : store.audioTracks();
    return { kind: t.kind, i: list.indexOf(t) };
  }

  onDrag(e) {
    const op = this.op;
    if (op.type === 'pan') {
      this.scroller.scrollLeft = op.sl - (e.clientX - op.x);
      this.scroller.scrollTop = op.st - (e.clientY - op.y);
      return;
    }
    const hit = this.hit(e);
    this.autoScroll(e);
    if (op.type === 'fade') {
      const c = op.clip;
      let v = op.which === 'in' ? hit.t - c.start : c.start + c.duration - hit.t;
      v = clamp(Math.round(v * store.fps) / store.fps, 0, c.duration / (op.audio ? 1 : 1));
      const key = op.audio ? (op.which === 'in' ? 'audioFadeIn' : 'audioFadeOut') : (op.which === 'in' ? 'fadeIn' : 'fadeOut');
      c[key] = v;
      store.emit('change', { live: true });
      this.tooltip(e, `${op.which === 'in' ? 'Açılış (fade-in)' : 'Kararma (fade-out)'}: ${v.toFixed(2)} sn`);
      return;
    }
    if (op.type === 'trim') {
      let t = hit.t;
      const excl = new Set(op.partners.map((c) => c.id));
      this.snapLine = null;
      if (!e.shiftKey) { const s = this.snapDelta([t], excl); if (s.at != null) { t = s.at; this.snapLine = s.at; } }
      t = Math.round(t * store.fps) / store.fps;
      op.partners.forEach((c, i) => store.trimClip(c, op.edge, t, op.orig[i]));
      const c = op.clip;
      store.emit('change', { live: true });
      this.tooltip(e, `${op.edge === 'left' ? 'Başlangıç' : 'Bitiş'}: ${formatTC(op.edge === 'left' ? c.start : c.start + c.duration, store.fps)}  ·  Süre ${formatTC(c.duration, store.fps)}`);
      return;
    }
    if (op.type === 'move') {
      const dx = hit.x - op.x0;
      if (!op.moved && Math.abs(dx) < 4 && Math.abs(hit.y - op.y0) < 4) return;
      if (!op.moved) {
        op.moved = true;
        if (op.dup) {
          // Alt+sürükle: kopyasını taşı
          const relink = new Map();
          op.items = op.items.map((it) => {
            const copy = JSON.parse(JSON.stringify(it.c));
            copy.id = uid('c');
            if (copy.linkId) { if (!relink.has(copy.linkId)) relink.set(copy.linkId, uid('l')); copy.linkId = relink.get(copy.linkId); }
            store.project.clips.push(copy);
            return { c: copy, start: it.start, trackId: it.trackId };
          });
          store.select(op.items.map((i) => i.c.id));
        }
      }
      let dt = dx / this.pps;
      const minStart = Math.min(...op.items.map((i) => i.start));
      dt = Math.max(dt, -minStart);
      const excl = new Set(op.items.map((i) => i.c.id));
      this.snapLine = null;
      if (!e.shiftKey) {
        const edges = op.items.flatMap((i) => [i.start + dt, i.start + dt + i.c.duration]);
        const s = this.snapDelta(edges, excl);
        if (s.at != null) { dt += s.d; this.snapLine = s.at; }
      }
      dt = Math.round(dt * store.fps) / store.fps;
      dt = Math.max(dt, -minStart);
      // iz değişimi (yalnızca tutulan klip türünde)
      let dRow = 0;
      if (hit.row && hit.row.track.kind === op.rowIdx.kind) {
        const now = this.kindIndex(hit.row.track.id).i;
        dRow = now - op.rowIdx.i;
      }
      const vt = store.videoTracks(), at = store.audioTracks();
      // sınır kontrolü
      const fits = op.items.every((i) => {
        const t = store.track(i.trackId);
        if (t.kind !== op.rowIdx.kind) return true;
        const list = t.kind === 'video' ? vt : at;
        const ni = list.indexOf(t) + dRow;
        return ni >= 0 && ni < list.length && !list[ni].locked;
      });
      if (!fits) dRow = op.lastDRow ?? 0;
      op.lastDRow = dRow;
      for (const i of op.items) {
        i.c.start = i.start + dt;
        const t = store.track(i.trackId);
        if (t.kind === op.rowIdx.kind) {
          const list = t.kind === 'video' ? vt : at;
          i.c.trackId = list[list.indexOf(t) + dRow].id;
        }
      }
      store.emit('change', { live: true });
      const c = op.clip;
      this.tooltip(e, `${dt >= 0 ? '+' : '−'}${formatTC(Math.abs(dt), store.fps)}  ·  ${formatTC(c.start, store.fps)}${op.dup ? '  (kopya)' : ''}`);
      return;
    }
    if (op.type === 'marquee') {
      op.x1 = hit.x + this.scroller.scrollLeft; op.y1 = hit.y;
      if (!op.moved && Math.abs(op.x1 - op.x0) + Math.abs(op.y1 - op.y0) < 5) return;
      op.moved = true;
      const t0 = Math.min(op.x0, op.x1) / this.pps, t1 = Math.max(op.x0, op.x1) / this.pps;
      const y0 = Math.min(op.y0, op.y1), y1 = Math.max(op.y0, op.y1);
      const rows = this.rows().filter((r) => r.y + r.h > y0 && r.y < y1).map((r) => r.track.id);
      const ids = store.project.clips.filter((c) => rows.includes(c.trackId) && c.start < t1 && c.start + c.duration > t0).map((c) => c.id);
      store.selection = new Set([...op.base, ...ids]);
      store.emit('selection');
      this.request();
    }
  }

  onUp(e) {
    const op = this.op;
    this.op = null;
    this.snapLine = null;
    this.hideTooltip();
    clearInterval(this._autoScroll); this._autoScroll = null;
    if (!op) return;
    if (op.type === 'move') {
      if (!op.moved) {
        // tek tıkla seçim (ek tuşsuz): yalnızca bu grubu seç
        if (!(e.shiftKey || e.ctrlKey || e.metaKey)) {
          const group = this.linked && !e.altKey ? store.linked(op.clip) : [op.clip];
          store.select(group.map((c) => c.id));
        }
        store.cancel();
        return;
      }
      const ids = new Set(op.items.map((i) => i.c.id));
      for (const i of op.items) store.clearRange(i.c.trackId, i.c.start, i.c.start + i.c.duration, ids);
      store.commit(op.dup ? 'Kopyala ve taşı' : 'Taşı');
      return;
    }
    if (op.type === 'trim') { store.commit('Kırp'); return; }
    if (op.type === 'fade') { store.commit('Geçiş süresi'); return; }
    if (op.type === 'marquee' && !op.moved) {
      this.player.pause();
      let t = op.t;
      if (this.snapping && !e.shiftKey) { const s = this.snapDelta([t], new Set()); if (s.at != null) t = s.at; }
      store.setPlayhead(t);
    }
    this.request();
  }

  autoScroll(e) {
    const r = this.scroller.getBoundingClientRect();
    const edge = 30;
    let v = 0;
    if (e.clientX < r.left + edge) v = -12; else if (e.clientX > r.right - edge) v = 12;
    clearInterval(this._autoScroll);
    this._autoScroll = null;
    if (v) this._autoScroll = setInterval(() => { this.scroller.scrollLeft += v; }, 16);
  }

  tooltip(e, text) {
    let tip = this._tip;
    if (!tip) { tip = this._tip = h('div', { class: 'tl-tip' }); document.body.append(tip); }
    tip.textContent = text;
    tip.style.left = e.clientX + 14 + 'px';
    tip.style.top = e.clientY - 30 + 'px';
    tip.style.display = 'block';
  }
  hideTooltip() { if (this._tip) this._tip.style.display = 'none'; }

  onContext(e) {
    const hit = this.hit(e);
    const clip = hit.clip;
    const A = window.kurgu;
    if (clip) {
      if (!store.selection.has(clip.id)) store.select(this.linked ? store.linked(clip).map((c) => c.id) : [clip.id]);
      const isVideoTrack = store.track(clip.trackId).kind === 'video';
      contextMenu(e.clientX, e.clientY, [
        { label: 'Oynatma kafasında böl', shortcut: 'Ctrl+K', action: () => A.splitAtPlayhead() },
        { label: 'Kes', shortcut: 'Ctrl+X', action: () => A.cut() },
        { label: 'Kopyala', shortcut: 'Ctrl+C', action: () => A.copy() },
        { label: 'Çoğalt', shortcut: 'Ctrl+D', action: () => A.duplicate() },
        '-',
        { label: 'Sil', shortcut: 'Delete', danger: true, action: () => A.deleteSelection(false) },
        { label: 'Dalgalı sil (boşluğu kapat)', shortcut: 'Shift+Delete', danger: true, action: () => A.deleteSelection(true) },
        '-',
        clip.linkId ? { label: 'Video ve sesin bağlantısını kopar', action: () => store.transact('Bağlantıyı kopar', () => store.selectedClips().forEach((c) => (c.linkId = null))) }
          : (store.selection.size === 2 ? { label: 'Seçili klipleri bağla', action: () => { const l = uid('l'); store.transact('Bağla', () => store.selectedClips().forEach((c) => (c.linkId = l))); } } : null),
        { label: 'Hız / Süre…', shortcut: 'Ctrl+R', action: () => A.speedDialog() },
        clip.type === 'media' ? { label: clip.reverse ? 'Ters oynatmayı kapat' : 'Ters oynat', action: () => store.transact('Ters oynat', () => { const v = !clip.reverse; store.linked(clip).forEach((c) => { c.reverse = v; }); }) } : null,
        isVideoTrack && clip.type === 'media' ? { label: 'Kareyi çerçeveye sığdır', action: () => store.transact('Sığdır', () => { clip.transform.fit = 'cover'; }) } : null,
        isVideoTrack ? { label: clip.transitionIn ? 'Geçişi kaldır' : 'Çapraz geçiş ekle', action: () => store.transact('Geçiş', () => { clip.transitionIn = clip.transitionIn ? null : { type: 'dissolve', duration: 1 }; }) } : null,
        { label: clip.muted ? 'Klibi etkinleştir' : 'Klibi devre dışı bırak', shortcut: 'Shift+E', action: () => A.toggleClipEnabled() },
      ]);
    } else if (hit.row) {
      const t = hit.t;
      const clips = store.clipsOn(hit.row.track.id);
      const prev = clips.filter((c) => c.start + c.duration <= t + EPS).pop();
      const next = clips.find((c) => c.start >= t - EPS);
      const inGap = !!next && (!prev || prev.start + prev.duration < next.start - EPS);
      contextMenu(e.clientX, e.clientY, [
        { label: 'Boşluğu kapat (dalgalı sil)', disabled: !inGap, action: () => store.transact('Boşluğu kapat', () => store.closeGap(hit.row.track.id, t)) },
        { label: 'Yapıştır', shortcut: 'Ctrl+V', disabled: !store.clipboard, action: () => A.paste() },
        '-',
        { label: 'İşaretçi ekle', shortcut: 'M', action: () => A.addMarker(t) },
        { label: 'Tümünü seç', shortcut: 'Ctrl+A', action: () => store.select(store.project.clips.map((c) => c.id)) },
      ]);
    }
  }

  // ---------- sürükle-bırak ----------
  dropInfo(e) {
    const p = this.local(e);
    const row = this.rowAt(p.y);
    const t = this.x2t(p.x);
    return { row, t, x: p.x };
  }

  onDragOver(e) {
    const pl = drag.payload;
    const isFiles = e.dataTransfer.types.includes('Files');
    if (!pl && !isFiles) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { row, t } = this.dropInfo(e);
    this.ghost = null;
    if (!pl) { this.request(); return; }
    if (pl.type === 'media') {
      const m = store.media(pl.mediaId);
      if (!m) return;
      const dur = m.kind === 'image' ? 5 : (m.srcOut ?? m.duration) - (m.srcIn ?? 0);
      let start = Math.max(0, t);
      const s = this.snapDelta([start, start + dur], new Set());
      if (s.at != null) start += s.d;
      const items = [];
      const vRow = row && row.track.kind === 'video' ? row.track : store.videoTracks()[0];
      const aRow = row && row.track.kind === 'audio' ? row.track : store.audioTracks()[Math.max(0, store.videoTracks().indexOf(vRow))] || store.audioTracks()[0];
      if (m.kind !== 'audio') items.push({ trackId: vRow.id, start, duration: dur });
      if (m.kind === 'audio' || m.hasAudio) items.push({ trackId: aRow.id, start, duration: dur });
      this.ghost = { items, start, insert: e.ctrlKey };
    } else if (pl.type === 'text' || pl.type === 'color') {
      const vRow = row && row.track.kind === 'video' ? row.track : store.videoTracks()[Math.min(1, store.videoTracks().length - 1)];
      let start = Math.max(0, t);
      const s = this.snapDelta([start, start + 5], new Set());
      if (s.at != null) start += s.d;
      this.ghost = { items: [{ trackId: vRow.id, start, duration: 5 }], start };
    } else if (pl.type === 'transition') {
      if (row && row.track.kind === 'video') {
        const clips = store.clipsOn(row.track.id);
        let best = null;
        for (const c of clips) {
          const d = Math.abs(c.start - t) * this.pps;
          if (d < 40 && (!best || d < best.d)) best = { d, c };
        }
        if (best) this.ghost = { items: [], cut: { trackId: row.track.id, t: best.c.start }, clipId: null, target: best.c.id };
      }
    } else if (pl.type === 'filter' || pl.type === 'animation') {
      if (row) {
        const c = store.clipsOn(row.track.id).find((k) => t >= k.start && t < k.start + k.duration);
        if (c && row.track.kind === 'video') this.ghost = { items: [], clipId: c.id };
      }
    }
    this.request();
  }

  async onDrop(e) {
    e.preventDefault();
    const pl = drag.payload;
    const g = this.ghost;
    this.ghost = null;
    drag.payload = null;
    const { row, t } = this.dropInfo(e);
    if (!pl && e.dataTransfer.files.length) {
      const res = await window.kurgu.importFiles(e.dataTransfer.files);
      if (res?.added?.length) {
        store.transact('Zaman çizelgesine ekle', () => {
          let at = Math.max(0, t);
          for (const m of res.added) {
            const placed = store.placeMedia(m, row?.track.id, at);
            if (placed[0]) at = placed[0].start + placed[0].duration;
          }
        });
      }
      return;
    }
    if (!pl || !g) { this.request(); return; }
    if (pl.type === 'media') {
      const m = store.media(pl.mediaId);
      store.transact('Klibi yerleştir', () => {
        const placed = store.placeMedia(m, g.items[0]?.trackId, g.start, { mode: e.ctrlKey ? 'insert' : 'overwrite' });
        store.select(placed.map((c) => c.id));
      });
    } else if (pl.type === 'text') {
      store.transact('Metin ekle', (P) => {
        const it = g.items[0];
        store.clearRange(it.trackId, it.start, it.start + 5);
        const c = makeClip('text', { trackId: it.trackId, start: it.start, duration: 5, ...JSON.parse(JSON.stringify(pl.preset || {})) });
        P.clips.push(c);
        store.select([c.id]);
      });
    } else if (pl.type === 'color') {
      store.transact('Renk katmanı', (P) => {
        const it = g.items[0];
        store.clearRange(it.trackId, it.start, it.start + 5);
        const c = makeClip('color', { trackId: it.trackId, start: it.start, duration: 5, ...(pl.preset || {}) });
        P.clips.push(c);
        store.select([c.id]);
      });
    } else if (pl.type === 'transition' && g.target) {
      store.transact('Geçiş ekle', () => { store.clip(g.target).transitionIn = { type: pl.ttype, duration: 1 }; });
      store.select([g.target]);
      toast(`${TRANSITIONS[pl.ttype]} eklendi`);
    } else if (pl.type === 'filter' && g.clipId) {
      store.transact('Filtre uygula', () => { store.clip(g.clipId).color.preset = pl.preset; });
      store.select([g.clipId]);
      toast(`${COLOR_PRESETS[pl.preset].label} filtresi uygulandı`);
    } else if (pl.type === 'animation' && g.clipId) {
      store.transact('Animasyon', () => { store.clip(g.clipId).animation = pl.anim; });
      store.select([g.clipId]);
      toast(`${ANIMATIONS[pl.anim]} uygulandı`);
    }
    void row;
    this.request();
  }
}
