// Araçlar menüsü: ses normalleştirme, otomatik ducking (ve diğer otomatik kurgu araçları)
import { store } from './store.js';
import { h } from './utils.js';
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
