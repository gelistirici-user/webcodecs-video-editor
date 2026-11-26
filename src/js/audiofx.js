// Ses araçları: efekt zinciri (gürültü azaltma, alçak kesim, ses netleştirme), normalleştirme, otomatik ducking
import { store } from './store.js';
import { clamp, EPS } from './utils.js';
import { srcTimeAt, srcSpan, decodeSegment } from './timemap.js';
import { upsertKf, valueAt } from './keyframes.js';

export const DEFAULT_AFX = () => ({ denoise: 0, lowcut: false, voice: false });
export const afxActive = (a) => !!(a && (a.denoise > 0 || a.lowcut || a.voice));

const WORKLET_URL = new URL('./worklets/denoise.js', import.meta.url).href;
const loaded = new WeakMap();
export function ensureWorklet(ctx) {
  if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL).then(() => true, () => false));
  return loaded.get(ctx);
}

// input -> [alçak kesim] -> [gürültü azaltma] -> [ses netleştirme] -> output
export function buildChain(ctx, afx, workletOk) {
  const input = ctx.createGain();
  let node = input;
  const add = (n) => { node.connect(n); node = n; return n; };
  if (afx?.lowcut) {
    const hp = add(ctx.createBiquadFilter());
    hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = 0.7;
  }
  if (afx?.denoise > 0 && workletOk) {
    const dn = add(new AudioWorkletNode(ctx, 'kurgu-denoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }));
    dn.parameters.get('amount').value = clamp(afx.denoise, 0, 1);
  }
  if (afx?.voice) {
    const low = add(ctx.createBiquadFilter()); low.type = 'lowshelf'; low.frequency.value = 180; low.gain.value = -3;
    const pres = add(ctx.createBiquadFilter()); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = 4;
    const comp = add(ctx.createDynamicsCompressor());
    comp.threshold.value = -22; comp.ratio.value = 3; comp.attack.value = 0.008; comp.release.value = 0.2; comp.knee.value = 8;
    const mk = add(ctx.createGain()); mk.gain.value = 1.35;
  }
  return { input, output: node };
}

// ---------- normalleştirme ----------
async function clipSamples(c, m) {
  const a = Math.min(srcTimeAt(c, c.start, m), srcTimeAt(c, c.start + c.duration, m));
  return decodeSegment(m.url, a, a + srcSpan(c));
}

// mode: 'peak' (tepe -1 dBFS) | 'lufs' (yaklaşık -14 LUFS, RMS tabanlı)
export async function normalizeClips(clips, mode = 'peak') {
  const res = [];
  for (const c of clips) {
    const m = store.media(c.mediaId);
    if (!m || m.offline) continue;
    const buf = await clipSamples(c, m);
    if (!buf) continue;
    let pk = 0, sum = 0, n = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; sum += d[i] * d[i]; n++; }
    }
    if (pk < 1e-5) continue;
    const rms = Math.sqrt(sum / Math.max(1, n));
    let vol = mode === 'peak' ? Math.pow(10, -1 / 20) / pk : Math.pow(10, (-14 + 3) / 20) / Math.max(1e-5, rms);
    // tepe sınırı: kırpılmayı önle
    vol = Math.min(vol, Math.pow(10, -0.5 / 20) / pk, 8);
    res.push({ c, vol });
  }
  return res;
}

// ---------- otomatik ducking ----------
// Konuşma izlerinde ses varken müzik izlerindeki klipleri anahtar karelerle kısar
export function autoDuck({ musicTrackIds, voiceTrackIds, duckDb = -14, threshold = 0.06, attack = 0.25, release = 0.6, minGap = 0.6 }) {
  const P = store.project;
  minGap = Math.max(minGap, attack + release);
  const rate = 20; // zarf çözünürlüğü (Hz)
  const dur = store.duration();
  const env = new Float32Array(Math.ceil(dur * rate) + 1);
  for (const c of P.clips) {
    if (!voiceTrackIds.includes(c.trackId) || c.type !== 'media' || c.muted) continue;
    const m = store.media(c.mediaId);
    const cache = store.mediaCache.get(c.mediaId);
    if (!m || !cache?.peaks) continue;
    const { peaks, peaksRate } = cache;
    for (let i = Math.floor(c.start * rate); i < Math.min(env.length, Math.ceil((c.start + c.duration) * rate)); i++) {
      const t = i / rate;
      const s = srcTimeAt(c, t, m);
      let mx = 0;
      for (let k = Math.floor(s * peaksRate); k < Math.floor((s + 1 / rate) * peaksRate); k++) mx = Math.max(mx, peaks[k] || 0);
      env[i] = Math.max(env[i], mx * valueAt(c, 'volume', t));
    }
  }
  // konuşma bölgeleri (kısa boşluklar birleştirilir)
  const regions = [];
  let cur = null;
  for (let i = 0; i < env.length; i++) {
    const on = env[i] > threshold;
    const t = i / rate;
    if (on) { if (cur && t - cur[1] <= minGap) cur[1] = t + 1 / rate; else { cur = [t, t + 1 / rate]; regions.push(cur); } }
  }
  const low = Math.pow(10, duckDb / 20);
  let count = 0;
  for (const c of P.clips) {
    if (!musicTrackIds.includes(c.trackId) || c.type !== 'media') continue;
    const base = c.volume;
    if (c.kf) delete c.kf.volume;
    const cs = c.start, ce = c.start + c.duration;
    const rs = regions.filter((r) => r[1] > cs && r[0] < ce);
    if (!rs.length) continue;
    const put = (t, v) => upsertKf(c, 'volume', clamp(t, cs, ce), v, 'ease');
    put(cs, base);
    for (const [a, b] of rs) {
      put(a - attack, base); put(a, base * low);
      put(b, base * low); put(b + release, base);
    }
    put(ce, valueAt(c, 'volume', ce - EPS));
    count++;
  }
  return { regions: regions.length, clips: count };
}
