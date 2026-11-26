// Kurgu Studio — uygulama kabuğu
import { store, makeClip, newProject, DEFAULT_TEXT } from './store.js';
import { Player } from './player.js';
import { Timeline, drag } from './timeline.js';
import { Inspector } from './inspector.js';
import { Scopes } from './scopes.js';
import { importItems, buildCache } from './media.js';
import { exportVideo, codecSupport, estimateSize } from './exporter.js';
import { pickMedia, pickSingleMedia, filesFromDrop, saveProject, openProjectFile, projectNameFromPath, isElectron, native } from './platform.js';
import { TRANSITIONS, COLOR_PRESETS, ANIMATIONS, measureTextBox } from './compositor.js';
import { animated, writeValue } from './keyframes.js';
import { normalizeSelected, duckDialog, silenceDialog } from './tools.js';
import { transcribeDialog, exportSrt, importSrtDialog } from './subtitles.js';
import { buildSeqTabs, openSequence, newSequence, nestSelection } from './sequences.js';
import { createProxies, removeProxy, proxyState, setUseProxy, validateProxies } from './proxy.js';
import { h, clamp, formatTC, formatDur, parseTC, debounce, uid, EPS } from './utils.js';
import { icon, contextMenu, toast, modal, confirmDialog, promptDialog } from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- ikonları yerleştir ----------
const setIcon = (id, name, size) => { const el = $('#' + id); if (el) el.innerHTML = icon(name, size); };
setIcon('btnUndo', 'undo'); setIcon('btnRedo', 'redo');
$('#btnExport').innerHTML = icon('export', 16) + '<span>Dışa Aktar</span>';
setIcon('btnSafe', 'grid', 16); setIcon('btnSnap', 'camera', 16); setIcon('btnFull', 'fullscreen', 16);
setIcon('tStart', 'toStart'); setIcon('tPrev', 'stepBack'); setIcon('tPlay', 'play', 22); setIcon('tNext', 'stepFwd'); setIcon('tEnd', 'toEnd'); setIcon('tLoop', 'loop');
$('[data-tool="select"]').innerHTML = icon('select', 16); $('[data-tool="razor"]').innerHTML = icon('razor', 16);
setIcon('btnSnapping', 'magnet', 16); setIcon('btnLinked', 'link', 16); setIcon('btnSplit', 'split', 16); setIcon('btnMarker', 'marker', 16); setIcon('btnDelete', 'trash', 16);
setIcon('zoomOut', 'zoomOut', 15); setIcon('zoomIn', 'zoomIn', 15);

// ---------- çekirdek nesneler ----------
const programCanvas = $('#programCanvas');
const player = new Player(programCanvas);
const timeline = new Timeline($('#timeline'), player);
const inspector = new Inspector($('#inspector'));
const scopes = new Scopes($('#scopeCanvas'), programCanvas);
let page = 'edit';
let monMode = 'program';

const status = (msg) => { $('#statusMsg').textContent = msg; };
const HINTS = {
  select: 'Klibi sürükle: taşı · Kenarlar: kırp · Alt+sürükle: kopyala · Üst noktalar: fade · Ctrl+tekerlek: yakınlaştır',
  razor: 'Jilet: klibe tıklayarak böl · Shift: yakalamayı atla · V: seçim aracına dön',
};

// ---------- monitör boyutlandırma ----------
const frame = $('#frame');
const stage = $('#stage');
function layoutMonitor() {
  const S = store.project.settings;
  const ar = S.width / S.height;
  const W0 = stage.clientWidth - 16, H0 = stage.clientHeight - 16;
  const fit = (aw, ah) => {
    let fw = aw, fh = fw / ar;
    if (fh > ah) { fh = ah; fw = fh * ar; }
    return [Math.max(10, Math.floor(fw)), Math.max(10, Math.floor(fh))];
  };
  const sb = $('#scopesBox');
  let w, hh, side = false, top = 0;
  if (page === 'color') {
    // Ölçümler: monitöre en çok yer bırakan yerleşimi seç (alt veya yan)
    const SCOPE_H = 198;
    const stacked = fit(W0, H0 - SCOPE_H);
    const sw = clamp(Math.round(W0 * 0.4), 240, 520);
    const sideFit = fit(W0 - sw - 8, H0);
    side = sideFit[0] * sideFit[1] > stacked[0] * stacked[1];
    [w, hh] = side ? sideFit : stacked;
    sb.style.width = side ? sw + 'px' : '';
    sb.style.height = side ? Math.max(170, hh) + 'px' : '';
    top = side ? 0 : Math.max(0, (H0 - SCOPE_H - hh) / 2);
  } else {
    [w, hh] = fit(W0, H0);
    top = Math.max(0, (H0 - hh) / 2);
  }
  stage.classList.toggle('scopes-side', side);
  frame.style.width = w + 'px'; frame.style.height = hh + 'px';
  frame.style.marginTop = top + 'px';
  const dpr = window.devicePixelRatio || 1;
  const q = parseFloat($('#monQuality').value);
  const cw = Math.min(S.width, Math.round(w * dpr)) * q, ch = Math.round((cw / S.width) * S.height);
  player.resize(Math.max(2, Math.round(cw)), Math.max(2, ch));
  drawOverlay();
}
new ResizeObserver(layoutMonitor).observe(stage);
$('#monQuality').onchange = () => { localStorage.setItem('kurgu.quality', $('#monQuality').value); layoutMonitor(); };
$('#monQuality').value = localStorage.getItem('kurgu.quality') || '1';
store.on('resolution', () => { layoutMonitor(); });

// ---------- doğrudan düzenleme kaplaması (programda seçili klibi sürükle/ölçekle) ----------
const overlay = $('#overlay');
function selectedVisualClip() {
  const sel = store.selectedClips().filter((c) => store.track(c.trackId)?.kind === 'video');
  if (sel.length !== 1) return null;
  const c = sel[0];
  if (store.playhead < c.start - EPS || store.playhead >= c.start + c.duration) return null;
  return c;
}
function clipBox(c) {
  const S = store.project.settings;
  const T = animated(c, store.playhead).transform;
  let w = S.width, hh = S.height;
  if (c.type === 'text') { const b = measureTextBox(c, store.project); w = b.w + 20; hh = b.h + 10; }
  else if (c.type === 'media') {
    const m = store.media(c.mediaId);
    if (m && m.width && m.height && T.fit !== 'fill') {
      const f = T.fit === 'cover' ? Math.max(S.width / m.width, S.height / m.height) : Math.min(S.width / m.width, S.height / m.height);
      w = m.width * f; hh = m.height * f;
    }
  }
  return { w: w * T.scale, h: hh * T.scale, cx: S.width / 2 + T.x, cy: S.height / 2 + T.y, rot: T.rotation };
}
function drawOverlay() {
  overlay.innerHTML = '';
  if (monMode !== 'program' || player.playing) return;
  const c = selectedVisualClip();
  if (!c) return;
  const S = store.project.settings;
  const k = frame.clientWidth / S.width;
  const b = clipBox(c);
  const box = h('div', { class: 'ov-box', title: 'Sürükle: taşı · Köşeler: ölçekle (Shift: serbest) · Alt+sürükle: döndür' });
  Object.assign(box.style, { width: b.w * k + 'px', height: b.h * k + 'px', left: (b.cx - b.w / 2) * k + 'px', top: (b.cy - b.h / 2) * k + 'px', transform: `rotate(${b.rot}deg)` });
  for (const pos of ['nw', 'ne', 'sw', 'se']) box.append(h('div', { class: `ov-handle ${pos}`, 'data-h': pos }));
  overlay.append(box);
  if (c.mask?.on) drawMaskOverlay(c, b, k);
  box.addEventListener('pointerdown', (e) => {
    if (store.track(c.trackId).locked) return;
    e.preventDefault(); e.stopPropagation();
    box.setPointerCapture(e.pointerId);
    const handle = e.target.dataset.h;
    const T = animated(c, store.playhead).transform;
    const o = { x: e.clientX, y: e.clientY, tx: T.x, ty: T.y, sc: T.scale, rot: T.rotation };
    // animasyonlu özelliklerde oynatma kafasına anahtar kare yazar
    const put = (k, v) => writeValue(c, 'transform.' + k, store.playhead, v);
    const fr = frame.getBoundingClientRect();
    const center = { x: fr.left + b.cx * k, y: fr.top + b.cy * k };
    const d0 = Math.hypot(e.clientX - center.x, e.clientY - center.y);
    const a0 = Math.atan2(e.clientY - center.y, e.clientX - center.x);
    store.begin();
    const mv = (ev) => {
      if (handle) {
        const d = Math.hypot(ev.clientX - center.x, ev.clientY - center.y);
        put('scale', clamp(o.sc * (d / Math.max(1, d0)), 0.02, 10));
      } else if (ev.altKey) {
        const a = Math.atan2(ev.clientY - center.y, ev.clientX - center.x);
        let r = o.rot + ((a - a0) * 180) / Math.PI;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        put('rotation', Math.round(r * 10) / 10);
      } else {
        let nx = o.tx + (ev.clientX - o.x) / k, ny = o.ty + (ev.clientY - o.y) / k;
        // merkeze yakalama
        if (!ev.shiftKey) { if (Math.abs(nx) < 12) nx = 0; if (Math.abs(ny) < 12) ny = 0; }
        put('x', Math.round(nx)); put('y', Math.round(ny));
      }
      store.emit('change', { live: true });
      drawOverlay();
      const bb = overlay.querySelector('.ov-box');
      bb?.setPointerCapture?.(ev.pointerId);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      store.commit(handle ? 'Ölçekle' : 'Taşı (monitör)');
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
}
// maske kutusu: monitörde sürükle (taşı) / köşelerden boyutlandır
function drawMaskOverlay(c, b, k) {
  const A = animated(c, store.playhead);
  const M = A.mask, sc = A.transform.scale, rot = (A.transform.rotation * Math.PI) / 180;
  const ox = M.x * sc, oy = M.y * sc;
  const cx = b.cx + ox * Math.cos(rot) - oy * Math.sin(rot), cy = b.cy + ox * Math.sin(rot) + oy * Math.cos(rot);
  const w = M.w * sc, hh = M.h * sc;
  const mb = h('div', { class: 'ov-mask' + (M.shape === 'rect' ? '' : ' ellipse'), title: 'Maske: sürükle = taşı · köşeler = boyutlandır' });
  Object.assign(mb.style, { width: w * k + 'px', height: hh * k + 'px', left: (cx - w / 2) * k + 'px', top: (cy - hh / 2) * k + 'px', transform: `rotate(${A.transform.rotation}deg)` });
  for (const pos of ['nw', 'ne', 'sw', 'se']) mb.append(h('div', { class: `ov-handle ${pos}`, 'data-h': pos }));
  overlay.append(mb);
  mb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    try { mb.setPointerCapture(e.pointerId); } catch { /* */ }
    const handle = e.target.dataset.h;
    const o = { x: e.clientX, y: e.clientY, mx: M.x, my: M.y, mw: M.w, mh: M.h };
    const cos = Math.cos(-rot), sin = Math.sin(-rot);
    store.begin();
    const mv = (ev) => {
      const dxs = (ev.clientX - o.x) / k / sc, dys = (ev.clientY - o.y) / k / sc;
      const lx = dxs * cos - dys * sin, ly = dxs * sin + dys * cos; // klip yerel ekseni
      if (handle) {
        const sx = handle.includes('e') ? 1 : -1, sy = handle.includes('s') ? 1 : -1;
        writeValue(c, 'mask.w', store.playhead, Math.max(10, Math.round(o.mw + 2 * sx * lx)));
        writeValue(c, 'mask.h', store.playhead, Math.max(10, Math.round(o.mh + 2 * sy * ly)));
      } else {
        writeValue(c, 'mask.x', store.playhead, Math.round(o.mx + lx));
        writeValue(c, 'mask.y', store.playhead, Math.round(o.my + ly));
      }
      store.emit('change', { live: true });
      drawOverlay();
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); store.commit(handle ? 'Maske boyutu' : 'Maskeyi taşı'); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
}
store.on('selection', drawOverlay);
store.on('playhead', () => { if (!player.playing) drawOverlay(); });
store.on('change', (d) => { if (!d?.live) drawOverlay(); });
store.on('transport', drawOverlay);
// monitöre tıklayınca klip seç
frame.addEventListener('pointerdown', (e) => {
  if (e.target !== programCanvas && e.target !== overlay) return;
  const S = store.project.settings;
  const r = frame.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * S.width, py = ((e.clientY - r.top) / r.height) * S.height;
  const mm = new Map(store.project.media.map((m) => [m.id, m]));
  const vt = store.videoTracks().slice().reverse();
  for (const t of vt) {
    if (t.hidden) continue;
    const c = store.clipsOn(t.id).find((k) => store.playhead >= k.start && store.playhead < k.start + k.duration);
    if (!c) continue;
    const b = clipBox(c);
    if (Math.abs(px - b.cx) <= b.w / 2 && Math.abs(py - b.cy) <= b.h / 2) {
      store.select(timeline.linked ? store.linked(c).map((x) => x.id) : [c.id]);
      return;
    }
  }
  void mm;
  store.select([]);
});

// ---------- güncellemeler ----------
function updateTimecodes() {
  const fps = store.fps;
  const tc = formatTC(store.playhead, fps);
  if (document.activeElement !== $('#tcCurrent') && monMode === 'program') $('#tcCurrent').value = tc;
  $('#tlTc').textContent = tc;
  if (monMode === 'program') {
    const d = store.duration();
    $('#tcDuration').textContent = formatTC(d, fps);
    $('#tcDuration').title = 'Sekans süresi';
  }
}
store.on('playhead', updateTimecodes);
store.on('change', (d) => { updateTimecodes(); if (d?.live) return; updateTitle(); scheduleAutosave(); updateUndoButtons(); });
store.on('transport', (playing) => {
  $('#tPlay').innerHTML = icon(playing ? 'pause' : 'play', 22);
  $('#tPlay').setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat');
});
player.onFrame = () => { if (page === 'color') scopes.update(); };

function updateTitle() {
  const P = store.project;
  $('#projName').textContent = P.name;
  $('#saveState').textContent = store.dirty ? '● Kaydedilmedi' : (store.filePath ? 'Kaydedildi' : '');
  $('#saveState').className = 'save-state' + (store.dirty ? ' dirty' : '');
  document.title = `${store.dirty ? '• ' : ''}${P.name} — Kurgu Studio`;
  const S = P.settings;
  $('#statusSeq').textContent = `${S.width}×${S.height} · ${S.fps} fps`;
}
function updateUndoButtons() {
  $('#btnUndo').disabled = !store.undoStack.length;
  $('#btnRedo').disabled = !store.redoStack.length;
  $('#btnUndo').title = store.undoStack.length ? `Geri al: ${store.undoStack[store.undoStack.length - 1].label} (Ctrl+Z)` : 'Geri al (Ctrl+Z)';
  $('#btnRedo').title = store.redoStack.length ? `Yinele: ${store.redoStack[store.redoStack.length - 1].label} (Ctrl+Shift+Z)` : 'Yinele (Ctrl+Shift+Z)';
}

// ---------- ses ölçerleri ----------
const meterCanvas = $('#meterCanvas');
const meterState = [{ v: -90, peak: -90, pt: 0 }, { v: -90, peak: -90, pt: 0 }];
function drawMeters() {
  const dpr = window.devicePixelRatio || 1;
  const W = meterCanvas.clientWidth, H = meterCanvas.clientHeight;
  if (meterCanvas.width !== Math.round(W * dpr) || meterCanvas.height !== Math.round(H * dpr)) { meterCanvas.width = Math.round(W * dpr); meterCanvas.height = Math.round(H * dpr); }
  const ctx = meterCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const lv = player.levels();
  const now = performance.now();
  const top = 6, bot = H - 16, range = bot - top;
  const db2y = (db) => top + range * (Math.min(0, Math.max(-60, db)) / -60);
  ctx.fillStyle = '#6b7180';
  ctx.font = '8px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  for (const db of [0, -6, -12, -24, -36, -48]) { const y = db2y(db); ctx.fillText(String(db), W - 1, y + 3); ctx.fillRect(W - 15, Math.round(y), 2, 1); }
  for (let i = 0; i < 2; i++) {
    const s = meterState[i];
    const db = lv[i] > 0 ? 20 * Math.log10(lv[i]) : -90;
    s.v = Math.max(db, s.v - 1.2);
    if (s.v > s.peak || now - s.pt > 1200) { s.peak = s.v; s.pt = now; }
    const x = 4 + i * 9, w = 7;
    ctx.fillStyle = '#101216';
    ctx.fillRect(x, top, w, range);
    const y = db2y(s.v);
    const g = ctx.createLinearGradient(0, bot, 0, top);
    g.addColorStop(0, '#2fbf71'); g.addColorStop(0.7, '#2fbf71'); g.addColorStop(0.85, '#e6c229'); g.addColorStop(1, '#ff4040');
    ctx.fillStyle = g;
    if (s.v > -60) ctx.fillRect(x, y, w, bot - y);
    if (s.peak > -60) { ctx.fillStyle = s.peak > -0.5 ? '#ff4040' : '#ddd'; ctx.fillRect(x, db2y(s.peak), w, 1.5); }
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#6b7180';
  ctx.fillText('L', 7.5, H - 4); ctx.fillText('R', 16.5, H - 4);
  requestAnimationFrame(drawMeters);
}
requestAnimationFrame(drawMeters);

// ---------- medya paneli ----------
const mediaPanel = $('#mediaPanel');
let mediaFilter = '';
let mediaView = localStorage.getItem('kurgu.mediaView') || 'grid';
function buildMediaPanel() {
  mediaPanel.innerHTML = '';
  const search = h('input', { class: 'inp search', placeholder: 'Medyada ara…', value: mediaFilter, 'aria-label': 'Medyada ara' });
  search.addEventListener('input', () => { mediaFilter = search.value; renderMediaList(); });
  search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; mediaFilter = ''; renderMediaList(); search.blur(); } });
  const imp = h('button', { class: 'btn primary sm', title: 'Medya içe aktar (Ctrl+I)', html: icon('import', 15) + '<span>İçe Aktar</span>' });
  imp.onclick = () => importDialog();
  const viewBtn = h('button', { class: 'icon-btn sm', title: mediaView === 'grid' ? 'Liste görünümü' : 'Izgara görünümü', 'aria-label': 'Görünümü değiştir', html: icon(mediaView === 'grid' ? 'layers' : 'grid', 15) });
  viewBtn.onclick = () => { mediaView = mediaView === 'grid' ? 'list' : 'grid'; localStorage.setItem('kurgu.mediaView', mediaView); buildMediaPanel(); };
  mediaPanel.append(h('div', { class: 'pool-bar' }, imp, h('div', { class: 'search-wrap', html: icon('search', 14) }, search), viewBtn));
  mediaPanel.append(h('div', { class: 'pool-list ' + mediaView, id: 'poolList' }));
  renderMediaList();
}
function renderMediaList() {
  const list = $('#poolList');
  if (!list) return;
  list.innerHTML = '';
  const items = store.project.media.filter((m) => m.name.toLowerCase().includes(mediaFilter.toLowerCase()));
  if (!store.project.media.length) {
    const empty = h('div', { class: 'pool-empty' },
      h('div', { class: 'pool-empty-ic', html: icon('import', 34) }),
      h('b', {}, 'Medya ekleyin'),
      h('span', {}, 'Video, ses veya görsel dosyalarını buraya sürükleyin ya da'),
      h('button', { class: 'btn sm', onclick: () => importDialog() }, 'Dosya seçin'));
    list.append(empty);
    return;
  }
  if (!items.length) { list.append(h('div', { class: 'pool-none' }, 'Sonuç bulunamadı')); return; }
  const used = new Set(store.project.clips.map((c) => c.mediaId));
  for (const m of items) {
    const cache = store.mediaCache.get(m.id);
    const thumb = h('div', { class: 'pm-thumb' + (m.kind === 'audio' ? ' audio' : '') });
    if (cache?.poster) { const c = cache.poster; const img = h('canvas', { width: c.width, height: c.height }); img.getContext('2d', { willReadFrequently: true }).drawImage(c, 0, 0); thumb.append(img); }
    else thumb.innerHTML = icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film', 28);
    if (m.kind !== 'image') thumb.append(h('span', { class: 'pm-dur' }, formatDur(m.duration)));
    if (m.offline) thumb.append(h('span', { class: 'pm-offline' }, 'Çevrimdışı'));
    if (m.proxy) thumb.append(h('span', { class: 'pm-proxy', title: 'Proxy hazır' }, 'PRX'));
    if (used.has(m.id)) thumb.append(h('span', { class: 'pm-used', title: 'Zaman çizelgesinde kullanılıyor' }));
    const meta = m.kind === 'audio' ? 'Ses' : m.kind === 'image' ? `Görsel · ${m.width}×${m.height}` : `${m.width}×${m.height}${m.fps ? ' · ' + m.fps + ' fps' : ''}`;
    const card = h('div', { class: 'pm-item' + (m.offline ? ' offline' : ''), draggable: !m.offline, tabindex: 0, title: `${m.name}\n${meta}\nÇift tık: kaynak monitör · Sürükle: zaman çizelgesi`, 'data-id': m.id },
      thumb, h('div', { class: 'pm-info' }, h('div', { class: 'pm-name' }, m.name), h('div', { class: 'pm-meta' }, meta)));
    card.addEventListener('dragstart', (e) => {
      drag.payload = { type: 'media', mediaId: m.id };
      e.dataTransfer.setData('text/plain', m.name);
      e.dataTransfer.effectAllowed = 'copy';
      if (cache?.poster) e.dataTransfer.setDragImage(thumb, 40, 25);
    });
    card.addEventListener('dragend', () => { drag.payload = null; timeline.ghost = null; timeline.request(); });
    card.addEventListener('dblclick', () => (m.offline ? relink(m) : openSource(m)));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); openSource(m); }
      if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); removeMedia(m); }
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Kaynak monitörde aç', disabled: m.offline, action: () => openSource(m) },
        { label: 'Oynatma kafasına ekle', shortcut: ',', disabled: m.offline, action: () => placeAtPlayhead(m, 'insert') },
        { label: 'Oynatma kafasına üzerine yaz', shortcut: '.', disabled: m.offline, action: () => placeAtPlayhead(m, 'overwrite') },
        { label: 'Sona ekle', disabled: m.offline, action: () => placeAtEnd(m) },
        '-',
        m.kind === 'video' ? (m.proxy ? { label: 'Proxy\'yi kaldır', action: () => removeProxy(m) } : { label: 'Proxy oluştur (hafif önizleme kopyası)', disabled: m.offline, action: () => createProxies([m]) }) : null,
        { label: 'Yeniden adlandır', action: async () => { const n = await promptDialog('Yeniden adlandır', 'Ad', m.name); if (n) store.transact('Medya adı', () => { store.media(m.id).name = n; }); } },
        { label: 'Medyayı yeniden bağla…', action: () => relink(m) },
        isElectron && m.path ? { label: 'Dosya konumunu göster', action: () => native.showItem(m.path) } : null,
        '-',
        { label: 'Projeden kaldır', danger: true, action: () => removeMedia(m) },
      ]);
    });
    list.append(card);
  }
}
const renderMediaListDeb = debounce(renderMediaList, 60);
store.on('change', (d) => { if (!d?.live) renderMediaListDeb(); });
store.on('media-cache', debounce(renderMediaList, 200));
store.on('load', () => { buildMediaPanel(); store.project.media.forEach((m) => buildCache(m)); });

// dosyaları panele sürükle
for (const el of [mediaPanel, stage]) {
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('drop-hot'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-hot'); });
  el.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    el.classList.remove('drop-hot');
    const res = await importFiles(e.dataTransfer.files);
    if (el === stage && res?.added?.length) res.added.forEach((m) => placeAtEnd(m));
  });
}

async function importDialog() {
  const items = await pickMedia();
  if (items.length) return doImport(items);
}
async function importFiles(fileList) {
  const items = filesFromDrop(fileList);
  if (!items.length) { toast('Desteklenmeyen dosya türü', 'warn'); return null; }
  return doImport(items);
}
async function doImport(items) {
  status(`${items.length} dosya içe aktarılıyor…`);
  const hadVideo = store.project.media.some((m) => m.kind === 'video');
  const res = await importItems(items);
  if (res.added.length) toast(`${res.added.length} medya eklendi`, 'ok');
  if (res.errors.length) toast('İçe aktarılamadı: ' + res.errors.join(', '), 'err', 6000);
  status('Hazır');
  // ilk medya: sekans ayarlarını medyaya uydurmayı öner
  const v = res.added.find((m) => m.kind === 'video');
  const P = store.project;
  if (v && P.clips.length === 0 && !hadVideo && v.width && (v.width !== P.settings.width || v.height !== P.settings.height || (v.fps && Math.abs(v.fps - P.settings.fps) > 0.5))) {
    const fps = v.fps ? [23.976, 24, 25, 29.97, 30, 50, 60].reduce((a, b) => (Math.abs(b - v.fps) < Math.abs(a - v.fps) ? b : a)) : P.settings.fps;
    const ok = await confirmDialog('Sekans ayarları', `İlk videonuz ${v.width}×${v.height}${v.fps ? ', ' + fps + ' fps' : ''}. Sekans ayarları bu videoya uydurulsun mu?`, 'Uydur');
    if (ok === 'ok') { store.transact('Sekans ayarları', () => { P.settings.width = v.width - (v.width % 2); P.settings.height = v.height - (v.height % 2); P.settings.fps = fps; }); store.emit('resolution'); }
  }
  return res;
}
async function relink(m) {
  const it = await pickSingleMedia();
  if (!it) return;
  store.transact('Yeniden bağla', () => { const x = store.media(m.id); Object.assign(x, { path: it.path, url: it.url, offline: false, name: x.name }); });
  buildCache(store.media(m.id));
  toast('Medya yeniden bağlandı', 'ok');
}
async function removeMedia(m) {
  const n = store.project.clips.filter((c) => c.mediaId === m.id).length;
  if (n) {
    const r = await confirmDialog('Medyayı kaldır', `"${m.name}" zaman çizelgesinde ${n} klipte kullanılıyor. Klipler de kaldırılacak.`, 'Kaldır', true);
    if (r !== 'ok') return;
  }
  store.transact('Medya kaldır', (P) => { P.clips = P.clips.filter((c) => c.mediaId !== m.id); P.media = P.media.filter((x) => x.id !== m.id); store.cleanupLinks(); });
  store.selection = new Set([...store.selection].filter((id) => store.clip(id)));
  store.emit('selection');
}
function placeAtPlayhead(m, mode) {
  store.transact(mode === 'insert' ? 'Ekle' : 'Üzerine yaz', () => {
    const placed = store.placeMedia(m, null, store.playhead, { mode });
    store.select(placed.map((c) => c.id));
    if (placed[0]) store.setPlayhead(placed[0].start + placed[0].duration);
  });
}
function placeAtEnd(m) {
  store.transact('Sona ekle', () => {
    const vt = store.videoTracks()[0], at = store.audioTracks()[0];
    const end = Math.max(...store.clipsOn(m.kind === 'audio' ? at.id : vt.id).map((c) => c.start + c.duration), 0);
    const placed = store.placeMedia(m, null, end);
    store.select(placed.map((c) => c.id));
  });
}

// ---------- efektler paneli ----------
const TEXT_PRESETS = [
  { name: 'Başlık', desc: 'Ortada büyük başlık', p: { text: { ...DEFAULT_TEXT(), content: 'Başlık', size: 120 } } },
  { name: 'Alt Başlık', desc: 'Daha küçük, ince', p: { text: { ...DEFAULT_TEXT(), content: 'Alt başlık metni', size: 64, bold: false } } },
  { name: 'Alt Üçte Bir', desc: 'İsim / unvan şeridi', p: { text: { ...DEFAULT_TEXT(), content: 'Ad Soyad\nUnvan', size: 52, align: 'left', bg: true, bgColor: '#1a1d24', bgOpacity: 0.85, lineHeight: 1.35 }, transform: { x: -560, y: 330, scale: 1, rotation: 0, opacity: 1, fit: 'contain', cropL: 0, cropR: 0, cropT: 0, cropB: 0, blend: 'source-over', flipH: false, flipV: false }, animation: 'fadeUp' } },
  { name: 'Altyazı', desc: 'Kutulu, ekranın altında', p: { text: { ...DEFAULT_TEXT(), content: 'Altyazı metni buraya', size: 48, bold: false, bg: true, bgOpacity: 0.6, shadow: 0 }, transform: { x: 0, y: 420, scale: 1, rotation: 0, opacity: 1, fit: 'contain', cropL: 0, cropR: 0, cropT: 0, cropB: 0, blend: 'source-over', flipH: false, flipV: false } } },
  { name: 'Sinematik', desc: 'Geniş harf aralıklı', p: { text: { ...DEFAULT_TEXT(), content: 'S İ N E M A', size: 90, font: 'Georgia', bold: false, letterSpacing: 18, shadow: 0.8 }, fadeIn: 1, fadeOut: 1 } },
  { name: 'Vurucu', desc: 'Kalın, konturlu', p: { text: { ...DEFAULT_TEXT(), content: 'WOW!', size: 180, font: 'Impact', color: '#ffd34d', stroke: 6, strokeColor: '#000000' }, animation: 'pop' } },
  { name: 'Daktilo', desc: 'Harf harf yazılır', p: { text: { ...DEFAULT_TEXT(), content: 'Bir varmış, bir yokmuş…', size: 72, font: 'Courier New', bold: false }, animation: 'typewriter' } },
];
const GEN_PRESETS = [
  { name: 'Düz Renk', p: { fill: '#1e88e5', gradient: false } },
  { name: 'Siyah', p: { fill: '#000000', gradient: false } },
  { name: 'Gün Batımı', p: { fill: '#ff7e5f', fill2: '#6a3093', gradient: true } },
  { name: 'Okyanus', p: { fill: '#00c6ff', fill2: '#0072ff', gradient: true } },
  { name: 'Orman', p: { fill: '#134e5e', fill2: '#71b280', gradient: true } },
];
function buildEffectsPanel() {
  const panel = $('#effectsPanel');
  panel.innerHTML = '';
  const search = h('input', { class: 'inp search', placeholder: 'Efekt ara…', 'aria-label': 'Efekt ara' });
  panel.append(h('div', { class: 'pool-bar' }, h('div', { class: 'search-wrap', html: icon('search', 14) }, search)));
  const body = h('div', { class: 'fx-body' });
  panel.append(body);
  const group = (title, hint, items) => {
    const g = h('div', { class: 'fx-group' }, h('div', { class: 'fx-title' }, title, h('span', { class: 'fx-hint' }, hint)));
    const grid = h('div', { class: 'fx-grid' });
    items.forEach((it) => {
      const el = h('div', { class: 'fx-item', draggable: true, tabindex: 0, title: it.title || it.name, 'data-name': it.name.toLowerCase() }, it.visual || h('span', { class: 'fx-ic', html: icon(it.icon || 'wand', 18) }), h('span', { class: 'fx-name' }, it.name));
      el.addEventListener('dragstart', (e) => { drag.payload = it.payload; e.dataTransfer.setData('text/plain', it.name); e.dataTransfer.effectAllowed = 'copy'; });
      el.addEventListener('dragend', () => { drag.payload = null; timeline.ghost = null; timeline.request(); });
      el.addEventListener('click', () => it.apply());
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); it.apply(); } });
      grid.append(el);
    });
    g.append(grid);
    body.append(g);
  };
  const needClip = (fn) => () => {
    const c = store.selectedClips().find((x) => store.track(x.trackId).kind === 'video');
    if (!c) return toast('Önce zaman çizelgesinde bir video klibi seçin ya da efekti klibin üzerine sürükleyin', 'warn', 3500);
    fn(c);
  };
  group('Başlıklar', 'Tıkla: oynatma kafasına ekle', TEXT_PRESETS.map((t) => ({
    name: t.name, title: t.desc, icon: 'text', payload: { type: 'text', preset: t.p },
    visual: h('span', { class: 'fx-text', style: { fontFamily: t.p.text.font, fontWeight: t.p.text.bold ? 700 : 400, color: t.p.text.color === '#ffffff' ? '' : t.p.text.color } }, 'Aa'),
    apply: () => addTextAt(store.playhead, t.p),
  })));
  group('Geçişler', 'Kesme noktasına sürükle', Object.entries(TRANSITIONS).map(([k, v]) => ({
    name: v, icon: 'layers', payload: { type: 'transition', ttype: k },
    visual: h('span', { class: `fx-trans t-${k}` }),
    apply: needClip((c) => { store.transact('Geçiş ekle', () => { c.transitionIn = { type: k, duration: 1 }; }); toast(`${v} seçili klibe eklendi`, 'ok'); }),
  })));
  group('Renk Filtreleri', 'Klibe sürükle veya tıkla', Object.entries(COLOR_PRESETS).filter(([k]) => k !== 'none').map(([k, v]) => ({
    name: v.label, payload: { type: 'filter', preset: k },
    visual: h('span', { class: 'fx-swatch', style: { filter: v.filter || 'none' } }),
    apply: needClip((c) => { store.transact('Filtre', () => { c.color.preset = k; }); toast(`${v.label} uygulandı`, 'ok'); }),
  })));
  group('Animasyonlar', 'Klibe sürükle veya tıkla', Object.entries(ANIMATIONS).filter(([k]) => k !== 'none').map(([k, v]) => ({
    name: v, icon: 'wand', payload: { type: 'animation', anim: k },
    apply: needClip((c) => { store.transact('Animasyon', () => { c.animation = k; }); toast(`${v} uygulandı`, 'ok'); }),
  })));
  group('Üreteçler', 'Renk ve gradyan katmanları', GEN_PRESETS.map((g) => ({
    name: g.name, payload: { type: 'color', preset: g.p },
    visual: h('span', { class: 'fx-swatch', style: { background: g.p.gradient ? `linear-gradient(135deg, ${g.p.fill}, ${g.p.fill2})` : g.p.fill } }),
    apply: () => addColorAt(store.playhead, g.p),
  })));
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    body.querySelectorAll('.fx-item').forEach((el) => el.classList.toggle('hidden', !!q && !el.dataset.name.includes(q)));
    body.querySelectorAll('.fx-group').forEach((g) => g.classList.toggle('hidden', !g.querySelector('.fx-item:not(.hidden)')));
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());
}
function freeVideoTrackAt(t, dur) {
  const vt = store.videoTracks();
  for (let i = 1; i < vt.length; i++) {
    if (!vt[i].locked && !store.clipsOn(vt[i].id).some((c) => c.start < t + dur && c.start + c.duration > t)) return vt[i];
  }
  return store.addTrack('video');
}
function addTextAt(t, preset) {
  store.transact('Metin ekle', (P) => {
    const tr = freeVideoTrackAt(t, 5);
    const c = makeClip('text', { trackId: tr.id, start: t, duration: 5, ...JSON.parse(JSON.stringify(preset)) });
    P.clips.push(c);
    store.select([c.id]);
  });
  toast('Metin eklendi — Denetçi panelinden düzenleyin', 'ok');
}
function addColorAt(t, preset) {
  store.transact('Renk katmanı', (P) => {
    const tr = store.videoTracks()[0];
    store.clearRange(tr.id, t, t + 5);
    const c = makeClip('color', { trackId: tr.id, start: t, duration: 5, ...preset });
    P.clips.push(c);
    store.select([c.id]);
  });
}

// ---------- sekmeler ----------
$$('#leftPanel .tab').forEach((b) => b.addEventListener('click', () => {
  $$('#leftPanel .tab').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
  $$('#leftPanel .tab-body').forEach((x) => x.classList.toggle('hidden', x.dataset.body !== b.dataset.tab));
}));

// ---------- kaynak monitör ----------
const srcVideo = $('#sourceVideo');
let sourceMedia = null;
function openSource(m) {
  sourceMedia = m;
  setMonitor('source');
  $('#sourceEmpty').classList.add('hidden');
  if (m.kind === 'image') { srcVideo.removeAttribute('src'); srcVideo.poster = m.url; }
  else { srcVideo.poster = ''; srcVideo.src = m.url; srcVideo.currentTime = m.srcIn || 0; }
  $('#monTitle').textContent = m.name;
  updateSourceUI();
}
function setMonitor(mode) {
  monMode = mode;
  $$('[data-mon]').forEach((b) => { b.classList.toggle('on', b.dataset.mon === mode); b.setAttribute('aria-selected', String(b.dataset.mon === mode)); });
  const src = mode === 'source';
  $('#sourceView').classList.toggle('hidden', !src);
  frame.classList.toggle('hidden', src);
  $('#sourceScrub').hidden = !src;
  $('#srcActions').hidden = !src;
  $('#tLoop').hidden = src;
  if (src) { player.pause(); $('#monTitle').textContent = sourceMedia?.name || ''; }
  else { srcVideo.pause(); $('#monTitle').textContent = ''; layoutMonitor(); }
  updateTimecodes();
  updateSourceUI();
}
$$('[data-mon]').forEach((b) => b.addEventListener('click', () => setMonitor(b.dataset.mon)));
function updateSourceUI() {
  if (monMode !== 'source') return;
  const m = sourceMedia;
  const d = m?.duration || 0;
  const fps = m?.fps || store.fps;
  if (document.activeElement !== $('#tcCurrent')) $('#tcCurrent').value = formatTC(srcVideo.currentTime || 0, fps);
  const a = m?.srcIn ?? 0, b = m?.srcOut ?? d;
  $('#tcDuration').textContent = m ? `${formatTC(b - a, fps)}` : '--';
  $('#tcDuration').title = 'Giriş–çıkış süresi';
  const rng = $('#srcRange'), head = $('#srcHead');
  if (d) {
    rng.style.left = (a / d) * 100 + '%'; rng.style.width = ((b - a) / d) * 100 + '%';
    head.style.left = ((srcVideo.currentTime || 0) / d) * 100 + '%';
  }
  $('#tPlay').innerHTML = icon(srcVideo.paused ? 'play' : 'pause', 22);
}
srcVideo.addEventListener('timeupdate', updateSourceUI);
srcVideo.addEventListener('play', updateSourceUI);
srcVideo.addEventListener('pause', updateSourceUI);
srcVideo.addEventListener('seeked', updateSourceUI);
(() => {
  const bar = $('#sourceScrub');
  const set = (e) => {
    if (!sourceMedia?.duration) return;
    const r = bar.getBoundingClientRect();
    srcVideo.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * sourceMedia.duration;
  };
  bar.addEventListener('pointerdown', (e) => { bar.setPointerCapture(e.pointerId); set(e); bar.onpointermove = set; });
  bar.addEventListener('pointerup', () => { bar.onpointermove = null; });
})();
function sourceMark(which) {
  if (!sourceMedia) return;
  const t = srcVideo.currentTime;
  store.transact(which === 'in' ? 'Kaynak giriş' : 'Kaynak çıkış', () => {
    const m = store.media(sourceMedia.id);
    if (which === 'in') { m.srcIn = t; if (m.srcOut != null && m.srcOut <= t) m.srcOut = null; }
    else { m.srcOut = t; if (m.srcIn != null && m.srcIn >= t) m.srcIn = null; }
    sourceMedia = m;
  });
  updateSourceUI();
}
$('#srcInsert').onclick = () => sourceMedia && placeAtPlayhead(store.media(sourceMedia.id), 'insert');
$('#srcOverwrite').onclick = () => sourceMedia && placeAtPlayhead(store.media(sourceMedia.id), 'overwrite');

// ---------- taşıma kontrolleri ----------
const stepFrames = (n) => {
  if (monMode === 'source') { srcVideo.pause(); srcVideo.currentTime = clamp(srcVideo.currentTime + n / (sourceMedia?.fps || 30), 0, sourceMedia?.duration || 0); return; }
  player.pause(); store.setPlayhead(store.playhead + n / store.fps);
};
const togglePlay = () => {
  if (monMode === 'source') { if (!sourceMedia || sourceMedia.kind === 'image') return; srcVideo.paused ? srcVideo.play() : srcVideo.pause(); return; }
  player.toggle();
};
const goStart = () => { if (monMode === 'source') { srcVideo.currentTime = sourceMedia?.srcIn || 0; return; } player.pause(); store.setPlayhead(0); };
const goEnd = () => { if (monMode === 'source') { srcVideo.currentTime = sourceMedia?.srcOut ?? sourceMedia?.duration ?? 0; return; } player.pause(); store.setPlayhead(store.duration()); };
function markIn() { if (monMode === 'source') return sourceMark('in'); store.transact('Giriş noktası', (P) => { P.inPoint = store.playhead; if (P.outPoint != null && P.outPoint <= P.inPoint) P.outPoint = null; }); status('Giriş noktası: ' + formatTC(store.playhead, store.fps)); }
function markOut() { if (monMode === 'source') return sourceMark('out'); store.transact('Çıkış noktası', (P) => { P.outPoint = store.playhead; if (P.inPoint != null && P.inPoint >= P.outPoint) P.inPoint = null; }); status('Çıkış noktası: ' + formatTC(store.playhead, store.fps)); }
$('#tPlay').onclick = togglePlay;
$('#tPrev').onclick = () => stepFrames(-1);
$('#tNext').onclick = () => stepFrames(1);
$('#tStart').onclick = goStart;
$('#tEnd').onclick = goEnd;
$('#tIn').onclick = markIn;
$('#tOut').onclick = markOut;
$('#tLoop').onclick = () => { player.loop = !player.loop; $('#tLoop').classList.toggle('on', player.loop); $('#tLoop').setAttribute('aria-pressed', String(player.loop)); status(player.loop ? 'Döngü açık' : 'Döngü kapalı'); };
$('#tcCurrent').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const fps = monMode === 'source' ? (sourceMedia?.fps || 30) : store.fps;
    let v = $('#tcCurrent').value.trim();
    let rel = 0;
    if (/^[+-]/.test(v)) { rel = v[0] === '+' ? 1 : -1; v = v.slice(1); }
    const t = parseTC(v, fps);
    if (t == null) { toast('Geçersiz zaman kodu (ör. 00:01:05:12, 65, 120f, +2)', 'warn'); return; }
    if (monMode === 'source') srcVideo.currentTime = rel ? srcVideo.currentTime + rel * t : t;
    else { player.pause(); store.setPlayhead(rel ? store.playhead + rel * t : t); }
    $('#tcCurrent').blur();
  }
  if (e.key === 'Escape') $('#tcCurrent').blur();
});
$('#tcCurrent').addEventListener('focus', () => $('#tcCurrent').select());
$('#tcCurrent').addEventListener('blur', updateTimecodes);

// monitör seçenekleri
$('#btnSafe').onclick = () => { const on = $('#safe').classList.toggle('hidden'); $('#btnSafe').classList.toggle('on', !on); $('#btnSafe').setAttribute('aria-pressed', String(!on)); };
$('#btnSnap').onclick = async () => {
  const blob = await player.snapshotBlob();
  const a = h('a', { href: URL.createObjectURL(blob), download: `${store.project.name}_${formatTC(store.playhead, store.fps).replace(/:/g, '-')}.png` });
  a.click();
  toast('Kare PNG olarak kaydedildi', 'ok');
};
function toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else $('#monitor').requestFullscreen?.(); }
$('#btnFull').onclick = toggleFullscreen;
document.addEventListener('fullscreenchange', () => setTimeout(layoutMonitor, 50));

// ---------- zaman çizelgesi araç çubuğu ----------
function setTool(t) {
  timeline.tool = t;
  $$('[data-tool]').forEach((b) => { b.classList.toggle('on', b.dataset.tool === t); b.setAttribute('aria-pressed', String(b.dataset.tool === t)); });
  $('#tlHint').textContent = HINTS[t];
  timeline.request();
}
$$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
function toggleSnapping() {
  timeline.snapping = !timeline.snapping;
  $('#btnSnapping').classList.toggle('on', timeline.snapping);
  $('#btnSnapping').setAttribute('aria-pressed', String(timeline.snapping));
  status(timeline.snapping ? 'Yakalama açık' : 'Yakalama kapalı');
}
function toggleLinked() {
  timeline.linked = !timeline.linked;
  $('#btnLinked').classList.toggle('on', timeline.linked);
  $('#btnLinked').setAttribute('aria-pressed', String(timeline.linked));
  status(timeline.linked ? 'Bağlantılı seçim açık' : 'Bağlantılı seçim kapalı');
}
$('#btnSnapping').onclick = toggleSnapping;
$('#btnLinked').onclick = toggleLinked;
$('#btnSplit').onclick = () => splitAtPlayhead();
$('#btnMarker').onclick = () => addMarker();
$('#btnDelete').onclick = () => deleteSelection(false);
const zs = $('#zoomSlider');
const z2s = (pps) => (Math.log(pps / 2) / Math.log(300)) * 100;
const s2z = (v) => 2 * Math.pow(300, v / 100);
zs.addEventListener('input', () => timeline.setZoom(s2z(+zs.value)));
zs.addEventListener('keydown', (e) => e.stopPropagation());
store.on('zoom', (pps) => { zs.value = z2s(pps); });
$('#zoomIn').onclick = () => timeline.setZoom(timeline.pps * 1.4);
$('#zoomOut').onclick = () => timeline.setZoom(timeline.pps / 1.4);
$('#zoomFit').onclick = () => timeline.zoomToFit();

// ---------- kurgu komutları ----------
function targetClipsAtPlayhead() {
  const t = store.playhead;
  const under = (c) => t > c.start + EPS && t < c.start + c.duration - EPS && !store.track(c.trackId).locked;
  const sel = store.selectedClips().filter(under);
  return sel.length ? sel : store.project.clips.filter(under);
}
function splitAtPlayhead() {
  const clips = targetClipsAtPlayhead();
  if (!clips.length) return status('Oynatma kafasının altında bölünecek klip yok');
  store.transact('Böl', () => (timeline.linked ? store.splitAt(clips, store.playhead) : clips.forEach((c) => store.splitClip(c, store.playhead))));
  status(`${clips.length} klip bölündü`);
}
function deleteSelection(ripple) {
  if (!store.selection.size) return;
  store.transact(ripple ? 'Dalgalı sil' : 'Sil', () => store.removeClips(new Set(store.selection), ripple));
  store.emit('selection');
}
function copy() {
  const sel = store.selectedClips();
  if (!sel.length) return;
  const base = Math.min(...sel.map((c) => c.start));
  store.clipboard = sel.map((c) => ({ ...JSON.parse(JSON.stringify(c)), _off: c.start - base }));
  status(`${sel.length} klip kopyalandı`);
}
function cut() { copy(); deleteSelection(false); }
function paste() {
  if (!store.clipboard) return;
  store.transact('Yapıştır', (P) => {
    const relink = new Map();
    const ids = [];
    let end = store.playhead;
    for (const src of store.clipboard) {
      const c = JSON.parse(JSON.stringify(src));
      delete c._off;
      c.id = uid('c');
      if (!store.track(c.trackId)) c.trackId = (store.track(src.trackId)?.kind === 'audio' ? store.audioTracks() : store.videoTracks())[0].id;
      if (c.linkId) { if (!relink.has(c.linkId)) relink.set(c.linkId, uid('l')); c.linkId = relink.get(c.linkId); }
      c.start = store.playhead + src._off;
      store.clearRange(c.trackId, c.start, c.start + c.duration);
      P.clips.push(c);
      ids.push(c.id);
      end = Math.max(end, c.start + c.duration);
    }
    store.select(ids);
    store.setPlayhead(end);
  });
}
function duplicate() {
  const sel = store.selectedClips();
  if (!sel.length) return;
  const end = Math.max(...sel.map((c) => c.start + c.duration));
  copy();
  const keep = store.playhead;
  store.playhead = end;
  paste();
  store.playhead = keep;
  store.setPlayhead(keep);
}
function addMarker(t = store.playhead) {
  const fps = store.fps;
  t = Math.round(t * fps) / fps;
  const P = store.project;
  const exist = P.markers.find((m) => Math.abs(m.t - t) < 0.5 / fps);
  if (exist) return status('Burada zaten bir işaretçi var');
  const colors = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8'];
  store.transact('İşaretçi', () => P.markers.push({ id: uid('mk'), t, color: colors[P.markers.length % colors.length], label: '' }));
  status('İşaretçi eklendi: ' + formatTC(t, fps));
}
function editPoints() {
  const pts = new Set([0]);
  store.project.clips.forEach((c) => { pts.add(Math.round(c.start * 1000) / 1000); pts.add(Math.round((c.start + c.duration) * 1000) / 1000); });
  store.project.markers.forEach((m) => pts.add(m.t));
  return [...pts].sort((a, b) => a - b);
}
function jumpEdit(dir) {
  player.pause();
  const pts = editPoints();
  const t = store.playhead;
  const next = dir > 0 ? pts.find((p) => p > t + 1e-3) : pts.reverse().find((p) => p < t - 1e-3);
  if (next != null) store.setPlayhead(next);
}
function rippleTrim(side) {
  // Q: başı oynatma kafasına kırp + boşluğu kapat / W: sonu kırp + kaydır
  const t = store.playhead;
  const clips = targetClipsAtPlayhead();
  if (!clips.length) return status('Oynatma kafasının altında klip yok');
  store.transact(side === 'start' ? 'Dalgalı kırp (baş)' : 'Dalgalı kırp (son)', (P) => {
    const groups = new Set();
    for (const c of clips) for (const g of timeline.linked ? store.linked(c) : [c]) groups.add(g);
    for (const c of groups) {
      if (store.track(c.trackId).locked) continue;
      if (side === 'start') {
        const cut = t - c.start;
        if (cut <= 0) continue;
        const oldEnd = c.start + c.duration;
        c.in += cut * c.speed; c.duration -= cut;
        for (const k of P.clips) if (k.trackId === c.trackId && k !== c && k.start >= oldEnd - EPS) k.start -= cut;
      } else {
        const oldEnd = c.start + c.duration;
        const cut = oldEnd - t;
        if (cut <= 0) continue;
        c.duration -= cut;
        for (const k of P.clips) if (k.trackId === c.trackId && k !== c && k.start >= oldEnd - EPS) k.start -= cut;
      }
    }
  });
  if (side === 'start') store.setPlayhead(Math.min(...clips.map((c) => c.start)));
}
function toggleClipEnabled() {
  const sel = store.selectedClips();
  if (!sel.length) return;
  const v = !sel[0].muted;
  store.transact(v ? 'Klibi devre dışı bırak' : 'Klibi etkinleştir', () => sel.forEach((c) => { c.muted = v; }));
  status(v ? 'Klip devre dışı (görüntü/ses çıkmaz)' : 'Klip etkin');
}
function speedDialog() {
  const sel = store.selectedClips();
  if (!sel.length) return toast('Önce bir klip seçin', 'warn');
  const c = sel[0];
  const inp = h('input', { class: 'inp', type: 'number', min: 10, max: 800, step: 5, value: Math.round(c.speed * 100) });
  const keepDur = h('input', { type: 'checkbox' });
  const body = h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', {}, 'Hız (%)'), inp),
    h('div', { class: 'quick' }, ...[25, 50, 100, 150, 200, 400].map((v) => h('button', { class: 'chip', onclick: () => { inp.value = v; } }, v + '%'))),
    h('label', { class: 'check-row' }, keepDur, h('span', {}, 'Klibin zaman çizelgesindeki süresini koru')));
  modal({
    title: 'Klip Hızı / Süresi', body, buttons: [{ label: 'Vazgeç' }, {
      label: 'Uygula', primary: true, action: () => {
        const v = clamp(parseFloat(inp.value) / 100, 0.1, 8);
        if (!isFinite(v)) return false;
        store.transact('Hız', () => sel.forEach((k) => {
          const srcLen = k.duration * k.speed;
          k.speed = v;
          if (!keepDur.checked) k.duration = Math.min(srcLen / v, store.mediaMaxDur(k));
          else k.duration = Math.min(k.duration, store.mediaMaxDur(k));
        }));
      },
    }],
  });
}

// ---------- proje dosyaları ----------
async function maybeSave() {
  if (!store.dirty || (store.project.clips.length === 0 && store.project.media.length === 0)) return true;
  const r = await confirmDialog('Kaydedilmemiş değişiklikler', `"${store.project.name}" projesindeki değişiklikler kaydedilsin mi?`, 'Kaydet', false, 'Kaydetme');
  if (r === 'cancel') return false;
  if (r === 'ok') return !!(await save());
  return true;
}
async function newProj() {
  if (!(await maybeSave())) return;
  player.pause();
  store.load(newProject());
  localStorage.removeItem('kurgu.autosave');
  setMonitor('program');
  toast('Yeni proje oluşturuldu');
}
async function openProj(path = null) {
  if (!(await maybeSave())) return;
  try {
    const r = await openProjectFile(path);
    if (!r) return;
    player.pause();
    if (r.path) r.project.name = projectNameFromPath(r.path);
    store.load(r.project, r.path);
    addRecent(r.path);
    const off = r.project.media.filter((m) => m.offline).length;
    if (off) toast(`${off} medya dosyası bulunamadı. Medya panelinde çift tıklayarak yeniden bağlayın.`, 'warn', 6000);
    else toast('Proje açıldı', 'ok');
  } catch (e) {
    toast('Proje açılamadı: ' + e.message, 'err', 5000);
  }
}
async function save(saveAs = false) {
  try {
    const p = await saveProject(store.project, store.filePath, saveAs);
    if (!p) return null;
    if (p !== 'browser') {
      store.filePath = p;
      store.project.name = projectNameFromPath(p);
      addRecent(p);
    }
    store.dirty = false;
    updateTitle();
    localStorage.removeItem('kurgu.autosave');
    toast('Proje kaydedildi', 'ok');
    inspector.refresh();
    return p;
  } catch (e) {
    toast('Kaydedilemedi: ' + e.message, 'err', 5000);
    return null;
  }
}
function recents() { try { return JSON.parse(localStorage.getItem('kurgu.recent') || '[]'); } catch { return []; } }
function addRecent(p) { if (!p) return; const r = [p, ...recents().filter((x) => x !== p)].slice(0, 8); localStorage.setItem('kurgu.recent', JSON.stringify(r)); }

// otomatik kayıt (çökme kurtarma)
const scheduleAutosave = debounce(() => {
  if (!store.dirty) return;
  try {
    localStorage.setItem('kurgu.autosave', JSON.stringify({ project: store.project, filePath: store.filePath, time: Date.now() }));
    $('#statusAuto').textContent = 'Otomatik yedek: ' + new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  } catch { /* depolama dolu */ }
}, 1500);

async function checkRecovery() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem('kurgu.autosave') || 'null'); } catch { /* */ }
  if (!data || !data.project || (!data.project.clips.length && !data.project.media.length)) return false;
  const when = new Date(data.time).toLocaleString('tr-TR');
  const r = await confirmDialog('Kurtarma', `Kaydedilmemiş bir çalışma bulundu (${when}). Geri yüklensin mi?`, 'Geri yükle', false);
  if (r === 'ok') {
    if (isElectron) for (const m of data.project.media) m.offline = !(m.path && (await native.exists(m.path)));
    else data.project.media.forEach((m) => { m.offline = true; });
    store.load(data.project, data.filePath);
    store.dirty = true;
    updateTitle();
    return true;
  }
  localStorage.removeItem('kurgu.autosave');
  return false;
}

// ---------- dışa aktarma ----------
function exportDialog() {
  player.pause();
  const P = store.project;
  const S = P.settings;
  const dur = store.duration();
  if (dur <= 0) return toast('Dışa aktarılacak bir şey yok — önce zaman çizelgesine klip ekleyin', 'warn', 3500);
  const offline = P.clips.filter((c) => c.type === 'media' && store.media(c.mediaId)?.offline).length;
  if (offline) toast(`${offline} klibin medyası çevrimdışı; bu klipler çıktıda boş görünecek. Medya panelinden yeniden bağlayabilirsiniz.`, 'warn', 6000);
  const hasRange = P.inPoint != null || P.outPoint != null;
  // Varsayılan dosya adı: proje adsızsa en uzun kullanılan videonun adı
  const usage = new Map();
  for (const c of P.clips) {
    const m = c.type === 'media' && store.media(c.mediaId);
    if (m && m.kind === 'video' && store.track(c.trackId)?.kind === 'video') usage.set(m, (usage.get(m) || 0) + c.duration);
  }
  const mainMedia = [...usage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const defName = P.name && P.name !== 'Adsız Proje' ? P.name : mainMedia ? mainMedia.name.replace(/\.[^.]+$/, '') : P.name;
  // Kaynak bit hızı (dosya boyutu biliniyorsa)
  const srcBr = mainMedia?.size && mainMedia.duration ? (mainMedia.size * 8) / mainMedia.duration : null;
  const nameInp = h('input', { class: 'inp', value: defName, 'aria-label': 'Dosya adı' });
  const fmt = h('select', { class: 'inp' }, h('option', { value: 'mp4' }, 'MP4 (H.264 + AAC) — önerilen'), h('option', { value: 'webm' }, 'WebM (VP9 + Opus)'));
  const res = h('select', { class: 'inp' });
  const resOpts = [[1, `Sekans (${S.width}×${S.height})`], [0.5, `Yarım (${Math.round(S.width / 2)}×${Math.round(S.height / 2)})`]];
  if (S.width < 3840 && S.height <= 1080 && S.width >= S.height) resOpts.push([3840 / S.width, `4K (${3840}×${Math.round(S.height * 3840 / S.width)})`]);
  if (S.width > 1280) resOpts.push([1280 / S.width, `720p (1280×${Math.round(S.height * 1280 / S.width)})`]);
  resOpts.forEach(([v, l]) => res.append(h('option', { value: v }, l)));
  const srcTarget = srcBr ? Math.max(3e6, srcBr * 1.3) : null;
  const qual = h('select', { class: 'inp' }, srcTarget && h('option', { value: 'source' }, `Kaynağa yakın (~${(srcTarget / 1e6).toFixed(1)} Mbps)`), h('option', { value: 'high', selected: true }, 'Yüksek'), h('option', { value: 'medium' }, 'Orta'), h('option', { value: 'low' }, 'Düşük (küçük dosya)'), h('option', { value: 'custom' }, 'Özel bit hızı'));
  const mbps = h('input', { class: 'inp', type: 'number', min: 1, max: 200, value: 20, 'aria-label': 'Mbps' });
  const mbpsRow = h('label', { class: 'field hidden' }, h('span', {}, 'Bit hızı (Mbps)'), mbps);
  const range = h('select', { class: 'inp' }, h('option', { value: 'all' }, `Tüm sekans (${formatTC(dur, S.fps)})`));
  if (hasRange) range.append(h('option', { value: 'io', selected: true }, `Giriş–Çıkış (${formatTC((P.outPoint ?? dur) - (P.inPoint ?? 0), S.fps)})`));
  const audioCb = h('input', { type: 'checkbox', checked: true });
  const summary = h('div', { class: 'export-sum' });
  const calc = () => {
    const k = parseFloat(res.value);
    const w = Math.round(S.width * k / 2) * 2, hh = Math.round(S.height * k / 2) * 2;
    const base = (w * hh) / (1920 * 1080) * (S.fps / 30);
    const br = qual.value === 'custom' ? parseFloat(mbps.value) * 1e6 : qual.value === 'source' ? srcTarget * Math.max(0.25, Math.min(1, base)) : { high: 16e6, medium: 9e6, low: 4e6 }[qual.value] * Math.max(0.25, base);
    const [a, b] = range.value === 'io' ? [P.inPoint ?? 0, P.outPoint ?? dur] : [0, dur];
    mbpsRow.classList.toggle('hidden', qual.value !== 'custom');
    return { w, h: hh, bitrate: Math.round(br), a, b };
  };
  const refresh = async () => {
    const c = calc();
    summary.innerHTML = `<div><span>Çıktı</span><b>${c.w}×${c.h} · ${S.fps} fps</b></div><div><span>Süre</span><b>${formatTC(c.b - c.a, S.fps)}</b></div><div><span>Bit hızı</span><b>${(c.bitrate / 1e6).toFixed(1)} Mbps</b></div><div><span>Tahmini boyut</span><b>~${estimateSize(c.bitrate, c.b - c.a)}</b></div><div><span>Kodek</span><b class="codec">denetleniyor…</b></div>`;
    try {
      const cs = await codecSupport(fmt.value, c.w, c.h, c.bitrate);
      const names = { avc: 'H.264', hevc: 'H.265', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis' };
      summary.querySelector('.codec').textContent = cs.video ? `${names[cs.video]} / ${names[cs.audio] || 'ses yok'}` : 'Desteklenmiyor';
      summary.querySelector('.codec').classList.toggle('bad', !cs.video);
    } catch { summary.querySelector('.codec').textContent = '?'; }
  };
  [fmt, res, qual, range].forEach((el) => el.addEventListener('change', refresh));
  mbps.addEventListener('input', refresh);
  nameInp.addEventListener('keydown', (e) => e.stopPropagation());
  const body = h('div', { class: 'form export-form' },
    h('label', { class: 'field' }, h('span', {}, 'Dosya adı'), nameInp),
    h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', {}, 'Biçim'), fmt), h('label', { class: 'field' }, h('span', {}, 'Çözünürlük'), res)),
    h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', {}, 'Kalite'), qual), h('label', { class: 'field' }, h('span', {}, 'Aralık'), range)),
    mbpsRow,
    h('label', { class: 'check-row' }, audioCb, h('span', {}, 'Sesi dahil et')),
    summary);
  refresh();
  modal({
    title: 'Dışa Aktar', body, width: 520,
    buttons: [{ label: 'Vazgeç' }, { label: 'Dışa Aktar', primary: true, action: async () => {
      const c = calc();
      const ext = fmt.value;
      const fname = (nameInp.value.trim() || 'video').replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
      let filePath = null;
      if (isElectron) {
        filePath = await native.saveExportDialog(fname, ext);
        if (!filePath) return false;
      }
      setTimeout(() => runExport({ format: ext, width: c.w, height: c.h, fps: S.fps, bitrate: c.bitrate, rangeStart: c.a, rangeEnd: c.b, filePath, includeAudio: audioCb.checked, fname }), 50);
    } }],
  });
}
async function runExport(opts) {
  const ctrl = new AbortController();
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const pct = h('div', { class: 'progress-pct' }, '0%');
  const info = h('div', { class: 'progress-info' }, 'Hazırlanıyor…');
  const prev = h('canvas', { class: 'export-prev', width: 320, height: Math.round(320 * opts.height / opts.width) });
  const body = h('div', { class: 'export-run' }, prev, h('div', { class: 'progress-row' }, bar, pct), info);
  const dlg = modal({ title: 'Dışa aktarılıyor…', body, width: 460, dismissable: false, buttons: [{ label: 'İptal', danger: true, action: () => { ctrl.abort(); return false; } }] });
  const t0 = performance.now();
  try {
    const res = await exportVideo({ ...opts, signal: ctrl.signal, onProgress: (p) => {
      const v = Math.round(p.progress * 100);
      bar.firstChild.style.width = v + '%';
      pct.textContent = v + '%';
      if (p.phase === 'audio') info.textContent = 'Ses karıştırılıyor…';
      else if (p.phase === 'finalize') info.textContent = 'Dosya tamamlanıyor…';
      else info.textContent = `Kare ${p.frame}/${p.total} · ${p.fps.toFixed(1)} kare/sn · Kalan ~${formatDur(p.eta)}`;
      if (p.preview) prev.getContext('2d').drawImage(p.preview, 0, 0, prev.width, prev.height);
    } });
    dlg.close();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (res.blob) {
      const a = h('a', { href: URL.createObjectURL(res.blob), download: opts.fname });
      a.click();
      toast(`Dışa aktarma tamamlandı (${secs} sn)`, 'ok', 5000);
    } else {
      const done = await confirmDialog('Dışa aktarma tamamlandı', `Video ${secs} saniyede kaydedildi:\n${res.path}`, 'Klasörde göster');
      if (done === 'ok') native.showItem(res.path);
    }
  } catch (e) {
    dlg.close();
    if (e.name === 'AbortError') toast('Dışa aktarma iptal edildi', 'warn');
    else { console.error(e); toast('Dışa aktarma başarısız: ' + e.message, 'err', 8000); }
  }
}

// ---------- ayarlar / yardım ----------
const SHORTCUTS = [
  ['Oynatma', [['Boşluk', 'Oynat / Duraklat'], ['J / K / L', 'Geri / Dur / İleri (tekrar: hızlan)'], ['← / →', 'Kare geri / ileri (Shift: 1 sn)'], ['↑ / ↓', 'Önceki / sonraki kesme noktası'], ['Home / End', 'Başa / sona git'], ['I / O', 'Giriş / çıkış noktası'], ['Alt+X', 'Giriş/çıkışı temizle'], ['Ctrl+L', 'Döngü']]],
  ['Kurgu', [['V', 'Seçim aracı'], ['C', 'Jilet aracı'], ['Ctrl+K', 'Oynatma kafasında böl'], ['Q / W', 'Başı / sonu oynatma kafasına kırp (dalgalı)'], ['Delete', 'Sil'], ['Shift+Delete', 'Dalgalı sil'], [', / .', 'Kaynaktan ekle / üzerine yaz'], ['Alt+sürükle', 'Kopyalayarak taşı'], ['Ctrl+bırak', 'Ekleyerek bırak (sonrakileri kaydırır)'], ['S', 'Yakalamayı aç/kapat'], ['M', 'İşaretçi ekle'], ['Ctrl+R', 'Hız / süre'], ['Shift+E', 'Klibi etkinleştir / devre dışı']]],
  ['Düzen', [['Ctrl+Z', 'Geri al'], ['Ctrl+Shift+Z / Ctrl+Y', 'Yinele'], ['Ctrl+C / X / V', 'Kopyala / Kes / Yapıştır'], ['Ctrl+D', 'Çoğalt'], ['Ctrl+A', 'Tümünü seç'], ['Esc', 'Seçimi kaldır']]],
  ['Görünüm ve Dosya', [['+ / −', 'Zaman çizelgesi yakınlaştır'], ['\\', 'Tümünü sığdır'], ['Ctrl+tekerlek', 'İmleç etrafında yakınlaştır'], ['Alt+1 / 2 / 3', 'Kurgu / Renk / Teslim'], ['`', 'Monitör tam ekran'], ['Ctrl+N / O / S', 'Yeni / Aç / Kaydet'], ['Ctrl+I', 'Medya içe aktar'], ['Ctrl+M', 'Dışa aktar'], ['F12', 'Geliştirici araçları']]],
];
function shortcutsDialog() {
  const body = h('div', { class: 'sc-grid' }, ...SHORTCUTS.map(([g, list]) => h('div', { class: 'sc-group' }, h('h3', {}, g), ...list.map(([k, d]) => h('div', { class: 'sc-row' }, h('kbd', {}, k), h('span', {}, d))))));
  modal({ title: 'Klavye Kısayolları', body, width: 760 });
}
function aboutDialog() {
  modal({ title: 'Kurgu Studio hakkında', width: 420, body: h('div', { class: 'about' },
    h('p', {}, h('b', {}, 'Kurgu Studio 1.0'), ' — Premiere Pro ve DaVinci Resolve\'dan esinlenen, hafif bir masaüstü video editörü.'),
    h('p', { class: 'muted-p' }, 'Electron + saf JavaScript. Kodlama: WebCodecs (donanım hızlandırmalı), kapsayıcı: mediabunny.'),
    h('p', { class: 'muted-p' }, 'Projeler .kurgu dosyası olarak kaydedilir; medya dosyalarına bağlantı tutulur, kopyalanmaz.')) });
}
function setPage(p) {
  if (p === 'deliver') { exportDialog(); return; }
  page = p;
  document.body.className = 'page-' + p;
  $$('.page-tab').forEach((b) => { b.classList.toggle('on', b.dataset.page === p); b.setAttribute('aria-selected', String(b.dataset.page === p)); });
  scopes.active = p === 'color';
  if (p === 'color') followPlayheadClip();
  inspector.setPage(p);
  setTimeout(() => { layoutMonitor(); scopes.update(true); timeline.request(); }, 30);
}
// Renk sayfası: seçim yoksa (veya tek seçili klip oynatma kafasının dışındaysa) kafanın altındaki en üst görüntü klibini seç
function followPlayheadClip() {
  const sel = store.selectedClips();
  if (sel.length > 1) return;
  const t = store.playhead;
  const under = (c) => t >= c.start - EPS && t < c.start + c.duration - EPS;
  if (sel.length === 1 && under(sel[0]) && store.track(sel[0].trackId)?.kind === 'video') return;
  const tracks = store.videoTracks();
  for (let i = tracks.length - 1; i >= 0; i--) {
    const c = store.project.clips.find((x) => x.trackId === tracks[i].id && under(x) && !x.muted);
    if (c) { store.select([c.id, ...(c.linkId ? store.project.clips.filter((x) => x.linkId === c.linkId && x.id !== c.id).map((x) => x.id) : [])]); return; }
  }
}
$$('.page-tab').forEach((b) => b.addEventListener('click', () => setPage(b.dataset.page)));
$$('[data-scope]').forEach((b) => b.addEventListener('click', () => {
  scopes.mode = b.dataset.scope;
  $$('[data-scope]').forEach((x) => x.classList.toggle('on', x === b));
  scopes.update(true);
}));
store.on('change', () => { if (page === 'color' && !player.playing) setTimeout(() => scopes.update(true), 40); });
store.on('playhead', () => { if (page === 'color' && !player.playing) { followPlayheadClip(); setTimeout(() => scopes.update(true), 60); } });

// ---------- menüler ----------
const MENUS = {
  file: () => [
    { label: 'Yeni proje', shortcut: 'Ctrl+N', action: newProj },
    { label: 'Proje aç…', shortcut: 'Ctrl+O', action: () => openProj() },
    ...(isElectron && recents().length ? ['-', ...recents().slice(0, 5).map((p) => ({ label: '↻ ' + projectNameFromPath(p), action: () => openProj(p) }))] : []),
    '-',
    { label: 'Kaydet', shortcut: 'Ctrl+S', action: () => save() },
    { label: 'Farklı kaydet…', shortcut: 'Ctrl+Shift+S', action: () => save(true) },
    '-',
    { label: 'Medya içe aktar…', shortcut: 'Ctrl+I', action: importDialog },
    { label: 'Dışa aktar…', shortcut: 'Ctrl+M', action: exportDialog },
    { label: 'Geçerli kareyi PNG kaydet', action: () => $('#btnSnap').click() },
  ],
  edit: () => [
    { label: 'Geri al', shortcut: 'Ctrl+Z', disabled: !store.undoStack.length, action: undo },
    { label: 'Yinele', shortcut: 'Ctrl+Shift+Z', disabled: !store.redoStack.length, action: redo },
    '-',
    { label: 'Kes', shortcut: 'Ctrl+X', disabled: !store.selection.size, action: cut },
    { label: 'Kopyala', shortcut: 'Ctrl+C', disabled: !store.selection.size, action: copy },
    { label: 'Yapıştır', shortcut: 'Ctrl+V', disabled: !store.clipboard, action: paste },
    { label: 'Çoğalt', shortcut: 'Ctrl+D', disabled: !store.selection.size, action: duplicate },
    { label: 'Sil', shortcut: 'Delete', disabled: !store.selection.size, action: () => deleteSelection(false) },
    { label: 'Dalgalı sil', shortcut: 'Shift+Delete', disabled: !store.selection.size, action: () => deleteSelection(true) },
    '-',
    { label: 'Tümünü seç', shortcut: 'Ctrl+A', action: () => store.select(store.project.clips.map((c) => c.id)) },
    { label: 'Seçimi kaldır', shortcut: 'Esc', action: () => store.select([]) },
  ],
  clip: () => [
    { label: 'Oynatma kafasında böl', shortcut: 'Ctrl+K', action: splitAtPlayhead },
    { label: 'Başı kırp (dalgalı)', shortcut: 'Q', action: () => rippleTrim('start') },
    { label: 'Sonu kırp (dalgalı)', shortcut: 'W', action: () => rippleTrim('end') },
    { label: 'Hız / Süre…', shortcut: 'Ctrl+R', disabled: !store.selection.size, action: speedDialog },
    { label: 'Etkinleştir / devre dışı', shortcut: 'Shift+E', disabled: !store.selection.size, action: toggleClipEnabled },
    '-',
    { label: 'Metin ekle', action: () => addTextAt(store.playhead, TEXT_PRESETS[0].p) },
    { label: 'Renk katmanı ekle', action: () => addColorAt(store.playhead, GEN_PRESETS[0].p) },
    { label: 'İşaretçi ekle', shortcut: 'M', action: () => addMarker() },
    '-',
    { label: 'Yeni sekans…', action: newSequence },
    { label: 'Seçimi iç içe sekansa dönüştür…', disabled: !store.selection.size, action: nestSelection },
    '-',
    { label: 'Video izi ekle', action: () => store.transact('İz ekle', () => store.addTrack('video')) },
    { label: 'Ses izi ekle', action: () => store.transact('İz ekle', () => store.addTrack('audio')) },
  ],
  tools: () => [
    { label: 'Normalleştir: tepe -1 dB', disabled: !store.selection.size, action: () => normalizeSelected('peak') },
    { label: 'Normalleştir: ses yüksekliği -14 LUFS', disabled: !store.selection.size, action: () => normalizeSelected('lufs') },
    { label: 'Otomatik ducking (müziği kıs)…', action: duckDialog },
    '-',
    { label: 'Tüm videolar için proxy oluştur', action: () => createProxies(store.project.media.filter((m) => m.kind === 'video' && !m.proxy)) },
    { label: (proxyState.use ? '✓ ' : '') + 'Önizlemede proxy kullan', action: () => { setUseProxy(!proxyState.use); updateProxyBtn(); } },
    '-',
    { label: 'Sessizlikleri kes…', disabled: !store.selection.size, action: silenceDialog },
    '-',
    { label: 'Otomatik altyazı (Whisper)…', action: transcribeDialog },
    { label: 'Altyazıyı SRT olarak dışa aktar…', action: exportSrt },
    { label: 'SRT altyazı içe aktar…', action: importSrtDialog },
  ],
  view: () => [
    { label: 'Kurgu sayfası', shortcut: 'Alt+1', action: () => setPage('edit') },
    { label: 'Renk sayfası', shortcut: 'Alt+2', action: () => setPage('color') },
    '-',
    { label: 'Zaman çizelgesini sığdır', shortcut: '\\', action: () => timeline.zoomToFit() },
    { label: 'Monitör tam ekran', shortcut: '`', action: toggleFullscreen },
    { label: 'Güvenli alan kılavuzları', action: () => $('#btnSafe').click() },
    { label: 'Panel düzenini sıfırla', action: resetLayout },
  ],
  help: () => [
    { label: 'Klavye kısayolları', shortcut: '?', action: shortcutsDialog },
    { label: 'Hakkında', action: aboutDialog },
  ],
};
$$('.menu-btn').forEach((b) => b.addEventListener('click', () => {
  const r = b.getBoundingClientRect();
  const m = contextMenu(r.left, r.bottom + 4, MENUS[b.dataset.menu]());
  m.classList.add('dropdown');
}));
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnExport').onclick = exportDialog;
function undo() { const l = store.undo(); if (l) status('Geri alındı: ' + l); updateUndoButtons(); }
function redo() { const l = store.redo(); if (l) status('Yinelendi: ' + l); updateUndoButtons(); }

// ---------- panel boyutlandırma ----------
const LAYOUT_DEF = { left: 300, right: 330, timeline: 330 };
let layout = { ...LAYOUT_DEF, ...JSON.parse(localStorage.getItem('kurgu.layout') || '{}') };
function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--left-w', layout.left + 'px');
  root.setProperty('--right-w', layout.right + 'px');
  root.setProperty('--tl-h', layout.timeline + 'px');
}
function resetLayout() { layout = { ...LAYOUT_DEF }; localStorage.setItem('kurgu.layout', JSON.stringify(layout)); applyLayout(); }
applyLayout();
$$('.resizer').forEach((r) => r.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  r.setPointerCapture(e.pointerId);
  r.classList.add('active');
  const key = r.dataset.resize;
  const start = { x: e.clientX, y: e.clientY, v: layout[key] };
  const mv = (ev) => {
    if (key === 'left') layout.left = clamp(start.v + ev.clientX - start.x, 200, 560);
    if (key === 'right') layout.right = clamp(start.v - (ev.clientX - start.x), 260, 560);
    if (key === 'timeline') layout.timeline = clamp(start.v - (ev.clientY - start.y), 160, innerHeight - 280);
    applyLayout();
  };
  const up = () => { r.classList.remove('active'); r.removeEventListener('pointermove', mv); r.removeEventListener('pointerup', up); localStorage.setItem('kurgu.layout', JSON.stringify(layout)); };
  r.addEventListener('pointermove', mv);
  r.addEventListener('pointerup', up);
}));
// çift tık: panel boyutunu varsayılana döndür
$$('.resizer').forEach((r) => r.addEventListener('dblclick', () => { const key = r.dataset.resize; layout[key] = LAYOUT_DEF[key]; applyLayout(); localStorage.setItem('kurgu.layout', JSON.stringify(layout)); }));

// ---------- klavye ----------
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  if (document.querySelector('.modal-backdrop')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let handled = true;
  if (ctrl && k === 'z' && !e.shiftKey) undo();
  else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
  else if (ctrl && k === 's') save(e.shiftKey);
  else if (ctrl && k === 'o') openProj();
  else if (ctrl && k === 'n') newProj();
  else if (ctrl && k === 'i') importDialog();
  else if (ctrl && k === 'm') exportDialog();
  else if (ctrl && k === 'k') splitAtPlayhead();
  else if (ctrl && k === 'c') copy();
  else if (ctrl && k === 'x') cut();
  else if (ctrl && k === 'v') paste();
  else if (ctrl && k === 'd') duplicate();
  else if (ctrl && k === 'r') speedDialog();
  else if (ctrl && k === 'l' && e.shiftKey) toggleLinked();
  else if (ctrl && k === 'l') $('#tLoop').click();
  else if (ctrl && k === 'a') store.select(store.project.clips.map((c) => c.id));
  else if (e.altKey && k === '1') setPage('edit');
  else if (e.altKey && k === '2') setPage('color');
  else if (e.altKey && k === '3') setPage('deliver');
  else if (e.altKey && k === 'x') store.transact('Giriş/Çıkış temizle', (P) => { P.inPoint = null; P.outPoint = null; });
  else if (ctrl || e.altKey) handled = false;
  else if (e.key === ' ') togglePlay();
  else if (k === 'k') { player.pause(); srcVideo.pause(); }
  else if (k === 'l') { if (monMode === 'source') srcVideo.play(); else player.shuttle(1); }
  else if (k === 'j') { if (monMode === 'source') srcVideo.currentTime -= 1; else player.shuttle(-1); }
  else if (e.key === 'ArrowLeft') stepFrames(e.shiftKey ? -store.fps : -1);
  else if (e.key === 'ArrowRight') stepFrames(e.shiftKey ? store.fps : 1);
  else if (e.key === 'ArrowUp') jumpEdit(-1);
  else if (e.key === 'ArrowDown') jumpEdit(1);
  else if (e.key === 'Home') goStart();
  else if (e.key === 'End') goEnd();
  else if (k === 'i') markIn();
  else if (k === 'o') markOut();
  else if (k === 'v') setTool('select');
  else if (k === 'c') setTool('razor');
  else if (k === 's') toggleSnapping();
  else if (k === 'm') addMarker();
  else if (k === 'q') rippleTrim('start');
  else if (k === 'w') rippleTrim('end');
  else if (k === 'e' && e.shiftKey) toggleClipEnabled();
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection(e.shiftKey);
  else if (e.key === 'Escape') { if (timeline.op) { store.cancel(); timeline.op = null; timeline.request(); } else store.select([]); }
  else if (e.key === '+' || e.key === '=') timeline.setZoom(timeline.pps * 1.4);
  else if (e.key === '-') timeline.setZoom(timeline.pps / 1.4);
  else if (e.key === '\\') timeline.zoomToFit();
  else if (e.key === '`') toggleFullscreen();
  else if (e.key === '?') shortcutsDialog();
  else if (e.key === ',' && sourceMedia) placeAtPlayhead(store.media(sourceMedia.id), 'insert');
  else if (e.key === '.' && sourceMedia) placeAtPlayhead(store.media(sourceMedia.id), 'overwrite');
  else handled = false;
  if (handled) e.preventDefault();
});
// fareyle tıklanan düğmeler odağı tutmasın (Boşluk tuşu düğmeyi yeniden tetiklemesin)
document.addEventListener('pointerup', (e) => {
  const b = e.target.closest?.('button, input[type=range], input[type=checkbox]');
  if (b && !b.closest('.modal, .ctx-menu')) setTimeout(() => b.blur(), 0);
});
// ilk klip eklendiğinde zaman çizelgesini sığdır
let hadClips = false;
store.on('change', () => {
  const has = store.project.clips.length > 0;
  if (has && !hadClips) setTimeout(() => timeline.zoomToFit(), 30);
  hadClips = has;
});
// Electron: kapanırken kaydetme sorusu
if (isElectron) native.onCloseRequest(async () => { if (await maybeSave()) native.confirmClose(); });
else window.addEventListener('beforeunload', (e) => { if (store.dirty && store.project.clips.length) { e.preventDefault(); e.returnValue = ''; } });

// dışarıdan erişim (zaman çizelgesi bağlam menüsü için)
window.kurgu = { importFiles, splitAtPlayhead, cut, copy, paste, duplicate, deleteSelection, speedDialog, addMarker, toggleClipEnabled, store, player, timeline };

// monitörden renk seçme (chroma key)
inspector.pickColor = (cb) => {
  if (monMode !== 'program') setMonitor('program');
  toast('Monitörde anahtar rengine tıklayın (Esc: vazgeç)', 'info', 3000);
  frame.classList.add('picking');
  const done = () => { frame.classList.remove('picking'); frame.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  const onDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = programCanvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * programCanvas.width), y = Math.floor(((e.clientY - r.top) / r.height) * programCanvas.height);
    const d = programCanvas.getContext('2d').getImageData(clamp(x - 2, 0, programCanvas.width - 5), clamp(y - 2, 0, programCanvas.height - 5), 5, 5).data;
    let rr = 0, gg = 0, bb = 0;
    for (let i = 0; i < d.length; i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; }
    const n = d.length / 4, hex = '#' + [rr, gg, bb].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('');
    done();
    cb(hex);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
  frame.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
};

// GPU sıfırlanırsa (sürücü zaman aşımı, uykudan dönüş) GPU tuvallerinin içeriği silinir: yeniden çiz
for (const c of [$('#programCanvas'), $('.tl-canvas'), $('.tl-ruler'), $('#scopeCanvas')]) {
  c?.addEventListener('contextrestored', () => { player.requestRender(); timeline.request(); scopes.update(true); });
}

buildSeqTabs($('#seqTabs'));
function updateProxyBtn() {
  const b = $('#btnProxy');
  const any = store.project.media.some((m) => m.proxy);
  b.classList.toggle('on', proxyState.use && any);
  b.setAttribute('aria-pressed', String(proxyState.use));
  b.title = any ? (proxyState.use ? 'Proxy kullanılıyor (tıkla: orijinale geç)' : 'Orijinal medya (tıkla: proxy kullan)') : 'Proxy yok — Medya panelinde bir videoya sağ tıklayıp "Proxy oluştur" deyin';
}
$('#btnProxy').onclick = () => { setUseProxy(!proxyState.use); updateProxyBtn(); };
store.on('change', (d) => { if (!d?.live) updateProxyBtn(); });
store.on('load', async () => { await validateProxies(); updateProxyBtn(); });
updateProxyBtn();
store.on('open-sequence', (id) => openSequence(id));

// ---------- başlat ----------
buildMediaPanel();
buildEffectsPanel();
setTool('select');
updateTitle();
updateTimecodes();
updateUndoButtons();
layoutMonitor();
setTimeout(() => timeline.zoomToFit(), 50);
(async () => {
  const pending = isElectron ? await native.pendingOpen() : null;
  if (pending) return openProj(pending);
  await checkRecovery();
})();
