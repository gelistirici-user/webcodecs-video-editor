// Render kuyruğu: dışa aktarmalar sırayla arka planda işlenir; bu sırada kurguya devam edilebilir
import { store } from './store.js';
import { h, formatDur, formatTC } from './utils.js';
import { modal, toast } from './ui.js';
import { exportVideo } from './exporter.js';
import { isElectron, native } from './platform.js';

const jobs = [];
let running = null;
let paused = false;
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
export const onQueue = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const queueJobs = () => jobs;
export const queueBusy = () => !!running;

const LABEL = { wait: 'Bekliyor', run: 'İşleniyor', done: 'Tamamlandı', err: 'Hata', cancel: 'İptal edildi' };

export function addJob(opts) {
  const job = {
    id: Math.random().toString(36).slice(2),
    name: opts.fname,
    opts,
    project: JSON.parse(JSON.stringify(store.project)), // eklendiği andaki hali
    status: 'wait', progress: 0, info: '', added: Date.now(),
  };
  jobs.push(job);
  emit();
  toast(`Kuyruğa eklendi: ${job.name}`, 'ok');
  if (!running && !paused) runNext();
  return job;
}

async function runNext() {
  if (running || paused) return;
  const j = jobs.find((x) => x.status === 'wait');
  if (!j) return;
  running = j;
  j.status = 'run'; j.ctrl = new AbortController(); j.t0 = performance.now();
  emit();
  try {
    const res = await exportVideo({ ...j.opts, project: j.project, signal: j.ctrl.signal, onProgress: (p) => {
      j.progress = p.progress;
      j.info = p.phase === 'audio' ? 'Ses karıştırılıyor…' : p.phase === 'finalize' ? 'Tamamlanıyor…' : `${p.fps.toFixed(1)} kare/sn · kalan ~${formatDur(p.eta)}`;
      emit();
    } });
    j.status = 'done'; j.progress = 1;
    j.info = `${((performance.now() - j.t0) / 1000).toFixed(1)} sn`;
    if (res.blob) { const a = h('a', { href: URL.createObjectURL(res.blob), download: j.name }); a.click(); } else j.path = res.path;
  } catch (e) {
    j.status = e.name === 'AbortError' ? 'cancel' : 'err';
    j.info = j.status === 'err' ? e.message : '';
  }
  running = null;
  emit();
  if (!jobs.some((x) => x.status === 'wait')) {
    const ok = jobs.filter((x) => x.status === 'done').length;
    toast(`Render kuyruğu bitti (${ok} tamamlandı)`, 'ok', 5000);
  }
  runNext();
}

export function setPaused(v) { paused = v; emit(); if (!v) runNext(); }

export function queueDialog() {
  const list = h('div', { class: 'q-list' });
  const pauseBtn = h('button', { class: 'btn sm' });
  const render = () => {
    list.innerHTML = '';
    if (!jobs.length) list.append(h('p', { class: 'muted-p' }, 'Kuyruk boş. Dışa Aktar penceresinde "Kuyruğa ekle" ile iş ekleyin; işler arka planda sırayla işlenir, siz kurguya devam edebilirsiniz.'));
    for (const j of jobs) {
      const o = j.opts;
      const bar = h('div', { class: 'progress sm' }, h('div', { class: 'progress-fill', style: { width: (j.progress * 100).toFixed(1) + '%' } }));
      const acts = h('div', { class: 'q-acts' });
      if (j.status === 'run') acts.append(h('button', { class: 'btn sm danger', onclick: () => j.ctrl.abort() }, 'İptal'));
      if (j.status === 'wait') acts.append(h('button', { class: 'btn sm', onclick: () => { j.status = 'cancel'; emit(); } }, 'Atla'));
      if (j.status === 'done' && j.path && isElectron) acts.append(h('button', { class: 'btn sm', onclick: () => native.showItem(j.path) }, 'Klasörde göster'));
      if (j.status === 'err' || j.status === 'cancel') acts.append(h('button', { class: 'btn sm', onclick: () => { j.status = 'wait'; j.progress = 0; j.info = ''; emit(); runNext(); } }, 'Yeniden dene'));
      if (j.status !== 'run') acts.append(h('button', { class: 'btn sm ghost', onclick: () => { jobs.splice(jobs.indexOf(j), 1); emit(); } }, 'Kaldır'));
      list.append(h('div', { class: 'q-item q-' + j.status },
        h('div', { class: 'q-top' }, h('b', { class: 'q-name', title: j.path || j.name }, j.name), h('span', { class: 'q-st' }, LABEL[j.status])),
        h('div', { class: 'q-meta' }, `${o.format.toUpperCase()} · ${o.width}×${o.height} · ${(o.bitrate / 1e6).toFixed(1)} Mbps · ${formatTC(o.rangeEnd - o.rangeStart, o.fps)}`),
        bar, h('div', { class: 'q-bottom' }, h('span', { class: 'q-info' }, j.info || ''), acts)));
    }
    pauseBtn.textContent = paused ? 'Kuyruğu başlat' : 'Kuyruğu duraklat';
  };
  pauseBtn.onclick = () => setPaused(!paused);
  const off = onQueue(render);
  render();
  modal({ title: 'Render Kuyruğu', body: h('div', {}, list, h('div', { class: 'btn-row' }, pauseBtn, h('button', { class: 'btn sm ghost', onclick: () => { for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].status === 'done') jobs.splice(i, 1); emit(); } }, 'Tamamlananları temizle'))), width: 560, onClose: off });
}
