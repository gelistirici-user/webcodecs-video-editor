// Proxy medya: ağır videoların hafif kopyaları (önizlemede kullanılır, dışa aktarma her zaman orijinali kullanır)
import { Input, Output, UrlSource, ALL_FORMATS, Mp4OutputFormat, BufferTarget, StreamTarget, Conversion } from '../vendor/mediabunny.mjs';
import { store } from './store.js';
import { h, clamp } from './utils.js';
import { modal, toast } from './ui.js';
import { isElectron, native, pathToUrl } from './platform.js';

export const proxyState = { use: localStorage.getItem('kurgu.useProxy') !== '0' };
export function setUseProxy(v) { proxyState.use = v; localStorage.setItem('kurgu.useProxy', v ? '1' : '0'); store.emit('proxy'); }
// Önizlemede kullanılacak adres
export const previewUrl = (m) => (proxyState.use && m.proxy?.url ? m.proxy.url : m.url);

async function makeProxy(m, onProgress, signal) {
  const input = new Input({ source: new UrlSource(m.url), formats: ALL_FORMATS });
  let target, fileId = null, path = null;
  if (isElectron) {
    path = (await native.userData()) + '/proxies/' + m.id + '_960.mp4';
    fileId = await native.exportOpen(path);
    let chain = Promise.resolve();
    target = new StreamTarget(new WritableStream({ write(c) { chain = native.exportWrite(fileId, c.position, c.data); return chain; }, close() { return chain; } }), { chunked: true, chunkSize: 8 * 1024 * 1024 });
  } else target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: isElectron ? false : 'in-memory' }), target });
  const conv = await Conversion.init({
    input, output,
    video: { width: Math.min(960, m.width || 960), fit: 'contain', codec: 'avc', bitrate: 2_000_000, forceTranscode: true },
    audio: { codec: 'aac', bitrate: 128_000 },
  });
  if (!conv.isValid) throw new Error('Bu dosya için proxy oluşturulamıyor');
  conv.onProgress = (p) => onProgress?.(p);
  signal?.addEventListener('abort', () => conv.cancel());
  try { await conv.execute(); } catch (e) { if (fileId) await native.exportClose(fileId, true, path); throw e; } finally { input.dispose?.(); }
  if (fileId) { await native.exportClose(fileId, false); return { path, url: pathToUrl(path) }; }
  return { path: null, url: URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' })) };
}

export async function createProxies(list) {
  list = list.filter((m) => m.kind === 'video' && !m.offline);
  if (!list.length) return toast('Proxy için video seçin', 'warn');
  const ctrl = new AbortController();
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const pct = h('div', { class: 'progress-pct' }, '0%');
  const info = h('div', { class: 'progress-info' }, '');
  const dlg = modal({ title: 'Proxy oluşturuluyor…', body: h('div', { class: 'export-run' }, h('div', { class: 'progress-row' }, bar, pct), info), width: 440, dismissable: false, buttons: [{ label: 'İptal', danger: true, action: () => { ctrl.abort(); return true; } }] });
  let done = 0;
  try {
    for (const m of list) {
      info.textContent = `${done + 1}/${list.length}: ${m.name} (960 piksel, H.264)`;
      const t0 = performance.now();
      const r = await makeProxy(m, (p) => {
        const v = (done + clamp(p, 0, 1)) / list.length;
        bar.firstChild.style.width = v * 100 + '%'; pct.textContent = Math.round(v * 100) + '%';
      }, ctrl.signal);
      store.transact('Proxy oluştur', () => { const x = store.media(m.id); if (x) x.proxy = { ...r, w: 960, ms: Math.round(performance.now() - t0) }; });
      done++;
    }
    dlg.close();
    toast(`${done} proxy hazır. Önizleme proxy kullanıyor; dışa aktarma orijinal dosyalardan yapılır.`, 'ok', 4000);
  } catch (e) {
    dlg.close();
    if (!ctrl.signal.aborted) toast('Proxy oluşturulamadı: ' + e.message, 'err', 5000);
  }
}

export function removeProxy(m) {
  store.transact('Proxy kaldır', () => { const x = store.media(m.id); if (x) delete x.proxy; });
}

// Proje açılırken: proxy dosyası silinmişse kaydı temizle
export async function validateProxies() {
  if (!isElectron) { store.project.media.forEach((m) => { if (m.proxy && !m.proxy.path) delete m.proxy; }); return; }
  for (const m of store.project.media) if (m.proxy?.path && !(await native.exists(m.proxy.path))) delete m.proxy;
}
