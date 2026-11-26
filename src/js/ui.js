// Ortak arayüz parçaları: bağlam menüsü, bildirim, modal pencereler, ikonlar
import { h } from './utils.js';

export const ICONS = {
  play: '<path d="M7 5v14l11-7z"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  stepBack: '<path d="M6 6h2v12H6zM20 6v12l-9-6z"/>',
  stepFwd: '<path d="M16 6h2v12h-2zM4 6v12l9-6z"/>',
  toStart: '<path d="M5 5h2v14H5zM19 5v14L9 12z"/><path d="M9 12"/>',
  toEnd: '<path d="M17 5h2v14h-2zM5 5v14l10-7z"/>',
  loop: '<path d="M17 4l3 3-3 3V8H7a3 3 0 0 0-3 3v1H2v-1a5 5 0 0 1 5-5h10zM7 20l-3-3 3-3v2h10a3 3 0 0 0 3-3v-1h2v1a5 5 0 0 1-5 5H7z"/>',
  select: '<path d="M5 3l14 8-6 1.5L16 20l-2.5 1-3-7.5L5 18z"/>',
  razor: '<path d="M9.6 7.6a3.5 3.5 0 1 0-1.4 1.4L10.6 12l-2.4 3a3.5 3.5 0 1 0 1.4 1.4L12 13.4l7 7.6h2.5zM6.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM14.6 9.4 21.5 3H19l-6.2 4.8z"/>',
  magnet: '<path d="M4 3h5v8a3 3 0 0 0 6 0V3h5v8a8 8 0 0 1-16 0zm2 2v3h1V5zm11 0v3h1V5z"/>',
  link: '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8.5 19.5a4.5 4.5 0 0 1-3.2-7.7l2.1-2.1 1.4 1.4-2.1 2.1a2.5 2.5 0 0 0 3.5 3.5l2.1-2.1 1.4 1.4-2.1 2.1a4.5 4.5 0 0 1-3.1 1.4zm8.1-5.2-1.4-1.4 2.1-2.1a2.5 2.5 0 0 0-3.5-3.5l-2.1 2.1-1.4-1.4 2.1-2.1a4.5 4.5 0 0 1 6.4 6.4z"/>',
  eye: '<path d="M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/>',
  eyeOff: '<path d="M3.3 2 22 20.7 20.7 22l-3.4-3.4A10.6 10.6 0 0 1 12 20c-5 0-9-4.5-10-7a13 13 0 0 1 4.4-5.3L2 3.3zM12 5c5 0 9 4.5 10 7a12.6 12.6 0 0 1-2.8 3.8l-3.2-3.2A4 4 0 0 0 11.4 8z"/>',
  lock: '<path d="M7 10V7a5 5 0 0 1 10 0v3h1.5v11h-13V10zm2 0h6V7a3 3 0 0 0-6 0z"/>',
  unlock: '<path d="M7 10V7a5 5 0 0 1 9.6-2l-1.8.9A3 3 0 0 0 9 7v3h9.5v11h-13V10z"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2zM18.4 6a8.5 8.5 0 0 1 0 12L17 16.6a6.5 6.5 0 0 0 0-9.2z"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4zM16.3 9.3l1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1z"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z"/>',
  import: '<path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3zM4 18h16v3H4z"/>',
  film: '<path d="M4 4h16v16H4zm2 2v2h2V6zm10 0v2h2V6zM6 10v4h12v-4zm0 6v2h2v-2zm10 0v2h2v-2z"/>',
  music: '<path d="M9 4l11-2v13.5a3 3 0 1 1-2-2.8V6.4L11 7.6v10a3 3 0 1 1-2-2.8z"/>',
  image: '<path d="M3 4h18v16H3zm2 2v10l4-4 3 3 4-5 3 4V6zm3 1.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/>',
  text: '<path d="M4 4h16v4h-2V6h-5v12h2v2H9v-2h2V6H6v2H4z"/>',
  marker: '<path d="M6 3h12v13l-6 5-6-5z"/>',
  fullscreen: '<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/>',
  camera: '<path d="M9 4h6l1.5 2H21v14H3V6h4.5zm3 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>',
  grid: '<path d="M3 3h18v18H3zm2 2v14h14V5zm2 2h10v10H7z" fill-rule="evenodd"/>',
  undo: '<path d="M8 7V3L2 9l6 6v-4h6a4 4 0 0 1 0 8h-3v2h3a6 6 0 0 0 0-12z"/>',
  redo: '<path d="M16 7V3l6 6-6 6v-4h-6a4 4 0 0 0 0 8h3v2h-3a6 6 0 0 1 0-12z"/>',
  export: '<path d="M12 2l5 5-1.4 1.4L13 5.8V15h-2V5.8L8.4 8.4 7 7zM4 13h2v6h12v-6h2v8H4z"/>',
  save: '<path d="M4 3h13l4 4v14H3V3zm3 2v5h9V5zm5 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  folder: '<path d="M3 5h7l2 2h9v13H3z"/>',
  close: '<path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/>',
  reset: '<path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>',
  search: '<path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/>',
  split: '<path d="M11 2h2v20h-2zM3 7h6v10H3zm12 0h6v10h-6z"/>',
  help: '<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 14a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zM12 6a4 4 0 0 0-4 4h2a2 2 0 1 1 3 1.7c-1.2.7-2 1.6-2 3.3h2c0-1 .4-1.4 1.1-1.9A4 4 0 0 0 12 6z"/>',
  gear: '<path d="M10.3 2h3.4l.5 2.6 1.6.9 2.5-.9 1.7 3-2 1.7v1.8l2 1.7-1.7 3-2.5-.9-1.6.9-.5 2.6h-3.4l-.5-2.6-1.6-.9-2.5.9-1.7-3 2-1.7v-1.8l-2-1.7 1.7-3 2.5.9 1.6-.9zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  zoomIn: '<path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm-1 3v3H6v2h3v3h2v-3h3V9h-3V6z"/>',
  zoomOut: '<path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zM6 9v2h8V9z"/>',
  wand: '<path d="m14 2 1 2.5L17.5 5 15 6l-1 2.5L13 6l-2.5-1L13 4zM5.4 13.6l9-9 4 4-9 9zm-1.4 1.4 4 4L6.6 20.4l-4-4zM19 12l.7 1.8 1.8.7-1.8.7L19 17l-.7-1.8-1.8-.7 1.8-.7z"/>',
  chevron: '<path d="M7 9l5 5 5-5z"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-1-.8-1.4-.8-2.3 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5zM7 12.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>',
  scissors: '<path d="M9.6 7.6a3.5 3.5 0 1 0-1.4 1.4L10.6 12l-2.4 3a3.5 3.5 0 1 0 1.4 1.4L12 13.4l7 7.6h2.5zM6.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM14.6 9.4 21.5 3H19l-6.2 4.8z"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7zm-7.8 8.9L12 14.8l7.8-3.9L22 12l-10 5-10-5zm0 5L12 19.8l7.8-3.9L22 17l-10 5-10-5z"/>',
};

export function icon(name, size = 18) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function iconEl(name, size) {
  const span = document.createElement('span');
  span.className = 'ic-wrap';
  span.innerHTML = icon(name, size);
  return span.firstChild;
}

// ---------- bağlam menüsü ----------
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(h('div', { class: 'ctx-sep' })); continue; }
    const b = h('button', { class: 'ctx-item' + (it.danger ? ' danger' : ''), role: 'menuitem', disabled: !!it.disabled },
      h('span', { class: 'ctx-label' }, it.label),
      it.shortcut ? h('span', { class: 'ctx-sc' }, it.shortcut) : null);
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.action?.(); });
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  openMenu = menu;
  menu.querySelector('button:not([disabled])')?.focus();
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('button:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { btns[(i + 1) % btns.length]?.focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { btns[(i - 1 + btns.length) % btns.length]?.focus(); e.preventDefault(); }
    if (e.key === 'Escape') closeMenu();
  });
  return menu;
}
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ---------- bildirim ----------
export function toast(msg, type = 'info', ms = 2600) {
  let wrap = document.querySelector('.toasts');
  if (!wrap) { wrap = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(wrap); }
  const t = h('div', { class: `toast ${type}` }, msg);
  wrap.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- modal ----------
export function modal({ title, body, buttons = [], width = 460, onClose, dismissable = true }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { width: width + 'px' } });
  const close = (val) => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(val); };
  const header = h('div', { class: 'modal-head' }, h('h2', {}, title));
  if (dismissable) {
    const x = h('button', { class: 'icon-btn', title: 'Kapat (Esc)', 'aria-label': 'Kapat', html: icon('close') });
    x.onclick = () => close(null);
    header.append(x);
  }
  const content = h('div', { class: 'modal-body' });
  if (typeof body === 'string') content.innerHTML = body; else if (body) content.append(body);
  const foot = h('div', { class: 'modal-foot' });
  for (const b of buttons) {
    const btn = h('button', { class: 'btn ' + (b.primary ? 'primary' : b.danger ? 'danger' : '') }, b.label);
    btn.onclick = async () => { const r = b.action ? await b.action(btn) : b.value; if (r !== false) close(b.value ?? r); };
    foot.append(btn);
  }
  box.append(header, content);
  if (buttons.length) box.append(foot);
  backdrop.append(box);
  document.body.append(backdrop);
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(null); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const p = buttons.find((b) => b.primary);
      if (p) { e.preventDefault(); foot.querySelector('.primary')?.click(); }
    }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  if (dismissable) backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(null); });
  setTimeout(() => (box.querySelector('input,select,textarea') || foot.querySelector('.primary') || box).focus?.(), 30);
  return { close, box, content };
}

export function confirmDialog(title, message, okLabel = 'Tamam', danger = false, extra = null) {
  return new Promise((resolve) => {
    const buttons = [{ label: 'Vazgeç', value: 'cancel' }];
    if (extra) buttons.push({ label: extra, value: 'extra' });
    buttons.push({ label: okLabel, value: 'ok', primary: !danger, danger });
    modal({ title, body: h('p', { class: 'muted-p' }, message), buttons, onClose: (v) => resolve(v || 'cancel') });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const inp = h('input', { class: 'inp', value, 'aria-label': label });
    const body = h('label', { class: 'field' }, h('span', {}, label), inp);
    let result = null;
    modal({ title, body, buttons: [{ label: 'Vazgeç' }, { label: 'Tamam', primary: true, action: () => { result = inp.value; } }], onClose: () => resolve(result) });
    setTimeout(() => inp.select(), 40);
  });
}

// Sürüklenebilir sayı alanı (Premiere tarzı "scrubby" değer)
export function scrubNumber({ value, min = -Infinity, max = Infinity, step = 1, decimals = 0, suffix = '', onInput, onCommit, onStart }) {
  const inp = h('input', { class: 'num', type: 'text', inputmode: 'decimal', spellcheck: false });
  let v = value;
  const fmt = (x) => (Math.round(x * 10 ** decimals) / 10 ** decimals).toFixed(decimals) + suffix;
  inp.value = fmt(v);
  inp.set = (x) => { v = x; if (document.activeElement !== inp) inp.value = fmt(x); };
  let drag = null;
  inp.addEventListener('pointerdown', (e) => {
    if (document.activeElement === inp) return;
    e.preventDefault();
    drag = { x: e.clientX, v, moved: false };
    inp.setPointerCapture(e.pointerId);
  });
  inp.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    if (!drag.moved) { drag.moved = true; onStart?.(); document.body.classList.add('scrubbing'); }
    const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    v = Math.min(max, Math.max(min, drag.v + dx * step * mul));
    inp.value = fmt(v);
    onInput?.(v);
  });
  inp.addEventListener('pointerup', () => {
    if (!drag) return;
    document.body.classList.remove('scrubbing');
    if (!drag.moved) { inp.focus(); inp.select(); } else onCommit?.(v);
    drag = null;
  });
  const commitText = () => {
    const x = parseFloat(inp.value.replace(',', '.'));
    if (!isNaN(x)) { v = Math.min(max, Math.max(min, x)); onStart?.(); onInput?.(v); onCommit?.(v); }
    inp.value = fmt(v);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commitText(); inp.blur(); }
    if (e.key === 'Escape') { inp.value = fmt(v); inp.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1) * (decimals ? 10 : 1);
      v = Math.min(max, Math.max(min, v + d)); onStart?.(); onInput?.(v); onCommit?.(v); inp.value = fmt(v);
    }
    e.stopPropagation();
  });
  inp.addEventListener('blur', () => { if (inp.value !== fmt(v)) commitText(); });
  return inp;
}
