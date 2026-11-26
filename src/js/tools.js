// Araçlar menüsü: ses normalleştirme, otomatik ducking (ve diğer otomatik kurgu araçları)
import { store } from './store.js';
import { h, EPS, formatDur } from './utils.js';
import { srcTimeAt } from './timemap.js';
import { valueAt } from './keyframes.js';
import { modal, toast } from './ui.js';
import { normalizeClips, autoDuck } from './audiofx.js';

const audioSel = () => store.selectedClips().filter((c) => store.track(c.trackId)?.kind === 'audio' && c.type === 'media');

export async function normalizeSelected(mode) {
  let clips = audioSel();
  if (!clips.length) {
    // video seçiliyse bağlı ses klibi
    clips = store.selectedClips().flatMap((c) => store.linked(c)).filter((c) => store.track(c.trackId)?.kind === 'audio' && c.type === 'media');
  }
  if (!clips.length) return toast('Önce bir ses klibi (veya sesli video) seçin', 'warn');
  toast('Ses düzeyi ölçülüyor…', 'info', 1500);
  const res = await normalizeClips(clips, mode);
  if (!res.length) return toast('Ölçülebilir ses bulunamadı', 'warn');
  store.transact(mode === 'peak' ? 'Normalleştir (tepe)' : 'Normalleştir (ses yüksekliği)', () => res.forEach(({ c, vol }) => {
    const k = store.clip(c.id);
    if (!k) return;
    if (k.kf?.volume) delete k.kf.volume;
    k.volume = vol;
  }));
  const db = (v) => (20 * Math.log10(v)).toFixed(1);
  toast(`${res.length} klip normalleştirildi (${res.map((r) => (r.vol >= 1 ? '+' : '') + db(r.vol) + ' dB').join(', ')})`, 'ok', 3500);
}

export function duckDialog() {
  const at = store.audioTracks();
  if (at.length < 2) return toast('Ducking için en az iki ses izi gerekir (konuşma + müzik)', 'warn', 3500);
  const has = (tid) => store.project.clips.some((c) => c.trackId === tid);
  const used = at.filter((t) => has(t.id));
  const voiceDef = used[0] || at[0];
  const musicDef = used[1] || at[at.length - 1];
  const checks = (name, def) => h('div', { class: 'chk-list' }, ...at.map((t) => h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', name, value: t.id, checked: t.id === def.id }), h('span', {}, t.name + (has(t.id) ? '' : ' (boş)')))));
  const voice = checks('voice', voiceDef), music = checks('music', musicDef);
  const db = h('input', { class: 'inp', type: 'number', min: -40, max: -1, step: 1, value: -14 });
  const thr = h('input', { type: 'range', class: 'slider', min: 1, max: 30, step: 1, value: 6 });
  const thrLbl = h('span', { class: 'muted-p' }, '6%');
  thr.oninput = () => { thrLbl.textContent = thr.value + '%'; };
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted-p' }, 'Konuşma olan yerlerde müzik otomatik olarak kısılır (ses seviyesi anahtar kareleri oluşturulur, sonradan düzenlenebilir).'),
    h('div', { class: 'row2' }, h('div', { class: 'field' }, h('span', {}, 'Konuşma izleri'), voice), h('div', { class: 'field' }, h('span', {}, 'Kısılacak (müzik) izler'), music)),
    h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', {}, 'Kısma miktarı (dB)'), db),
      h('label', { class: 'field' }, h('span', {}, 'Konuşma eşiği'), h('div', { class: 'range-row' }, thr, thrLbl))));
  modal({
    title: 'Otomatik Ducking', body, width: 520,
    buttons: [{ label: 'Vazgeç' }, { label: 'Uygula', primary: true, action: () => {
      const v = [...voice.querySelectorAll('input:checked')].map((x) => x.value);
      const m = [...music.querySelectorAll('input:checked')].map((x) => x.value).filter((x) => !v.includes(x));
      if (!v.length || !m.length) { toast('Konuşma ve müzik için farklı izler seçin', 'warn'); return false; }
      const missing = store.project.clips.filter((c) => v.includes(c.trackId) && c.type === 'media' && !store.mediaCache.get(c.mediaId)?.peaks).length;
      if (missing) toast('Bazı kliplerin dalga formu henüz hazır değil; birkaç saniye sonra tekrar deneyin', 'warn', 3500);
      let r;
      store.transact('Otomatik ducking', () => { r = autoDuck({ musicTrackIds: m, voiceTrackIds: v, duckDb: parseFloat(db.value) || -14, threshold: parseFloat(thr.value) / 100 }); });
      toast(r.clips ? `${r.regions} konuşma bölgesi bulundu, ${r.clips} müzik klibi ayarlandı` : 'Müzik izlerinde konuşmayla çakışan klip yok', r.clips ? 'ok' : 'warn', 3500);
    } }],
  });
}

// ---------- sessizlikleri kes ----------
// Klibin sesinde eşik altında kalan, en az minDur süren aralıklar (zaman çizelgesi zamanı)
export function findSilences(c, { thresholdDb = -38, minDur = 0.6, pad = 0.15 } = {}) {
  const m = store.media(c.mediaId);
  const cache = store.mediaCache.get(c.mediaId);
  if (!m || !cache?.peaks) return null;
  const { peaks, peaksRate } = cache;
  const thr = Math.pow(10, thresholdDb / 20);
  const step = 1 / 50;
  const out = [];
  let runStart = null;
  const end = c.start + c.duration;
  for (let t = c.start; t < end + step / 2; t += step) {
    let quiet = t < end;
    if (quiet) {
      let a = srcTimeAt(c, t, m), b = srcTimeAt(c, Math.min(end, t + step), m);
      if (b < a) [a, b] = [b, a];
      let mx = 0;
      for (let k = Math.floor(a * peaksRate); k <= Math.floor(b * peaksRate); k++) mx = Math.max(mx, peaks[k] || 0);
      quiet = mx * valueAt(c, 'volume', t) < thr;
    }
    if (quiet && runStart == null) runStart = t;
    if (!quiet && runStart != null) {
      const a = runStart + (runStart > c.start + EPS ? pad : 0), b = Math.min(end, t) - (t < end - EPS ? pad : 0);
      if (b - a >= Math.max(minDur - 2 * pad, 0.05)) out.push([a, b]);
      runStart = null;
    }
  }
  return out;
}

function silenceTargets() {
  const sel = store.selectedClips();
  const audio = new Map();
  for (const c of sel) for (const k of store.linked(c)) if (store.track(k.trackId)?.kind === 'audio' && k.type === 'media') audio.set(k.id, k);
  return [...audio.values()];
}

export function removeSilences(ranges, groupOf) {
  // sondan başa: önceki aralıkların zamanları kaymaz
  const fps = store.fps;
  let removed = 0;
  for (const { range: [a0, b0], audioId } of [...ranges].sort((x, y) => y.range[0] - x.range[0])) {
    const a = Math.round(a0 * fps) / fps, b = Math.round(b0 * fps) / fps;
    if (b - a < 1 / fps) continue;
    const anchor = store.project.clips.find((k) => k.id === audioId) || null;
    const group = groupOf(anchor, a, b);
    if (!group.length) continue;
    store.splitAt(group, a);
    const g2 = groupOf(anchor, a, b, true);
    store.splitAt(g2, b);
    const tracks = new Set(group.map((k) => k.trackId));
    const mid = store.project.clips.filter((k) => tracks.has(k.trackId) && Math.abs(k.start - a) < 1e-3 && Math.abs(k.start + k.duration - b) < 1e-3);
    if (!mid.length) continue;
    store.removeClips(new Set(mid.map((k) => k.id)), true);
    removed += b - a;
  }
  return removed;
}

export function silenceDialog() {
  const targets = silenceTargets();
  if (!targets.length) return toast('Önce sesli bir klip seçin (video seçerseniz bağlı sesi kullanılır)', 'warn', 3500);
  if (targets.some((c) => !store.mediaCache.get(c.mediaId)?.peaks)) return toast('Dalga formu henüz hazırlanıyor; birkaç saniye sonra tekrar deneyin', 'warn', 3500);
  const thr = h('input', { type: 'range', class: 'slider', min: -60, max: -20, step: 1, value: -38 });
  const thrL = h('span', { class: 'muted-p' });
  const minD = h('input', { class: 'inp', type: 'number', min: 0.2, max: 5, step: 0.1, value: 0.6 });
  const pad = h('input', { class: 'inp', type: 'number', min: 0, max: 1, step: 0.05, value: 0.15 });
  const info = h('div', { class: 'export-sum' });
  let found = [];
  const calc = () => {
    thrL.textContent = thr.value + ' dB';
    const o = { thresholdDb: +thr.value, minDur: +minD.value || 0.6, pad: +pad.value || 0 };
    found = targets.flatMap((c) => (findSilences(c, o) || []).map((range) => ({ range, audioId: c.id })));
    // aynı bağlantılı gruptaki çakışan aralıkları tekilleştir
    found.sort((x, y) => x.range[0] - y.range[0]);
    const merged = [];
    for (const f of found) { const l = merged[merged.length - 1]; if (l && f.range[0] <= l.range[1]) l.range[1] = Math.max(l.range[1], f.range[1]); else merged.push({ range: [...f.range], audioId: f.audioId }); }
    found = merged;
    const total = found.reduce((s, f) => s + f.range[1] - f.range[0], 0);
    info.innerHTML = '';
    info.append(h('div', {}, h('span', {}, 'Sessiz bölüm'), h('b', {}, String(found.length))), h('div', {}, h('span', {}, 'Kısalacak süre'), h('b', {}, formatDur(total) + ` (${total.toFixed(1)} sn)`)));
  };
  [thr, minD, pad].forEach((x) => x.addEventListener('input', calc));
  [minD, pad].forEach((x) => x.addEventListener('keydown', (e) => e.stopPropagation()));
  calc();
  const body = h('div', { class: 'form' },
    h('p', { class: 'muted-p' }, 'Seçili kliplerdeki sessiz yerler kesilir ve boşluklar kapatılır (bağlı video ile birlikte). Geri alınabilir.'),
    h('label', { class: 'field' }, h('span', {}, 'Sessizlik eşiği'), h('div', { class: 'range-row' }, thr, thrL)),
    h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', {}, 'En kısa sessizlik (sn)'), minD), h('label', { class: 'field' }, h('span', {}, 'Kenar payı (sn)'), pad)),
    info);
  modal({
    title: 'Sessizlikleri Kes', body, width: 480,
    buttons: [{ label: 'Vazgeç' }, { label: 'Kes', primary: true, action: () => {
      if (!found.length) { toast('Kesilecek sessiz bölüm bulunamadı', 'warn'); return false; }
      const groupOf = (anchor, a, b) => {
        if (!anchor) return [];
        const linked = store.linked(anchor);
        // aralığı kapsayan aynı gruptaki parçalar
        const tracks = new Set(linked.map((k) => k.trackId));
        return store.project.clips.filter((k) => tracks.has(k.trackId) && k.start < b - 1e-3 && k.start + k.duration > a + 1e-3);
      };
      let total = 0;
      store.transact('Sessizlikleri kes', () => { total = removeSilences(found, groupOf); });
      toast(`${found.length} sessiz bölüm kesildi, ${total.toFixed(1)} sn kısaldı`, 'ok', 3500);
    } }],
  });
}
