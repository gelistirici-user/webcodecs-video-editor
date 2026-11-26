// Denetçi: maske, hareket takibi ve görüntü sabitleme bölümleri
import { store } from './store.js';
import { h, clamp } from './utils.js';
import { toast, modal } from './ui.js';
import { analyzeStabilization, trackRegion } from './analysis.js';
import { upsertKf, valueAt, animated } from './keyframes.js';

export const DEFAULT_MASK = () => {
  const S = store.project.settings;
  return { on: false, shape: 'ellipse', x: 0, y: 0, w: Math.round(S.width * 0.4), h: Math.round(S.height * 0.55), feather: 40, invert: false };
};
const M = (c) => c.mask || (c.mask = DEFAULT_MASK());

// klibin çizim boyutu (sekans pikseli, ölçek 1)
function drawnSize(c) {
  const S = store.project.settings;
  const m = c.type === 'media' ? store.media(c.mediaId) : null;
  if (!m || !m.width || !m.height || c.transform.fit === 'fill') return { w: S.width, h: S.height };
  const f = c.transform.fit === 'cover' ? Math.max(S.width / m.width, S.height / m.height) : Math.min(S.width / m.width, S.height / m.height);
  return { w: m.width * f, h: m.height * f };
}

// Uzun işlemler için ilerleme penceresi
function progressModal(title) {
  const ctrl = new AbortController();
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const pct = h('div', { class: 'progress-pct' }, '0%');
  const dlg = modal({ title, body: h('div', { class: 'export-run' }, h('div', { class: 'progress-row' }, bar, pct)), width: 420, dismissable: false, buttons: [{ label: 'İptal', danger: true, action: () => { ctrl.abort(); return true; } }] });
  return { signal: ctrl.signal, set: (v) => { bar.firstChild.style.width = clamp(v, 0, 1) * 100 + '%'; pct.textContent = Math.round(v * 100) + '%'; }, close: () => dlg.close() };
}

export function maskSection(ins, b, c) {
  ins.toggleRow(b, 'Maske', () => !!c.mask?.on, (v) => { M(c).on = v; });
  ins.selectRow(b, 'Şekil', { ellipse: 'Elips', rect: 'Dikdörtgen' }, () => c.mask?.shape || 'ellipse', (v) => { M(c).shape = v; }, 'Maske şekli');
  const S = store.project.settings;
  const kf = (p) => ({ clip: c, path: p });
  const ensure = (fn) => (v) => { M(c); fn(v); };
  ins.numRow(b, 'Merkez X', { kf: kf('mask.x'), get: () => c.mask?.x ?? 0, set: ensure((v) => { c.mask.x = v; }), min: -S.width, max: S.width, step: 1, def: 0, history: 'Maske' });
  ins.numRow(b, 'Merkez Y', { kf: kf('mask.y'), get: () => c.mask?.y ?? 0, set: ensure((v) => { c.mask.y = v; }), min: -S.height, max: S.height, step: 1, def: 0, history: 'Maske' });
  ins.numRow(b, 'Genişlik', { kf: kf('mask.w'), get: () => c.mask?.w ?? S.width * 0.4, set: ensure((v) => { c.mask.w = Math.max(4, v); }), min: 4, max: S.width * 2, step: 1, history: 'Maske' });
  ins.numRow(b, 'Yükseklik', { kf: kf('mask.h'), get: () => c.mask?.h ?? S.height * 0.55, set: ensure((v) => { c.mask.h = Math.max(4, v); }), min: 4, max: S.height * 2, step: 1, history: 'Maske' });
  ins.numRow(b, 'Yumuşatma', { get: () => c.mask?.feather ?? 40, set: ensure((v) => { c.mask.feather = clamp(v, 0, 400); }), min: 0, max: 300, step: 1, suffix: ' px', def: 40, history: 'Maske yumuşatma' });
  ins.toggleRow(b, 'Ters çevir', () => !!c.mask?.invert, (v) => { M(c).invert = v; });
  if (c.type === 'media' && store.media(c.mediaId)?.kind === 'video') {
    b.append(h('div', { class: 'sub-head' }, 'Hareket takibi'));
    const trackBtn = h('button', { class: 'btn sm', title: 'Maskenin altındaki bölgeyi oynatma kafasından klibin sonuna kadar izler' }, 'Maskeyi takip et ▶');
    trackBtn.onclick = () => runTrack(ins, c);
    const applyBtn = h('button', { class: 'btn sm', title: 'Takip hareketini üstteki izde bu aralıktaki klibe (ör. başlık) konum anahtar kareleri olarak aktarır' }, 'Hareketi üstteki klibe aktar');
    applyBtn.onclick = () => applyTrackToAbove(c);
    b.append(h('div', { class: 'btn-row' }, trackBtn, applyBtn), h('p', { class: 'hint' }, 'Maskeyi izlenecek nesnenin üzerine, nesneyle yaklaşık aynı boyutta yerleştirin (monitörde sürükleyebilirsiniz), sonra "takip et" deyin. Büyük kutu arka planı izleyebilir.'));
  }
}

async function runTrack(ins, c) {
  if (!c.mask?.on) return toast('Önce maskeyi açıp izlenecek nesnenin üzerine yerleştirin', 'warn', 3500);
  const t0 = clamp(store.playhead, c.start, c.start + c.duration - 0.05), t1 = c.start + c.duration - 1e-3;
  const A = animated(c, t0);
  const d = drawnSize(c);
  const box = { cx: (A.mask.x + d.w / 2) / d.w, cy: (A.mask.y + d.h / 2) / d.h, w: A.mask.w / d.w, h: A.mask.h / d.h };
  if (box.cx < 0 || box.cx > 1 || box.cy < 0 || box.cy > 1) return toast('Maske görüntünün dışında', 'warn');
  const pm = progressModal('Hareket takip ediliyor…');
  try {
    const path = await trackRegion(c, t0, t1, { ...box, w: Math.min(box.w, 0.5), h: Math.min(box.h, 0.5) }, { onProgress: pm.set, signal: pm.signal });
    pm.close();
    store.transact('Maske takibi', () => {
      const k = store.clip(c.id);
      if (!k.kf) k.kf = {};
      // mevcut anahtar kareleri takip aralığında değiştir
      for (const p of ['mask.x', 'mask.y']) if (k.kf[p]) k.kf[p] = k.kf[p].filter((q) => q.t < t0 - k.start + k.in / k.speed - 1e-3);
      path.forEach((pt, i) => {
        if (i % 2 && i !== path.length - 1) return;
        upsertKf(k, 'mask.x', pt.t, Math.round(pt.cx * d.w - d.w / 2), 'linear');
        upsertKf(k, 'mask.y', pt.t, Math.round(pt.cy * d.h - d.h / 2), 'linear');
      });
    });
    toast(`Takip tamamlandı: ${path.length} kare`, 'ok');
  } catch (e) {
    pm.close();
    if (e.name !== 'AbortError') toast('Takip başarısız: ' + e.message, 'err', 4000);
  }
}

function applyTrackToAbove(c) {
  if (!c.kf?.['mask.x']?.length) return toast('Önce maskeyi takip edin', 'warn');
  const vts = store.videoTracks();
  const idx = vts.findIndex((t) => t.id === c.trackId);
  const above = vts.slice(idx + 1).flatMap((t) => store.clipsOn(t.id)).find((k) => k.start < c.start + c.duration && k.start + k.duration > c.start);
  if (!above) return toast('Üstteki izlerde bu aralıkta klip yok (ör. bir başlık ekleyin)', 'warn', 3500);
  const sc = c.transform.scale;
  const list = c.kf['mask.x'];
  const t0 = list[0].t;
  const tStart = t0 + c.start - c.in / c.speed;
  const base = { x: valueAt(above, 'transform.x', tStart), y: valueAt(above, 'transform.y', tStart) };
  const mx0 = valueAt(c, 'mask.x', tStart), my0 = valueAt(c, 'mask.y', tStart);
  store.transact('Takibi aktar', () => {
    const k = store.clip(above.id);
    if (k.kf) { delete k.kf['transform.x']; delete k.kf['transform.y']; }
    for (const q of list) {
      const t = q.t + c.start - c.in / c.speed;
      if (t < k.start || t > k.start + k.duration) continue;
      upsertKf(k, 'transform.x', t, Math.round(base.x + (valueAt(c, 'mask.x', t) - mx0) * sc), 'linear');
      upsertKf(k, 'transform.y', t, Math.round(base.y + (valueAt(c, 'mask.y', t) - my0) * sc), 'linear');
    }
  });
  toast('Hareket üstteki klibe aktarıldı', 'ok');
}

export function stabSection(ins, b, c) {
  const status = h('div', { class: 'stab-status' });
  const upd = () => { status.textContent = c.stab?.dx?.length ? `Analiz edildi (${c.stab.dx.length} kare) · yakınlaştırma ${Math.round((c.stab.zoom - 1) * 100)}%` : 'Henüz analiz edilmedi'; };
  upd(); ins.refreshers.push(upd);
  let smooth = c.stab?.smoothness ?? 0.5;
  const sm = h('input', { type: 'range', class: 'slider', min: 0, max: 100, value: Math.round(smooth * 100), 'aria-label': 'Yumuşaklık' });
  sm.oninput = () => { smooth = +sm.value / 100; };
  sm.addEventListener('keydown', (e) => e.stopPropagation());
  const go = h('button', { class: 'btn sm primary' }, 'Analiz et ve sabitle');
  go.onclick = async () => {
    const pm = progressModal('Titreşim analiz ediliyor…');
    try {
      const st = await analyzeStabilization(c, { smoothness: smooth, onProgress: pm.set, signal: pm.signal });
      pm.close();
      ins.once('Sabitle', () => { store.clip(c.id).stab = st; });
      upd();
      toast('Sabitleme uygulandı', 'ok');
    } catch (e) { pm.close(); if (e.name !== 'AbortError') toast('Analiz başarısız: ' + e.message, 'err', 4000); }
  };
  b.append(h('div', { class: 'prow two' }, h('label', { class: 'plabel' }, 'Yumuşaklık'), sm), h('div', { class: 'btn-row' }, go), status);
  ins.toggleRow(b, 'Sabitleme açık', () => !!c.stab?.on, (v) => { if (c.stab) c.stab.on = v; });
  ins.numRow(b, 'Yakınlaştırma', { get: () => c.stab?.zoom ?? 1, set: (v) => { if (c.stab) c.stab.zoom = clamp(v, 1, 1.5); }, min: 1, max: 1.5, step: 0.5, suffix: '%', def: 1.05, display: (v) => Math.round((v - 1) * 1000) / 10, parse: (v) => 1 + v / 100, history: 'Sabitleme yakınlaştırma' });
}
