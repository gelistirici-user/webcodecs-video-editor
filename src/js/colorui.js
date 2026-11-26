// Renk sayfası denetimleri: renk çarkları, eğri düzenleyici, LUT, chroma key
import { store } from './store.js';
import { h, clamp, uid } from './utils.js';
import { toast } from './ui.js';
import { DEFAULT_GRADE, curveTable, parseCube } from './fxgl.js';

export const ensureGrade = (c) => {
  if (!c.grade) c.grade = DEFAULT_GRADE();
  const d = DEFAULT_GRADE();
  for (const k of Object.keys(d)) if (c.grade[k] === undefined) c.grade[k] = d[k];
  return c.grade;
};

// ---------- renk çarkı ----------
// Diskteki konum -> sıfır ortalamalı RGB kayması
const toRgb = (x, y) => {
  const r = Math.hypot(x, y), a = Math.atan2(-y, x);
  const k = r * 0.35;
  return [k * Math.cos(a), k * Math.cos(a - (2 * Math.PI) / 3), k * Math.cos(a + (2 * Math.PI) / 3)];
};
const fromRgb = (v) => {
  // toRgb'nin tersi (en küçük kareler)
  const x = (2 / 3) * (v[0] - 0.5 * v[1] - 0.5 * v[2]) / 0.35;
  const y = -((v[1] - v[2]) * Math.sqrt(3) / 3) / 0.35;
  return [x, y];
};

export function wheel(ins, parent, clip, key, label) {
  const S = 112;
  const cv = h('canvas', { class: 'wheel', width: S * 2, height: S * 2, style: { width: S + 'px', height: S + 'px' }, title: `${label}: sürükle = renk, çift tık = sıfırla` });
  const ctx = cv.getContext('2d');
  const val = () => ensureGrade(clip)[key];
  const draw = () => {
    const v = val();
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const R = S / 2 - 4;
    const grad = ctx.createConicGradient(0, S / 2, S / 2);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${-i * 60},70%,45%)`);
    ctx.beginPath(); ctx.arc(S / 2, S / 2, R, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
    const rg = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, R);
    rg.addColorStop(0, 'rgba(40,42,48,1)'); rg.addColorStop(1, 'rgba(40,42,48,0.15)');
    ctx.fillStyle = rg; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(S / 2 - 6, S / 2); ctx.lineTo(S / 2 + 6, S / 2); ctx.moveTo(S / 2, S / 2 - 6); ctx.lineTo(S / 2, S / 2 + 6); ctx.stroke();
    const [x, y] = fromRgb(v);
    ctx.beginPath(); ctx.arc(S / 2 + x * R, S / 2 + y * R, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke();
  };
  const setFrom = (e) => {
    const r = cv.getBoundingClientRect();
    const sc = r.width / S, R = (S / 2 - 4) * sc;
    let x = (e.clientX - r.left - r.width / 2) / R, y = (e.clientY - r.top - r.height / 2) / R;
    const d = Math.hypot(x, y); if (d > 1) { x /= d; y /= d; }
    if (e.shiftKey) { x *= 0.25; y *= 0.25; }
    const [cr, cg, cb] = toRgb(x, y);
    const v = val(); v[0] = cr; v[1] = cg; v[2] = cb;
  };
  cv.addEventListener('pointerdown', (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch { /* */ }
    ins.start();
    ins.live(() => setFrom(e)); draw();
    const mv = (ev) => { ins.live(() => setFrom(ev)); draw(); };
    const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); ins.end(label); };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
  });
  cv.addEventListener('dblclick', () => { ins.once(label + ' sıfırla', () => { const v = val(); v[0] = v[1] = v[2] = 0; }); draw(); });
  const master = h('input', { type: 'range', class: 'slider', min: -100, max: 100, step: 1, value: Math.round(val()[3] * 100), 'aria-label': label + ' parlaklık', title: 'Parlaklık (çift tık: sıfırla)' });
  master.addEventListener('pointerdown', () => ins.start());
  master.addEventListener('input', () => ins.live(() => { val()[3] = +master.value / 100; }));
  master.addEventListener('change', () => ins.end(label));
  master.addEventListener('dblclick', () => { ins.once(label, () => { val()[3] = 0; }); master.value = 0; });
  master.addEventListener('keydown', (e) => e.stopPropagation());
  ins.refreshers.push(() => { draw(); if (document.activeElement !== master) master.value = Math.round(val()[3] * 100); });
  draw();
  parent.append(h('div', { class: 'wheel-box' }, h('div', { class: 'wheel-l' }, label), cv, master));
}

// ---------- eğri düzenleyici ----------
const CH = { m: ['Ana', '#e8e8e8'], r: ['K', '#ff5a5a'], g: ['Y', '#4cdc6a'], b: ['M', '#5a8cff'] };
export function curveEditor(ins, parent, clip) {
  const W = 240, H = 180;
  let ch = 'm';
  const cv = h('canvas', { class: 'curve', width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' }, title: 'Tıkla: nokta ekle · Sürükle: taşı · Çift tık / sağ tık: noktayı sil' });
  const ctx = cv.getContext('2d');
  const pts = () => ensureGrade(clip).curves[ch];
  const draw = () => {
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.fillStyle = '#0d0e11'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo((W * i) / 4, 0); ctx.lineTo((W * i) / 4, H); ctx.moveTo(0, (H * i) / 4); ctx.lineTo(W, (H * i) / 4); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke();
    // diğer kanallar soluk
    for (const k of ['r', 'g', 'b', 'm']) {
      const t = curveTable(ensureGrade(clip).curves[k], 128);
      ctx.strokeStyle = CH[k][1]; ctx.globalAlpha = k === ch ? 1 : 0.22; ctx.lineWidth = k === ch ? 1.6 : 1;
      ctx.beginPath(); t.forEach((v, i) => { const x = (i / 127) * W, y = H - v * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const [x, y] of pts()) { ctx.beginPath(); ctx.arc(x * W, H - y * H, 4, 0, Math.PI * 2); ctx.fillStyle = CH[ch][1]; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke(); }
  };
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)]; };
  const near = (p) => pts().findIndex(([x, y]) => Math.hypot((x - p[0]) * W, (y - p[1]) * H) < 8);
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = pos(e);
    let i = near(p);
    ins.start();
    if (i < 0) { ins.live(() => { pts().push(p); pts().sort((a, b) => a[0] - b[0]); }); i = near(p); }
    try { cv.setPointerCapture(e.pointerId); } catch { /* */ }
    const list = pts();
    const ref = list[i];
    const mv = (ev) => {
      const q = pos(ev);
      const L = pts(); const idx = L.indexOf(ref);
      const lo = idx > 0 ? L[idx - 1][0] + 0.01 : 0, hi = idx < L.length - 1 ? L[idx + 1][0] - 0.01 : 1;
      ins.live(() => { ref[0] = idx === 0 ? 0 : idx === L.length - 1 ? 1 : clamp(q[0], lo, hi); ref[1] = q[1]; });
      draw();
    };
    const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); ins.end('Eğri'); };
    cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
    draw();
  });
  const del = (e) => {
    e.preventDefault();
    const i = near(pos(e));
    if (i <= 0 || i >= pts().length - 1) return;
    ins.once('Eğri noktası sil', () => pts().splice(i, 1)); draw();
  };
  cv.addEventListener('dblclick', del);
  cv.addEventListener('contextmenu', del);
  const tabs = h('div', { class: 'seg' }, ...Object.entries(CH).map(([k, [l, col]]) => {
    const b = h('button', { class: 'seg-btn' + (k === ch ? ' on' : ''), style: { color: col } }, l);
    b.onclick = () => { ch = k; tabs.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
    return b;
  }));
  const reset = h('button', { class: 'btn sm', onclick: () => { ins.once('Eğriyi sıfırla', () => { ensureGrade(clip).curves[ch] = [[0, 0], [1, 1]]; }); draw(); } }, 'Kanalı sıfırla');
  ins.refreshers.push(draw);
  draw();
  parent.append(h('div', { class: 'curve-head' }, tabs, reset), cv);
}

// ---------- LUT ----------
export function lutControls(ins, parent, clip) {
  const P = store.project;
  const g = ensureGrade(clip);
  const name = h('span', { class: 'lut-name' });
  const upd = () => { const l = (P.luts || []).find((x) => x.id === ensureGrade(clip).lut); name.textContent = l ? `${l.name} (${l.size}³)` : 'LUT yok'; };
  const load = h('button', { class: 'btn sm' }, '.cube yükle…');
  load.onclick = () => {
    const inp = h('input', { type: 'file', accept: '.cube' });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const { size, data } = parseCube(await f.text());
        const id = uid('lut');
        ins.once('LUT yükle', () => { if (!P.luts) P.luts = []; P.luts.push({ id, name: f.name.replace(/\.cube$/i, ''), size, data }); ensureGrade(clip).lut = id; });
        upd();
        toast(`LUT yüklendi: ${f.name}`, 'ok');
      } catch (e) { toast(e.message, 'err', 4000); }
    };
    inp.click();
  };
  const sel = h('select', { class: 'inp sm', 'aria-label': 'Projedeki LUT' });
  const fill = () => { sel.innerHTML = ''; sel.append(h('option', { value: '' }, '— Yok —'), ...(P.luts || []).map((l) => h('option', { value: l.id }, l.name))); sel.value = ensureGrade(clip).lut || ''; };
  sel.onchange = () => { ins.once('LUT seç', () => { ensureGrade(clip).lut = sel.value || null; }); upd(); };
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  ins.refreshers.push(() => { upd(); fill(); });
  upd(); fill();
  parent.append(h('div', { class: 'prow two' }, h('label', { class: 'plabel' }, 'LUT'), sel), h('div', { class: 'btn-row' }, load, name));
  ins.numRow(parent, 'Yoğunluk', { get: () => g.lutMix ?? 1, set: (v) => { ensureGrade(clip).lutMix = clamp(v, 0, 1); }, min: 0, max: 1, step: 1, suffix: '%', def: 1, display: (v) => v * 100, parse: (v) => v / 100, history: 'LUT yoğunluğu' });
}

// ---------- chroma key ----------
export function keyControls(ins, parent, clip, pickColor) {
  const K = () => ensureGrade(clip).key;
  ins.toggleRow(parent, 'Chroma key', () => !!clip.grade?.key?.on, (v) => { K().on = v; });
  const col = h('input', { type: 'color', class: 'color-inp', value: clip.grade?.key?.color || '#00ff00', 'aria-label': 'Anahtar rengi' });
  col.addEventListener('focus', () => ins.start());
  col.addEventListener('input', () => ins.live(() => { K().color = col.value; }));
  col.addEventListener('change', () => ins.end('Anahtar rengi'));
  const pick = h('button', { class: 'btn sm', title: 'Monitörde bir noktaya tıklayarak renk seçin' }, 'Monitörden seç');
  pick.onclick = () => pickColor((hex) => { ins.once('Anahtar rengi', () => { K().color = hex; K().on = true; }); col.value = hex; });
  ins.refreshers.push(() => { col.value = clip.grade?.key?.color || '#00ff00'; });
  parent.append(h('div', { class: 'prow two' }, h('label', { class: 'plabel' }, 'Renk'), h('div', { class: 'btn-row tight' }, col, pick)));
  const pct = { min: 0, max: 1, step: 1, suffix: '%', display: (v) => v * 100, parse: (v) => v / 100 };
  ins.numRow(parent, 'Benzerlik', { ...pct, def: 0.35, get: () => clip.grade?.key?.sim ?? 0.35, set: (v) => { K().sim = clamp(v, 0, 1); }, history: 'Anahtar benzerliği' });
  ins.numRow(parent, 'Yumuşaklık', { ...pct, def: 0.1, get: () => clip.grade?.key?.smooth ?? 0.1, set: (v) => { K().smooth = clamp(v, 0, 1); }, history: 'Anahtar yumuşaklığı' });
  ins.numRow(parent, 'Taşma bast.', { ...pct, def: 0.6, get: () => clip.grade?.key?.spill ?? 0.6, set: (v) => { K().spill = clamp(v, 0, 1); }, history: 'Taşma bastırma' });
}
