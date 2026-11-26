// Anahtar kare (keyframe) animasyonu
// clip.kf = { 'transform.x': [{ t, v, e }], 'volume': [...] }
// t: klibin kaynak kökenine göre zaman (bölme/kırpmada kayıt yerinde kalır)
import { clamp, smooth } from './utils.js';

export const KF_PROPS = {
  'transform.x': 'Konum X', 'transform.y': 'Konum Y', 'transform.scale': 'Ölçek', 'transform.rotation': 'Döndürme',
  'transform.opacity': 'Opaklık', 'volume': 'Ses seviyesi',
  'color.brightness': 'Parlaklık', 'color.contrast': 'Kontrast', 'color.saturation': 'Doygunluk',
  'color.temperature': 'Sıcaklık', 'color.tint': 'Ton', 'color.hue': 'Renk tonu', 'color.vignette': 'Vinyet', 'color.blur': 'Bulanıklık',
  'mask.x': 'Maske X', 'mask.y': 'Maske Y', 'mask.w': 'Maske genişlik', 'mask.h': 'Maske yükseklik',
};
export const EASINGS = { linear: 'Doğrusal', ease: 'Yumuşak', hold: 'Sabit (basamak)' };

export const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export function setPath(o, p, v) {
  const ks = p.split('.');
  let a = o;
  for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null) a[ks[i]] = {}; a = a[ks[i]]; }
  a[ks[ks.length - 1]] = v;
}

// zaman çizelgesi zamanı -> anahtar kare zamanı
export const kfOrigin = (c) => c.start - (c.in || 0) / (c.speed || 1);
export const toKfTime = (c, t) => t - kfOrigin(c);
export const fromKfTime = (c, kt) => kt + kfOrigin(c);

export const hasKf = (c, p) => !!(c.kf && c.kf[p] && c.kf[p].length);
export const anyKf = (c) => !!(c.kf && Object.values(c.kf).some((l) => l && l.length));

export function evalList(list, kt) {
  if (kt <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (kt >= last.t) return last.v;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (kt >= a.t && kt <= b.t) {
      if (a.e === 'hold') return a.v;
      let q = (kt - a.t) / Math.max(1e-6, b.t - a.t);
      if (a.e === 'ease') q = smooth(q);
      return a.v + (b.v - a.v) * q;
    }
  }
  return last.v;
}

// Bir özelliğin t anındaki değeri
export function valueAt(c, p, t) {
  if (hasKf(c, p)) return evalList(c.kf[p], toKfTime(c, t));
  return getPath(c, p);
}

// Animasyonlu değerleri uygulanmış hafif bir kopya (çizim için)
export function animated(c, t) {
  if (!anyKf(c)) return c;
  const out = { ...c, transform: { ...c.transform }, color: { ...c.color } };
  if (c.mask) out.mask = { ...c.mask };
  const kt = toKfTime(c, t);
  for (const [p, list] of Object.entries(c.kf)) if (list && list.length) setPath(out, p, evalList(list, kt));
  return out;
}

const EPS_T = 1 / 240;
export function kfAt(c, p, t) {
  if (!hasKf(c, p)) return null;
  const kt = toKfTime(c, t);
  return c.kf[p].find((k) => Math.abs(k.t - kt) < EPS_T) || null;
}

// Değer yaz: özellik animasyonluysa oynatma kafasına anahtar kare ekler/günceller
export function writeValue(c, p, t, v) {
  if (!hasKf(c, p)) { setPath(c, p, v); return; }
  upsertKf(c, p, t, v);
}

export function upsertKf(c, p, t, v, e) {
  if (!c.kf) c.kf = {};
  const list = c.kf[p] || (c.kf[p] = []);
  const lt = clamp(t, c.start, c.start + c.duration);
  const kt = toKfTime(c, lt);
  const ex = list.find((k) => Math.abs(k.t - kt) < EPS_T);
  if (ex) { ex.v = v; if (e) ex.e = e; } else list.push({ t: kt, v, e: e || 'ease' });
  list.sort((a, b) => a.t - b.t);
}

export function removeKf(c, p, t) {
  if (!hasKf(c, p)) return;
  const kt = toKfTime(c, t);
  c.kf[p] = c.kf[p].filter((k) => Math.abs(k.t - kt) >= EPS_T);
  if (!c.kf[p].length) delete c.kf[p];
}

// Animasyonu kapat: o anki değer sabit değer olur
export function clearKf(c, p, t) {
  if (!hasKf(c, p)) return;
  const v = valueAt(c, p, t);
  delete c.kf[p];
  setPath(c, p, v);
}

// Diğer anahtar kareye git
export function neighborKf(c, p, t, dir) {
  if (!hasKf(c, p)) return null;
  const kt = toKfTime(c, t);
  const lst = c.kf[p].map((k) => k.t);
  const cand = dir > 0 ? lst.filter((x) => x > kt + EPS_T) : lst.filter((x) => x < kt - EPS_T).reverse();
  if (!cand.length) return null;
  const tt = fromKfTime(c, cand[0]);
  return clamp(tt, c.start, c.start + c.duration - 1e-3);
}

// Klibin görünür aralığındaki tüm anahtar kare zamanları (zaman çizelgesinde çizim için)
export function kfTimes(c) {
  if (!anyKf(c)) return [];
  const out = new Set();
  for (const list of Object.values(c.kf)) for (const k of list || []) {
    const tt = fromKfTime(c, k.t);
    if (tt >= c.start - 1e-3 && tt <= c.start + c.duration + 1e-3) out.add(Math.round(tt * 1000) / 1000);
  }
  return [...out].sort((a, b) => a - b);
}

// Ses kazanç eğrisi için örnekleme (dışa aktarmada otomasyon)
export function sampleVolume(c, t0, t1, step = 1 / 50) {
  const out = [];
  for (let t = t0; t < t1 + step / 2; t += step) out.push([t, valueAt(c, 'volume', Math.min(t, t1))]);
  return out;
}
