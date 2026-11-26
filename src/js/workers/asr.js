// Konuşma tanıma işçisi (Whisper, transformers.js). Arayüzü dondurmamak için ayrı iş parçacığında çalışır.
import { pipeline, env } from '../../vendor/transformers/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../../vendor/transformers/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

let current = null; // { key, pipe, device }

async function load(model, onProgress) {
  const key = model;
  if (current?.key === key) return current;
  const progress_callback = (p) => onProgress(p);
  let pipe = null, device = 'wasm';
  if (self.navigator?.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        pipe = await pipeline('automatic-speech-recognition', model, { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback });
        device = 'webgpu';
      }
    } catch (e) { pipe = null; self.postMessage({ type: 'log', message: 'WebGPU kullanılamadı: ' + e.message }); }
  }
  if (!pipe) pipe = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
  current = { key, pipe, device };
  return current;
}

self.onmessage = async (ev) => {
  const { type } = ev.data;
  if (type !== 'run') return;
  const { segments, model, language } = ev.data;
  try {
    const { pipe, device } = await load(model, (p) => self.postMessage({ type: 'download', data: { status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total } }));
    self.postMessage({ type: 'ready', device });
    const out = [];
    for (let i = 0; i < segments.length; i++) {
      const { audio, offset } = segments[i];
      const r = await pipe(audio, { language, task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
      const chunks = (r.chunks || [{ timestamp: [0, audio.length / 16000], text: r.text }])
        .map((c) => ({ start: offset + (c.timestamp[0] ?? 0), end: offset + (c.timestamp[1] ?? audio.length / 16000), text: (c.text || '').trim() }))
        .filter((c) => c.text);
      out.push(...chunks);
      self.postMessage({ type: 'progress', done: i + 1, total: segments.length, chunks });
    }
    self.postMessage({ type: 'done', chunks: out });
  } catch (e) {
    self.postMessage({ type: 'error', message: e?.message || String(e) });
  }
};
