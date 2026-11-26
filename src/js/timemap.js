// Zaman eşleme: hız rampası (anahtar kareli hız) ve ters oynatma
// Zaman çizelgesi zamanı -> kaynak medya zamanı
import { clamp } from './utils.js';
import { hasKf, valueAt } from './keyframes.js';
import { Input, UrlSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from '../vendor/mediabunny.mjs';

export const isRemapped = (c) => !!(c && (c.reverse || hasKf(c, 'speed')));
export const speedAt = (c, t) => (hasKf(c, 'speed') ? Math.max(0.05, valueAt(c, 'speed', t)) : c.speed);

const STEP = 1 / 240;
const tables = new Map();
// hız eğrisinin birikimli integrali (önbellekli)
function table(c) {
  const key = `${c.id}|${c.start}|${c.in}|${c.duration}|${c.speed}|${JSON.stringify(c.kf.speed)}`;
  let T = tables.get(key);
  if (T) return T;
  const n = Math.ceil(c.duration / STEP) + 2;
  T = new Float64Array(n);
  let prev = speedAt(c, c.start);
  for (let i = 1; i < n; i++) {
    const v = speedAt(c, c.start + i * STEP);
    T[i] = T[i - 1] + ((prev + v) / 2) * STEP;
    prev = v;
  }
  if (tables.size > 60) tables.delete(tables.keys().next().value);
  tables.set(key, T);
  return T;
}

// Klip başından `local` saniye sonra tüketilen kaynak süresi
export function srcOffset(c, local) {
  if (!hasKf(c, 'speed')) return local * c.speed;
  const T = table(c);
  const x = clamp(local / STEP, 0, T.length - 1.001);
  const i = Math.floor(x), f = x - i;
  return T[i] + (T[i + 1] - T[i]) * f;
}

// Klibin toplam kaynak uzunluğu
export const srcSpan = (c) => srcOffset(c, c.duration);

export function srcTimeAt(c, t, media) {
  const local = clamp(t - c.start, 0, c.duration);
  let s;
  if (!isRemapped(c)) s = c.in + local * c.speed;
  else if (c.reverse) s = c.in + Math.max(0, srcSpan(c) - srcOffset(c, local) - 1e-3);
  else s = c.in + srcOffset(c, local);
  if (media && media.kind !== 'image' && media.duration) s = clamp(s, 0, Math.max(0, media.duration - 0.001));
  return Math.max(0, s);
}

// Hız/ters eşlemesini uygulanmış ses (çıktı sırasında örnekler); önizleme ve dışa aktarma ortak
// Kaynağın yalnızca [a, b] aralığını çöz (tüm dosyayı çözmekten çok daha hızlı)
export async function decodeSegment(url, a, b) {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const tr = await input.getPrimaryAudioTrack();
    if (!tr || !(await tr.canDecode())) return null;
    const sink = new AudioBufferSink(tr);
    const parts = [];
    for await (const { buffer, timestamp } of sink.buffers(Math.max(0, a), b)) parts.push({ buffer, timestamp });
    if (!parts.length) return null;
    const sr = parts[0].buffer.sampleRate, nch = parts[0].buffer.numberOfChannels;
    const t0 = parts[0].timestamp;
    const end = parts[parts.length - 1].timestamp + parts[parts.length - 1].buffer.duration;
    const out = new AudioBuffer({ length: Math.ceil((end - t0) * sr) + 1, numberOfChannels: nch, sampleRate: sr });
    for (const { buffer, timestamp } of parts) {
      const off = Math.round((timestamp - t0) * sr);
      for (let ch = 0; ch < nch; ch++) out.copyToChannel(buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1)), ch, off);
    }
    out.startTime = t0;
    return out;
  } finally { input.dispose?.(); }
}

export function bakeClipAudio(c, src, mediaDur) {
  const sr = src.sampleRate;
  const n = Math.max(1, Math.ceil(c.duration * sr));
  const nch = src.numberOfChannels;
  const out = new AudioBuffer({ length: n, numberOfChannels: nch, sampleRate: sr });
  const ins = [], outs = [];
  for (let ch = 0; ch < nch; ch++) { ins.push(src.getChannelData(ch)); outs.push(out.getChannelData(ch)); }
  const last = src.length - 2;
  const m = { kind: 'audio', duration: mediaDur };
  for (let i = 0; i < n; i++) {
    const s = (srcTimeAt(c, c.start + i / sr, m) - (src.startTime || 0)) * sr;
    const i0 = Math.min(last, Math.max(0, Math.floor(s)));
    const f = s - i0;
    for (let ch = 0; ch < nch; ch++) { const d = ins[ch]; outs[ch][i] = d[i0] + (d[i0 + 1] - d[i0]) * f; }
  }
  return out;
}

// Geriye doğru kare kaynağı: kaynağı küçük pencereler halinde ileri çözüp önbellekte tutar
export class WindowSource {
  constructor(url, { maxW = 640, win = 1, keep = 3 } = {}) {
    this.win = win; this.keep = keep; this.windows = []; this.loading = null;
    this.input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    this.ready = (async () => {
      const tr = await this.input.getPrimaryVideoTrack();
      if (!tr || !(await tr.canDecode())) throw new Error('decode');
      const w = Math.min(maxW, tr.displayWidth);
      this.sink = new CanvasSink(tr, { width: w, height: Math.round((w * tr.displayHeight) / tr.displayWidth / 2) * 2, fit: 'fill', poolSize: 0 });
    })();
    this.ready.catch(() => {});
  }
  // s anına en yakın (<= s) önbellekteki kare
  frameAt(s) {
    for (const W of this.windows) {
      if (s < W.a - 1e-3 || s > W.b + 1e-3 || !W.frames.length) continue;
      let best = null;
      for (const f of W.frames) { if (f.t <= s + 1e-3) best = f; else break; }
      return (best || W.frames[0]).c;
    }
    return null;
  }
  covered(s) { return this.windows.some((W) => s >= W.a - 1e-3 && s <= W.b + 1e-3); }
  load(s) {
    if (this.loading) return this.loading;
    const b = s + 0.05, a = Math.max(0, s - this.win);
    this.loading = (async () => {
      await this.ready;
      const frames = [];
      for await (const wc of this.sink.canvases(a, b)) frames.push({ t: wc.timestamp, c: wc.canvas });
      this.windows.unshift({ a, b, frames });
      if (this.windows.length > this.keep) this.windows.length = this.keep;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  // önizleme: gerekirse arka planda yükle (geriye doğru ön yükleme dahil)
  prefetch(s) {
    if (this.loading) return;
    if (!this.covered(s)) { this.load(s).then(() => this.onload?.(), () => {}); return; }
    const W = this.windows.find((x) => s >= x.a - 1e-3 && s <= x.b + 1e-3);
    if (W && W.a > 0 && s - W.a < this.win * 0.5 && !this.covered(W.a - 0.02)) this.load(W.a - 0.02).then(() => this.onload?.(), () => {});
  }
  // dışa aktarma: kesin kare
  async get(s) {
    if (!this.covered(s)) await this.load(s);
    return this.frameAt(s);
  }
  dispose() { this.windows = []; try { this.input.dispose?.(); } catch { /* */ } }
}
