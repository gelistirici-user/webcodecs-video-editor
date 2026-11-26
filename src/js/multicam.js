// Çok kameralı kurgu: açıları sese göre senkronla, çok kameralı kaynak sekansı oluştur, açılar arasında kes
import { store, makeClip } from './store.js';
import { h, uid, clamp, EPS } from './utils.js';
import { modal, toast } from './ui.js';

// Sese göre gecikme: b'nin a'ya göre ne kadar sonra başladığı (sn). Zarflar 100 Hz tepe dizileri.
export function audioOffset(pa, pb, rate = 100, maxLag = 60) {
  const ds = (p, f) => { const n = Math.floor(p.length / f), o = new Float32Array(n); for (let i = 0; i < n; i++) { let m = 0; for (let k = 0; k < f; k++) m = Math.max(m, p[i * f + k]); o[i] = m; } return o; };
  const norm = (x) => { let s = 0; for (const v of x) s += v; const mu = s / x.length; let q = 0; const o = x.map((v) => v - mu); for (const v of o) q += v * v; const sd = Math.sqrt(q / o.length) || 1; return o.map((v) => v / sd); };
  const corr = (A, B, lag) => { let s = 0, n = 0; for (let i = 0; i < A.length; i++) { const j = i - lag; if (j < 0 || j >= B.length) continue; s += A[i] * B[j]; n++; } return n > 50 ? s / n : -Infinity; };
  // kaba (20 Hz) arama
  const f = Math.round(rate / 20);
  const A = norm(ds(pa.subarray(0, Math.min(pa.length, rate * 180)), f)), B = norm(ds(pb.subarray(0, Math.min(pb.length, rate * 180)), f));
  const L = Math.round(maxLag * 20);
  let best = -Infinity, bl = 0;
  for (let lag = -L; lag <= L; lag++) { const c = corr(A, B, lag); if (c > best) { best = c; bl = lag; } }
  // ince (100 Hz) iyileştirme
  const A2 = norm(pa.subarray(0, Math.min(pa.length, rate * 180))), B2 = norm(pb.subarray(0, Math.min(pb.length, rate * 180)));
  let best2 = -Infinity, bl2 = bl * f;
  for (let lag = bl * f - f; lag <= bl * f + f; lag++) { const c = corr(A2, B2, lag); if (c > best2) { best2 = c; bl2 = lag; } }
  return { offset: bl2 / rate, score: best2 };
}

// Çok kameralı kaynak sekansı: her açı ayrı video izinde, sesler ayrı ses izlerinde
export function createMulticamSequence(medias, offsets, name) {
  const P = store.project;
  store.ensureSeqs();
  const min = Math.min(...offsets);
  const tracks = [];
  medias.forEach((_, i) => tracks.push({ id: uid('t'), kind: 'video', name: `Kamera ${i + 1}`, muted: false, locked: false, hidden: false }));
  medias.forEach((m, i) => { if (m.hasAudio) tracks.push({ id: uid('t'), kind: 'audio', name: `Ses ${i + 1}`, muted: false, locked: false, solo: false, volume: 1, angle: i }); });
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push({ id: uid('t'), kind: 'audio', name: 'A1', muted: false, locked: false, solo: false, volume: 1 });
  const clips = [];
  medias.forEach((m, i) => {
    const start = offsets[i] - min;
    const vt = tracks.filter((t) => t.kind === 'video')[i];
    clips.push(makeClip('media', { mediaId: m.id, trackId: vt.id, start, in: 0, duration: m.duration, name: m.name }));
    const at = tracks.find((t) => t.kind === 'audio' && t.angle === i);
    if (at) clips.push(makeClip('media', { mediaId: m.id, trackId: at.id, start, in: 0, duration: m.duration, name: m.name }));
  });
  const q = { id: uid('s'), name, multicam: true, tracks, clips, markers: [], inPoint: null, outPoint: null };
  P.sequences.push(q);
  return q;
}

export function placeMulticam(q, at) {
  const P = store.project;
  const d = q.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const vt = store.videoTracks()[0], au = store.audioTracks()[0];
  const link = uid('l');
  const made = [];
  for (const t of [vt, au]) {
    store.clearRange(t.id, at, at + d);
    const c = makeClip('seq', { seqId: q.id, trackId: t.id, start: at, duration: d, linkId: link, name: q.name, multicam: true, angle: 0, audioAngle: 0 });
    P.clips.push(c); made.push(c);
  }
  return made;
}

export function multicamDialog() {
  const sel = store.selectedClips().filter((c) => c.type === 'media' && store.media(c.mediaId)?.kind === 'video' && store.track(c.trackId).kind === 'video');
  let medias = [...new Set(sel.map((c) => c.mediaId))].map((id) => store.media(id));
  if (medias.length < 2) medias = store.project.media.filter((m) => m.kind === 'video' && !m.offline);
  if (medias.length < 2) return toast('Çok kameralı kaynak için en az iki video gerekir', 'warn');
  const checks = h('div', { class: 'chk-list' }, ...medias.map((m, i) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', value: m.id, checked: i < 9 }), h('span', {}, m.name))));
  const method = h('select', { class: 'inp' }, h('option', { value: 'audio' }, 'Sese göre (önerilen)'), h('option', { value: 'start' }, 'Başlangıçlar hizalı'));
  method.addEventListener('keydown', (e) => e.stopPropagation());
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted-p' }, 'Aynı anda kaydedilmiş açılar tek bir çok kameralı klipte birleştirilir. Monitörde "Çok Kamera" sekmesinde oynatırken 1–9 tuşlarıyla (veya karelere tıklayarak) açılar arasında kesin.'),
    h('div', { class: 'field' }, h('span', {}, 'Açılar (sıra = kamera numarası)'), checks),
    h('label', { class: 'field' }, h('span', {}, 'Senkronizasyon'), method));
  modal({
    title: 'Çok Kameralı Kaynak Oluştur', body, width: 480,
    buttons: [{ label: 'Vazgeç' }, { label: 'Oluştur', primary: true, action: () => {
      const ids = [...checks.querySelectorAll('input:checked')].map((x) => x.value).slice(0, 9);
      if (ids.length < 2) { toast('En az iki açı seçin', 'warn'); return false; }
      const ms = ids.map((id) => store.media(id));
      let offsets = ms.map(() => 0), info = '';
      if (method.value === 'audio') {
        const pk = ms.map((m) => store.mediaCache.get(m.id)?.peaks);
        if (pk.some((p) => !p)) { toast('Dalga formları henüz hazır değil; birkaç saniye sonra tekrar deneyin', 'warn', 3500); return false; }
        const res = pk.map((p, i) => (i === 0 ? { offset: 0, score: 1 } : audioOffset(pk[0], p)));
        offsets = res.map((r) => r.offset); // açı i, ilk açıya göre bu kadar sonra başlar
        const weak = res.slice(1).filter((r) => r.score < 0.25).length;
        info = weak ? ` (${weak} açının ses eşleşmesi zayıf; kontrol edin)` : '';
      }
      store.transact('Çok kameralı kaynak', () => {
        const q = createMulticamSequence(ms, offsets, `Çok Kamera ${store.sequenceList().filter((x) => /^Çok Kamera/.test(x.name)).length + 1}`);
        const made = placeMulticam(q, store.playhead);
        store.select(made.map((c) => c.id));
      });
      toast('Çok kameralı klip eklendi' + info + '. Monitörde "Çok Kamera" sekmesini açın.', info ? 'warn' : 'ok', 5000);
    } }],
  });
}

// Oynatma kafasındaki (en üstteki) çok kameralı video klip
export function multicamAt(t) {
  const vts = store.videoTracks();
  for (let i = vts.length - 1; i >= 0; i--) {
    const c = store.project.clips.find((x) => x.trackId === vts[i].id && x.multicam && t >= x.start - EPS && t < x.start + x.duration - EPS);
    if (c) return c;
  }
  return null;
}

// Açı değiştir: oynatma kafasında keser ve sağ parçaya yeni açıyı verir
export function switchAngle(k, { audio = false } = {}) {
  const t = store.playhead;
  const c = multicamAt(t);
  if (!c) return false;
  const q = store.seqData(c.seqId);
  const nAngles = q.tracks.filter((x) => x.kind === 'video').length;
  if (k >= nAngles) return false;
  const key = audio ? 'audioAngle' : 'angle';
  const target = audio ? store.linked(c).find((x) => store.track(x.trackId).kind === 'audio') : c;
  if (!target) return false;
  if (target[key] === k) return true;
  store.transact(audio ? 'Ses açısı' : `Kamera ${k + 1}`, () => {
    const fps = store.fps;
    const tt = Math.round(t * fps) / fps;
    if (tt - target.start < 1 / fps + EPS) { target[key] = k; return; }
    const right = store.splitClip(target, tt);
    if (right) right[key] = k;
  });
  return true;
}
