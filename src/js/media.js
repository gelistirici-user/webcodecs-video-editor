// Medya içe aktarma, inceleme, küçük resim ve dalga formu üretimi
import { Input, UrlSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from '../vendor/mediabunny.mjs';
import { store } from './store.js';
import { uid } from './utils.js';

const THUMB_H = 72;

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Görsel yüklenemedi'));
    img.src = url;
  });
}

function probeElement(url, kind) {
  return new Promise((res, rej) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.crossOrigin = 'anonymous';
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => res({ duration: el.duration, width: el.videoWidth || 0, height: el.videoHeight || 0, el });
    el.onerror = () => rej(new Error('Bu dosya biçimi oynatılamıyor'));
    el.src = url;
  });
}

export async function probe(item) {
  if (item.kind === 'image') {
    const img = await loadImage(item.url);
    return { duration: 0, width: img.naturalWidth, height: img.naturalHeight, hasAudio: false };
  }
  // önce mediabunny ile kesin bilgi, olmazsa tarayıcı öğesi
  let info = null;
  try {
    const input = new Input({ source: new UrlSource(item.url), formats: ALL_FORMATS });
    const [v, a] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    const duration = await input.computeDuration();
    info = { duration, width: v ? v.displayWidth : 0, height: v ? v.displayHeight : 0, hasAudio: !!a, hasVideo: !!v };
    if (v) { try { const st = await v.computePacketStats(120); info.fps = Math.round(st.averagePacketRate * 100) / 100; } catch { /* yok */ } }
    input.dispose?.();
  } catch { /* geri dönüş */ }
  try {
    const el = await probeElement(item.url, item.kind);
    if (!info) info = { duration: el.duration, width: el.width, height: el.height, hasAudio: item.kind === 'audio' || true, hasVideo: item.kind === 'video' };
    if (!isFinite(info.duration) || !info.duration) info.duration = el.duration;
    el.el.removeAttribute('src');
  } catch (e) {
    if (!info) throw e;
  }
  if (item.kind === 'video' && info.hasVideo === false) item.kind = 'audio';
  return info;
}

// Dosya boyutu (dışa aktarmada "kaynağa yakın" bit hızını hesaplamak için)
async function fileSize(it) {
  try {
    if (it.file) return it.file.size;
    if (it.path && window.native) return (await window.native.stat(it.path))?.size || null;
    const r = await fetch(it.url, { method: 'HEAD' });
    return parseInt(r.headers.get('content-length'), 10) || null;
  } catch { return null; }
}

export async function importItems(items) {
  const added = [];
  const errors = [];
  for (const it of items) {
    try {
      const info = await probe(it);
      const size = await fileSize(it);
      const m = {
        id: uid('m'), name: it.name, size, path: it.path, url: it.url, kind: it.kind,
        duration: info.duration || 0, width: info.width, height: info.height, hasAudio: !!info.hasAudio, fps: info.fps || null,
        srcIn: null, srcOut: null, offline: false,
      };
      added.push(m);
    } catch (e) {
      errors.push(`${it.name}: ${e.message}`);
    }
  }
  if (added.length) {
    store.transact('Medya içe aktar', (P) => P.media.push(...added));
    added.forEach((m) => buildCache(m));
  }
  return { added, errors };
}

// ---------- önbellek: küçük resimler + dalga formu ----------
export function buildCache(m) {
  if (m.offline || !m.url) return;
  const cache = { thumbs: [], poster: null, peaks: null, peaksRate: 0 };
  store.mediaCache.set(m.id, cache);
  if (m.kind === 'image') {
    loadImage(m.url).then((img) => {
      cache.image = img;
      const c = document.createElement('canvas');
      c.height = THUMB_H; c.width = Math.round(THUMB_H * (img.naturalWidth / img.naturalHeight || 1.77));
      c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
      cache.poster = c;
      cache.thumbs = [{ t: 0, c }];
      store.emit('media-cache', m.id);
    }).catch(() => {});
    return;
  }
  if (m.kind === 'video') makeThumbs(m, cache).catch(() => {});
  if (m.hasAudio || m.kind === 'audio') makePeaks(m, cache).catch(() => {});
}

async function makeThumbs(m, cache) {
  const n = Math.max(4, Math.min(60, Math.ceil(m.duration / 4)));
  const w = Math.round(THUMB_H * (m.width / m.height || 16 / 9));
  const times = Array.from({ length: n }, (_, i) => (m.duration * (i + 0.5)) / n);
  try {
    const input = new Input({ source: new UrlSource(m.url), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('decode');
    const sink = new CanvasSink(track, { width: w, height: THUMB_H, fit: 'cover' });
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      await idle();
      if (wc) {
        const c = document.createElement('canvas');
        c.width = w; c.height = THUMB_H;
        c.getContext('2d', { willReadFrequently: true }).drawImage(wc.canvas, 0, 0);
        cache.thumbs.push({ t: times[i], c });
        if (!cache.poster) cache.poster = c;
        if (i % 6 === 0) store.emit('media-cache', m.id);
      }
      i++;
    }
    input.dispose?.();
  } catch {
    // video öğesi ile yedek yöntem
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'auto'; v.src = m.url;
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = j; });
    for (const t of times.slice(0, 16)) {
      v.currentTime = t;
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 1500); });
      const c = document.createElement('canvas');
      c.width = w; c.height = THUMB_H;
      c.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0, w, THUMB_H);
      cache.thumbs.push({ t, c });
      if (!cache.poster) cache.poster = c;
    }
    v.removeAttribute('src'); v.load();
  }
  store.emit('media-cache', m.id);
}

let decodeCtx = null;
export async function decodeAudio(url) {
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(2, 1, 48000);
  const buf = await (await fetch(url)).arrayBuffer();
  return decodeCtx.decodeAudioData(buf);
}

// Oynatma sırasında arka plan işleri bekler (disk/çözücü yarışı oynatmayı takmasın)
let playingNow = false;
store.on('transport', (p) => { playingNow = !!p; });
const idle = async () => { while (playingNow) await new Promise((r) => setTimeout(r, 250)); };

async function makePeaks(m, cache) {
  const rate = 100; // saniyede 100 tepe
  // akışlı çözme: dosyanın tamamını belleğe almadan parça parça (bellek ve disk yükü düşük)
  const input = new Input({ source: new UrlSource(m.url), formats: ALL_FORMATS });
  try {
    const tr = await input.getPrimaryAudioTrack();
    if (!tr || !(await tr.canDecode())) throw new Error('decode');
    const dur = m.duration || (await input.computeDuration());
    const peaks = new Float32Array(Math.ceil(dur * rate) + 1);
    const sink = new AudioBufferSink(tr);
    let k = 0;
    for await (const { buffer, timestamp } of sink.buffers()) {
      if (++k % 50 === 0) await idle();
      const sr = buffer.sampleRate, step = sr / rate;
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      for (let s = 0; s < buffer.length; s += 4) {
        const i = Math.floor((timestamp + s / sr) * rate);
        if (i < 0 || i >= peaks.length) continue;
        let mx = peaks[i];
        for (const ch of chans) { const v = Math.abs(ch[s]); if (v > mx) mx = v; }
        peaks[i] = mx;
      }
      void step;
    }
    cache.peaks = peaks;
  } catch {
    // yedek: tarayıcının çözücüsü (tüm dosya)
    const ab = await decodeAudio(m.url);
    const n = Math.ceil(ab.duration * rate);
    const peaks = new Float32Array(n);
    const chans = [];
    for (let c = 0; c < ab.numberOfChannels; c++) chans.push(ab.getChannelData(c));
    const step = ab.sampleRate / rate;
    for (let i = 0; i < n; i++) {
      let mx = 0;
      const s0 = Math.floor(i * step), s1 = Math.min(ab.length, Math.floor((i + 1) * step));
      for (const ch of chans) for (let q = s0; q < s1; q += 4) { const v = Math.abs(ch[q]); if (v > mx) mx = v; }
      peaks[i] = mx;
    }
    cache.peaks = peaks;
  } finally { input.dispose?.(); }
  cache.peaksRate = rate;
  if (!m.hasAudio) m.hasAudio = true;
  store.emit('media-cache', m.id);
}

export function thumbAt(mediaId, t) {
  const c = store.mediaCache.get(mediaId);
  if (!c || !c.thumbs.length) return null;
  let best = c.thumbs[0];
  for (const th of c.thumbs) if (Math.abs(th.t - t) < Math.abs(best.t - t)) best = th;
  return best.c;
}
