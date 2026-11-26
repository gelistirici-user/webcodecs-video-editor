// Dışa aktarma: kare kare birleştirme + WebCodecs kodlama (mediabunny ile MP4/WebM)
import {
  Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, StreamTarget, CanvasSource, AudioBufferSource, Quality,
  Input, UrlSource, ALL_FORMATS, CanvasSink, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from '../vendor/mediabunny.mjs';
import { store } from './store.js';
import { layersAt, drawFrame } from './compositor.js';
import { decodeAudio } from './media.js';
import { native, isElectron } from './platform.js';
import { clamp, EPS } from './utils.js';
import { hasKf, sampleVolume } from './keyframes.js';
import { isRemapped, bakeClipAudio, WindowSource } from './timemap.js';
import { buildChain, ensureWorklet, afxActive } from './audiofx.js';

export async function renderAudioMix(project, t0, t1, sampleRate = 48000) {
  const len = Math.max(1, Math.ceil((t1 - t0) * sampleRate));
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const master = ctx.createGain();
  master.gain.value = project.master ?? 1;
  master.connect(ctx.destination);
  const tracks = project.tracks.filter((t) => t.kind === 'audio');
  const solo = tracks.some((t) => t.solo);
  const buffers = new Map();
  let any = false;
  const workletOk = project.clips.some((c) => c.afx?.denoise > 0) ? await ensureWorklet(ctx) : false;
  for (const c of project.clips) {
    const tr = tracks.find((t) => t.id === c.trackId);
    if (!tr || tr.muted || (solo && !tr.solo) || c.muted || c.type !== 'media') continue;
    const m = project.media.find((x) => x.id === c.mediaId);
    if (!m || m.offline || !m.url || !(m.kind === 'audio' || m.hasAudio)) continue;
    const cs = c.start, ce = c.start + c.duration;
    if (ce <= t0 || cs >= t1) continue;
    if (!buffers.has(m.id)) {
      try { buffers.set(m.id, await decodeAudio(m.url)); } catch { buffers.set(m.id, null); }
    }
    const buf = buffers.get(m.id);
    if (!buf) continue;
    const remap = isRemapped(c);
    const src = ctx.createBufferSource();
    src.buffer = remap ? bakeClipAudio(c, buf, m.duration) : buf;
    src.playbackRate.value = remap ? 1 : c.speed;
    const g = ctx.createGain();
    const animVol = hasKf(c, 'volume');
    const vol = (animVol ? 1 : c.volume) * (tr.volume ?? 1);
    // fade otomasyonu (bağlam zamanında)
    const at = (t) => Math.max(0, t - t0);
    g.gain.setValueAtTime(c.audioFadeIn > 0 ? 0 : vol, at(cs));
    if (c.audioFadeIn > 0) g.gain.linearRampToValueAtTime(vol, at(cs + c.audioFadeIn));
    if (c.audioFadeOut > 0) { g.gain.setValueAtTime(vol, at(ce - c.audioFadeOut)); g.gain.linearRampToValueAtTime(0, at(ce)); }
    if (animVol) {
      // anahtar kareli ses seviyesi: ikinci kazanç düğümünde otomasyon
      const kg = ctx.createGain();
      const pts = sampleVolume(c, Math.max(cs, t0), Math.min(ce, t1));
      kg.gain.setValueAtTime(pts[0][1], at(pts[0][0]));
      for (const [tt, v] of pts.slice(1)) kg.gain.linearRampToValueAtTime(v, at(tt));
      src.connect(g).connect(kg).connect(master);
    } else src.connect(g).connect(master);
    if (afxActive(c.afx)) {
      // ses efektleri kaynakla kazanç arasına girer
      src.disconnect();
      const ch = buildChain(ctx, c.afx, workletOk);
      src.connect(ch.input);
      ch.output.connect(g);
    }
    const skip = Math.max(0, t0 - cs);
    const when = Math.max(0, cs - t0);
    const offset = remap ? skip : c.in + skip * c.speed;
    const dur = (Math.min(ce, t1) - Math.max(cs, t0)) * (remap ? 1 : c.speed);
    if (dur <= 0) continue;
    src.start(when, offset, dur);
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}

function sliceBuffer(buf, from, to) {
  const sr = buf.sampleRate;
  const s0 = Math.floor(from * sr), s1 = Math.min(buf.length, Math.floor(to * sr));
  const n = Math.max(0, s1 - s0);
  if (!n) return null;
  const out = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(s0, s1), c);
  return out;
}

export async function codecSupport(format, width, height, bitrate) {
  const vlist = format === 'webm' ? ['vp9', 'vp8', 'av1'] : ['avc', 'hevc', 'av1'];
  const alist = format === 'webm' ? ['opus', 'vorbis'] : ['aac', 'opus'];
  const video = await getFirstEncodableVideoCodec(vlist, { width, height, bitrate });
  const audio = await getFirstEncodableAudioCodec(alist, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 });
  return { video, audio };
}

/**
 * opts: { format, width, height, fps, bitrate, rangeStart, rangeEnd, filePath, includeAudio, onProgress, signal }
 */
export async function exportVideo(opts) {
  const P = JSON.parse(JSON.stringify(store.project));
  const { format, width, height, fps, bitrate, rangeStart: t0, rangeEnd: t1, onProgress, signal } = opts;
  const mm = new Map(P.media.map((m) => [m.id, m]));
  const totalFrames = Math.max(1, Math.round((t1 - t0) * fps));

  const codecs = await codecSupport(format, width, height, bitrate);
  if (!codecs.video) throw new Error('Bu sistemde uygun video kodlayıcı bulunamadı. Farklı biçim veya çözünürlük deneyin.');

  // hedef
  let fileId = null;
  let target;
  if (isElectron && opts.filePath) {
    fileId = await native.exportOpen(opts.filePath);
    let chain = Promise.resolve();
    const writable = new WritableStream({
      write(chunk) { chain = native.exportWrite(fileId, chunk.position, chunk.data); return chain; },
      close() { return chain; },
    });
    target = new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 });
  } else target = new BufferTarget();

  const output = new Output({
    format: format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: isElectron ? false : 'in-memory' }),
    target,
  });

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  const videoSource = new CanvasSource(canvas, { codec: codecs.video, quality: new Quality({ bitrate }), keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioBuf = null;
  let audioSource = null;
  if (opts.includeAudio !== false && codecs.audio) {
    onProgress?.({ phase: 'audio', progress: 0 });
    audioBuf = await renderAudioMix(P, t0, t1);
    if (audioBuf) {
      audioSource = new AudioBufferSource({ codec: codecs.audio, quality: new Quality({ bitrate: 192000 }) });
      output.addAudioTrack(audioSource);
    }
  }

  // kaynak planı: her klip için ihtiyaç duyulan kaynak zamanları (sırayla)
  const plan = new Map();
  for (let i = 0; i < totalFrames; i++) {
    const t = t0 + i / fps;
    for (const L of layersAt(P, t, mm)) {
      if (!L.clip || L.clip.type !== 'media') continue;
      const m = mm.get(L.clip.mediaId);
      if (!m || m.kind !== 'video' || m.offline) continue;
      if (!plan.has(L.clip.id)) plan.set(L.clip.id, { mediaId: m.id, times: [] });
      plan.get(L.clip.id).times.push(L.srcTime);
    }
  }
  const inputs = new Map();
  const gens = new Map();
  const revs = new Map();
  const lastFrame = new Map();
  const getTrack = async (m) => {
    if (!inputs.has(m.id)) {
      const input = new Input({ source: new UrlSource(m.url), formats: ALL_FORMATS });
      inputs.set(m.id, { input, track: await input.getPrimaryVideoTrack() });
    }
    return inputs.get(m.id).track;
  };
  for (const [clipId, p] of plan) {
    const m = mm.get(p.mediaId);
    const track = await getTrack(m);
    if (!track || !(await track.canDecode())) throw new Error(`"${m.name}" çözümlenemiyor (desteklenmeyen kodek).`);
    const clip = P.clips.find((c) => c.id === clipId);
    if (clip?.reverse) {
      // ters klip: kaynağı küçük pencerelerde ileri çözerek geriye doğru kare ver
      const ws = new WindowSource(m.url, { maxW: 4096, win: 0.4, keep: 2 });
      revs.set(clipId, ws);
      gens.set(clipId, (async function* () { for (const s of p.times) yield { canvas: await ws.get(s) }; })());
      continue;
    }
    const sink = new CanvasSink(track, { poolSize: 2 });
    // kaynak zamanları artan sırada olmalı; geriye gidenler için yine de çalışır (yavaş)
    gens.set(clipId, sink.canvasesAtTimestamps(p.times));
  }

  // görseller
  const images = new Map();
  for (const m of P.media) {
    if (m.kind !== 'image' || m.offline) continue;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = m.url;
    try { await img.decode(); images.set(m.id, img); } catch { /* atla */ }
  }

  await output.start();
  const started = performance.now();
  let audioCursor = 0;
  const AUDIO_CHUNK = 1;
  const pushAudio = async (upTo) => {
    if (!audioBuf || !audioSource) return;
    while (audioCursor < Math.min(upTo, audioBuf.duration) - EPS) {
      const next = Math.min(audioCursor + AUDIO_CHUNK, audioBuf.duration);
      const s = sliceBuffer(audioBuf, audioCursor, next);
      if (s) await audioSource.add(s);
      audioCursor = next;
    }
  };

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('İptal edildi', 'AbortError');
      const t = t0 + i / fps;
      const layers = layersAt(P, t, mm);
      const frameSources = new Map();
      for (const L of layers) {
        if (!L.clip || L.clip.type !== 'media') continue;
        const gen = gens.get(L.clip.id);
        if (!gen) continue;
        const r = await gen.next();
        const wc = r.value || lastFrame.get(L.clip.id);
        if (wc) { lastFrame.set(L.clip.id, wc); frameSources.set(L.clip.id, wc.canvas); }
      }
      drawFrame(ctx, width, height, P, t, layers, (L) => {
        const m = mm.get(L.clip.mediaId);
        if (!m) return null;
        if (m.kind === 'image') { const img = images.get(m.id); return img ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null; }
        const c = frameSources.get(L.clip.id);
        return c ? { el: c, w: c.width, h: c.height } : null;
      });
      await videoSource.add(i / fps, 1 / fps);
      await pushAudio((i + 1) / fps + 0.5);
      if (i % 3 === 0 || i === totalFrames - 1) {
        const el = (performance.now() - started) / 1000;
        const prog = (i + 1) / totalFrames;
        onProgress?.({ phase: 'video', progress: prog, frame: i + 1, total: totalFrames, eta: el / prog - el, fps: (i + 1) / el, preview: i % 15 === 0 ? canvas : null });
      }
    }
    await pushAudio(Infinity);
    onProgress?.({ phase: 'finalize', progress: 1 });
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch { /* */ }
    if (fileId) await native.exportClose(fileId, true, opts.filePath);
    for (const { input } of inputs.values()) input.dispose?.();
    throw e;
  }
  for (const g of gens.values()) { try { await g.return(); } catch { /* */ } }
  for (const { input } of inputs.values()) input.dispose?.();
  for (const r of revs.values()) r.dispose();
  if (fileId) { await native.exportClose(fileId, false); return { path: opts.filePath, codecs }; }
  const mime = format === 'webm' ? 'video/webm' : 'video/mp4';
  return { blob: new Blob([target.buffer], { type: mime }), codecs };
}

export function estimateSize(bitrate, seconds) {
  const bytes = ((bitrate + 192000) / 8) * seconds;
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  return Math.max(0.1, bytes / 1e6).toFixed(1) + ' MB';
}

export const clampRange = (a, b, d) => [clamp(a, 0, d), clamp(b, 0, d)];
