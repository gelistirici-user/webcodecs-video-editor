// Otomatik altyazı (Whisper) ve SRT dışa/içe aktarma
import { store, makeClip, DEFAULT_TEXT } from './store.js';
import { h, clamp, formatTC } from './utils.js';
import { modal, toast } from './ui.js';
import { renderAudioMix } from './exporter.js';
import { isElectron, native } from './platform.js';

export const MODELS = {
  'onnx-community/whisper-base': 'Hızlı — whisper-base (~80 MB)',
  'onnx-community/whisper-small': 'Doğru — whisper-small (~250 MB)',
};
const LANGS = { turkish: 'Türkçe', english: 'İngilizce', german: 'Almanca', french: 'Fransızca', spanish: 'İspanyolca', arabic: 'Arapça', russian: 'Rusça', '': 'Otomatik algıla' };
const SUB_TRACK = 'Altyazı';

// 16 kHz mono PCM (Whisper girişi)
async function timelineAudio16k(a, b) {
  const mix = await renderAudioMix(store.project, a, b, 48000);
  if (!mix) return null;
  const len = Math.ceil((b - a) * 16000);
  const ctx = new OfflineAudioContext(1, len, 16000);
  const src = ctx.createBufferSource();
  src.buffer = mix;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

// ≤30 sn parçalar; kesim noktası 18–29 sn arasındaki en sessiz yere konur (kelime bölünmesin)
export function smartSegments(pcm, sr = 16000) {
  const segs = [];
  let pos = 0;
  const win = Math.round(sr * 0.05);
  while (pos < pcm.length) {
    if (pcm.length - pos <= sr * 30) { segs.push([pos, pcm.length]); break; }
    let best = pos + sr * 29, bestE = Infinity;
    for (let s = pos + sr * 18; s < pos + sr * 29; s += win) {
      let e = 0;
      for (let k = s; k < s + win; k++) e += pcm[k] * pcm[k];
      if (e < bestE) { bestE = e; best = s + (win >> 1); }
    }
    segs.push([pos, best]);
    pos = best;
  }
  return segs;
}

// Uzun metni ekranda okunabilir parçalara böl (satır ≤ 42 karakter, en fazla 2 satır)
export function splitCaption(text, start, end, maxLine = 42) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const pieces = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (t.length > maxLine * 2 && cur) { pieces.push(cur); cur = w; } else cur = t;
  }
  if (cur) pieces.push(cur);
  const total = pieces.reduce((s, p) => s + p.length, 0) || 1;
  const out = [];
  let t = start;
  for (const p of pieces) {
    const d = ((end - start) * p.length) / total;
    out.push({ start: t, end: t + d, text: wrap2(p, maxLine) });
    t += d;
  }
  return out;
}
function wrap2(s, maxLine) {
  if (s.length <= maxLine) return s;
  const mid = s.length / 2;
  let best = -1;
  for (let i = 0; i < s.length; i++) if (s[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? s : s.slice(0, best) + '\n' + s.slice(best + 1);
}

function subtitleTrack() {
  let t = store.project.tracks.find((x) => x.kind === 'video' && x.name === SUB_TRACK);
  if (!t) { t = store.addTrack('video'); t.name = SUB_TRACK; }
  return t;
}

export function captionStyle() {
  const S = store.project.settings;
  const size = Math.round(S.height * 0.045);
  return {
    text: { ...DEFAULT_TEXT(), content: '', size, bold: false, bg: true, bgColor: '#000000', bgOpacity: 0.6, shadow: 0, lineHeight: 1.25 },
    transform: { x: 0, y: Math.round(S.height / 2 - S.height * 0.12), scale: 1, rotation: 0, opacity: 1, fit: 'contain', cropL: 0, cropR: 0, cropT: 0, cropB: 0, blend: 'source-over', flipH: false, flipV: false },
  };
}

export function placeCaptions(chunks, { replace = true } = {}) {
  const tr = subtitleTrack();
  const fps = store.fps;
  if (replace) store.project.clips = store.project.clips.filter((c) => c.trackId !== tr.id);
  const style = captionStyle();
  const made = [];
  const items = chunks.flatMap((c) => splitCaption(c.text, c.start, c.end));
  items.forEach((it, i) => {
    let s = Math.round(it.start * fps) / fps;
    let e = Math.round(it.end * fps) / fps;
    const next = items[i + 1];
    if (next) e = Math.min(e, Math.round(next.start * fps) / fps);
    if (e - s < 0.4) e = s + 0.4;
    s = Math.max(s, made.length ? made[made.length - 1].start + made[made.length - 1].duration : 0);
    if (e <= s) return;
    const c = makeClip('text', { trackId: tr.id, start: s, duration: e - s, name: 'Altyazı', text: { ...style.text, content: it.text }, transform: { ...style.transform } });
    store.project.clips.push(c);
    made.push(c);
  });
  return made;
}

// ---------- SRT ----------
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export function toSrt(clips) {
  return clips.sort((a, b) => a.start - b.start).map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.start + c.duration)}\n${c.text.content}\n`).join('\n');
}
export function parseSrt(text) {
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map((x) => {
      const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(x.trim());
      return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null;
    });
    if (a == null || b == null) continue;
    out.push({ start: a, end: b, text: lines.slice(i + 1).join('\n').trim() });
  }
  return out;
}

export async function exportSrt() {
  const tr = store.project.tracks.find((x) => x.kind === 'video' && x.name === SUB_TRACK);
  const clips = store.project.clips.filter((c) => c.type === 'text' && (tr ? c.trackId === tr.id : true));
  if (!clips.length) return toast('Dışa aktarılacak altyazı yok', 'warn');
  const text = toSrt(clips);
  const name = (store.project.name || 'altyazi') + '.srt';
  if (isElectron) {
    const p = await native.saveExportDialog(name, 'srt');
    if (!p) return;
    await native.writeText(p, text);
    toast('SRT kaydedildi', 'ok');
  } else {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
    a.click();
  }
}

export async function importSrtText(text) {
  const items = parseSrt(text);
  if (!items.length) return toast('SRT dosyasında altyazı bulunamadı', 'warn');
  store.transact('SRT içe aktar', () => {
    const tr = subtitleTrack();
    const style = captionStyle();
    store.project.clips = store.project.clips.filter((c) => c.trackId !== tr.id);
    for (const it of items) store.project.clips.push(makeClip('text', { trackId: tr.id, start: it.start, duration: Math.max(0.2, it.end - it.start), name: 'Altyazı', text: { ...style.text, content: it.text }, transform: { ...style.transform } }));
  });
  toast(`${items.length} altyazı eklendi`, 'ok');
}

// ---------- otomatik altyazı ----------
let worker = null;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./workers/asr.js', import.meta.url), { type: 'module' });
  return worker;
}

export function transcribeDialog() {
  const P = store.project;
  const dur = store.duration();
  if (dur <= 0) return toast('Önce zaman çizelgesine sesli bir klip ekleyin', 'warn');
  const lang = h('select', { class: 'inp' }, ...Object.entries(LANGS).map(([k, v]) => h('option', { value: k }, v)));
  const model = h('select', { class: 'inp' }, ...Object.entries(MODELS).map(([k, v]) => h('option', { value: k }, v)));
  lang.value = localStorage.getItem('kurgu.asrLang') ?? 'turkish';
  model.value = localStorage.getItem('kurgu.asrModel') || 'onnx-community/whisper-small';
  const range = h('select', { class: 'inp' }, h('option', { value: 'all' }, `Tüm sekans (${formatTC(dur, store.fps)})`));
  if (P.inPoint != null || P.outPoint != null) range.append(h('option', { value: 'io', selected: true }, 'Giriş–Çıkış aralığı'));
  const sel = store.selectedClips();
  if (sel.length) range.append(h('option', { value: 'sel' }, 'Seçili kliplerin aralığı'));
  [lang, model, range].forEach((x) => x.addEventListener('keydown', (e) => e.stopPropagation()));
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted-p' }, 'Konuşma Whisper ile bilgisayarınızda yazıya dökülür ve "Altyazı" izine metin klipleri olarak eklenir. Model ilk kullanımda bir kez indirilir ve saklanır; ses hiçbir sunucuya gönderilmez.'),
    h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', {}, 'Dil'), lang), h('label', { class: 'field' }, h('span', {}, 'Model'), model)),
    h('label', { class: 'field' }, h('span', {}, 'Aralık'), range));
  modal({
    title: 'Otomatik Altyazı', body, width: 520,
    buttons: [{ label: 'Vazgeç' }, { label: 'Başlat', primary: true, action: () => {
      localStorage.setItem('kurgu.asrLang', lang.value);
      localStorage.setItem('kurgu.asrModel', model.value);
      let a = 0, b = dur;
      if (range.value === 'io') { a = P.inPoint ?? 0; b = P.outPoint ?? dur; }
      if (range.value === 'sel') { a = Math.min(...sel.map((c) => c.start)); b = Math.max(...sel.map((c) => c.start + c.duration)); }
      setTimeout(() => runTranscription({ a, b, model: model.value, language: lang.value || null }), 30);
    } }],
  });
}

export async function runTranscription({ a, b, model, language }) {
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const pct = h('div', { class: 'progress-pct' }, '');
  const info = h('div', { class: 'progress-info' }, 'Ses hazırlanıyor…');
  const prevBox = h('div', { class: 'asr-preview' });
  let cancelled = false;
  const dlg = modal({ title: 'Altyazı oluşturuluyor…', body: h('div', { class: 'export-run' }, h('div', { class: 'progress-row' }, bar, pct), info, prevBox), width: 520, dismissable: false,
    buttons: [{ label: 'İptal', danger: true, action: () => { cancelled = true; worker?.terminate(); worker = null; return true; } }] });
  const setP = (v, text) => { bar.firstChild.style.width = (clamp(v, 0, 1) * 100).toFixed(1) + '%'; pct.textContent = Math.round(v * 100) + '%'; if (text) info.textContent = text; };
  try {
    const pcm = await timelineAudio16k(a, b);
    if (!pcm) throw new Error('Aralıkta ses yok');
    const segs = smartSegments(pcm).map(([s, e]) => ({ audio: pcm.slice(s, e), offset: a + s / 16000 }));
    const w = getWorker();
    const files = new Map();
    const t0 = performance.now();
    const chunks = await new Promise((resolve, reject) => {
      w.onmessage = (ev) => {
        const d = ev.data;
        if (d.type === 'download' && d.data.status === 'progress' && d.data.total) {
          files.set(d.data.file, [d.data.loaded, d.data.total]);
          let l = 0, t = 0; for (const [x, y] of files.values()) { l += x; t += y; }
          setP(l / t * 0.3, `Model indiriliyor… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB (yalnızca ilk kullanımda)`);
        } else if (d.type === 'ready') setP(0.3, `Model hazır (${d.device === 'webgpu' ? 'GPU' : 'CPU'}). Konuşma yazıya dökülüyor…`);
        else if (d.type === 'progress') {
          const el = (performance.now() - t0) / 1000;
          setP(0.3 + 0.7 * (d.done / d.total), `Yazıya dökülüyor… ${d.done}/${d.total} parça · ${el.toFixed(0)} sn`);
          for (const c of d.chunks) prevBox.append(h('div', {}, h('b', {}, formatTC(c.start, store.fps).slice(3, 8) + '  '), c.text));
          prevBox.scrollTop = prevBox.scrollHeight;
        } else if (d.type === 'done') resolve(d.chunks);
        else if (d.type === 'error') reject(new Error(d.message));
      };
      w.onerror = (e) => reject(new Error(e.message || 'İşçi hatası'));
      w.postMessage({ type: 'run', segments: segs, model, language }, segs.map((s) => s.audio.buffer));
    });
    if (cancelled) return;
    dlg.close();
    if (!chunks.length) return toast('Konuşma algılanamadı', 'warn');
    let made = [];
    store.transact('Otomatik altyazı', () => { made = placeCaptions(chunks); });
    toast(`${made.length} altyazı eklendi ("${SUB_TRACK}" izi). Metinleri denetçiden düzenleyebilirsiniz.`, 'ok', 4500);
    return made;
  } catch (e) {
    if (cancelled) return;
    dlg.close();
    toast('Altyazı oluşturulamadı: ' + e.message, 'err', 6000);
  }
}

export function importSrtDialog() {
  const inp = h('input', { type: 'file', accept: '.srt,text/plain' });
  inp.onchange = async () => { const f = inp.files[0]; if (f) importSrtText(await f.text()); };
  inp.click();
}
