// Sekans sekmeleri: birden çok sekans, iç içe sekans (nest)
import { store } from './store.js';
import { h } from './utils.js';
import { contextMenu, toast, promptDialog, confirmDialog } from './ui.js';

export function openSequence(id) {
  if (id === store.project.activeSeq?.id) return;
  store.transact('Sekansa geç', () => store.switchSequence(id));
  store.emit('selection');
  store.emit('sequence', id);
  store.emit('playhead', store.playhead);
}

export async function newSequence() {
  const name = await promptDialog('Yeni sekans', 'Sekans adı', `Sekans ${store.sequenceList().length + 1}`);
  if (!name) return;
  let q;
  store.transact('Yeni sekans', () => { q = store.newSequence(name.slice(0, 40)); });
  openSequence(q.id);
}

export async function nestSelection() {
  if (!store.selection.size) return toast('Önce iç içe sekansa dönüştürülecek klipleri seçin', 'warn');
  const name = await promptDialog('İç içe sekans', 'Yeni sekansın adı', `İç içe ${store.sequenceList().length}`);
  if (!name) return;
  store.transact('İç içe sekans', () => store.nestSelection(name.slice(0, 40)));
  store.emit('selection');
  toast('Seçim iç içe sekansa dönüştürüldü. Düzenlemek için klibe çift tıklayın.', 'ok', 3500);
}

export function insertSequence(id) {
  if (store.seqContains(id, store.project.activeSeq.id)) return toast('Bir sekans kendi içine (dolaylı da olsa) yerleştirilemez', 'warn', 3500);
  let made;
  store.transact('Sekansı yerleştir', () => { made = store.placeSequence(id, store.playhead); });
  if (!made) toast('Sekans boş', 'warn'); else store.select(made.map((c) => c.id));
}

export function buildSeqTabs(root) {
  const render = () => {
    root.innerHTML = '';
    const list = store.sequenceList();
    for (const q of list) {
      const tab = h('button', { class: 'seq-tab' + (q.active ? ' on' : ''), title: q.active ? `${q.name} (etkin) · Çift tık: yeniden adlandır · Sağ tık: seçenekler` : `${q.name} sekansına geç`, role: 'tab', 'aria-selected': String(q.active) }, q.name);
      tab.onclick = () => openSequence(q.id);
      tab.ondblclick = async () => {
        const n = await promptDialog('Sekansı yeniden adlandır', 'Sekans adı', q.name);
        if (n) store.transact('Sekans adı', () => {
          store.renameSequence(q.id, n.slice(0, 40));
          // bu sekansa başvuran iç içe kliplerin adları
          const all = [store.project.clips, ...store.project.sequences.map((x) => x.clips)];
          all.forEach((cl) => cl.forEach((c) => { if (c.type === 'seq' && c.seqId === q.id) c.name = n.slice(0, 40); }));
        });
      };
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Aç', disabled: q.active, action: () => openSequence(q.id) },
          { label: 'Etkin sekansa iç içe yerleştir', disabled: q.active, action: () => insertSequence(q.id) },
          { label: 'Yeniden adlandır…', action: () => tab.ondblclick() },
          '-',
          { label: 'Sil', danger: true, disabled: q.active || list.length < 2, action: async () => {
            const r = await confirmDialog('Sekansı sil', `"${q.name}" silinsin mi? Bu sekansı kullanan iç içe klipler de kaldırılır.`, 'Sil', true);
            if (r === 'ok') store.transact('Sekansı sil', () => store.deleteSequence(q.id));
          } },
        ]);
      };
      root.append(tab);
    }
    const add = h('button', { class: 'seq-tab add', title: 'Yeni sekans', 'aria-label': 'Yeni sekans' }, '+');
    add.onclick = newSequence;
    root.append(add);
  };
  store.on('change', (d) => { if (!d?.live) render(); });
  store.on('load', render);
  store.on('sequence', render);
  render();
}
