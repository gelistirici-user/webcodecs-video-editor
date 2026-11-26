// Denetçi paneli: seçili klibin özellikleri (Hareket, Opaklık, Renk, Metin, Ses, Hız, Geçiş)
import { store, DEFAULT_TRANSFORM, DEFAULT_COLOR } from './store.js';
import { h, formatTC, parseTC, clamp } from './utils.js';
import { icon, scrubNumber, toast } from './ui.js';
import { TRANSITIONS, COLOR_PRESETS, ANIMATIONS, BLENDS } from './compositor.js';

const FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

export class Inspector {
  constructor(root) {
    this.root = root;
    this.refreshers = [];
    this.collapsed = JSON.parse(localStorage.getItem('kurgu.collapsed') || '{}');
    this.page = 'edit';
    store.on('selection', () => this.build());
    store.on('load', () => this.build());
    store.on('change', (d) => { if (d?.live || this._self) return; this.refresh(); });
    store.on('focus-inspector', () => this.root.querySelector('input,textarea,select')?.focus());
    this.build();
  }

  setPage(p) { this.page = p; this.build(); }

  // değişiklik yardımcıları
  live(fn) { this._self = true; fn(); store.emit('change', { live: true }); this._self = false; }
  start() { store.begin(); }
  end(label) { this._self = true; store.commit(label); this._self = false; }
  once(label, fn) { this._self = true; store.transact(label, fn); this._self = false; this.refresh(); }

  refresh() {
    const sel = store.selectedClips();
    const sig = sel.map((c) => c.id).join(',');
    if (sig !== this._sig || sel.some((c) => !store.clip(c.id))) return this.build();
    this.refreshers.forEach((f) => f());
  }

  build() {
    this.refreshers = [];
    const root = this.root;
    root.innerHTML = '';
    const sel = store.selectedClips();
    this._sig = sel.map((c) => c.id).join(',');
    if (!sel.length) return this.buildProject();
    // bağlantılı video+ses çifti tek klip gibi gösterilir
    const tracks = sel.map((c) => store.track(c.trackId));
    const linkIds = new Set(sel.map((c) => c.linkId).filter(Boolean));
    const isPair = sel.length === 2 && linkIds.size === 1 && sel.every((c) => c.linkId);
    if (sel.length > 1 && !isPair) return this.buildMulti(sel);
    const vClip = sel.find((c, i) => tracks[i].kind === 'video');
    const aClip = sel.find((c, i) => tracks[i].kind === 'audio');
    const main = vClip || aClip;
    const m = main.type === 'media' ? store.media(main.mediaId) : null;

    const title = main.type === 'text' ? 'Metin' : main.type === 'color' ? (main.gradient ? 'Gradyan' : 'Renk Katmanı') : (m?.name || 'Klip');
    root.append(h('div', { class: 'insp-title' },
      h('span', { class: 'insp-icon', html: icon(main.type === 'text' ? 'text' : main.type === 'color' ? 'palette' : m?.kind === 'audio' ? 'music' : m?.kind === 'image' ? 'image' : 'film', 16) }),
      h('div', { class: 'insp-name', title }, title),
      h('span', { class: 'insp-sub' }, tracks.map((t) => t.name).join(' + '))));

    this.timingSection(main, sel);
    if (this.page === 'color' && vClip) { this.colorSection(vClip); }
    if (vClip) {
      if (vClip.type === 'text') this.textSection(vClip);
      if (vClip.type === 'color') this.fillSection(vClip);
      this.motionSection(vClip);
      this.opacitySection(vClip);
      if (this.page !== 'color') this.colorSection(vClip);
      this.animSection(vClip);
      this.transitionSection(vClip);
    }
    if (aClip) this.audioSection(aClip);
  }

  section(id, title, buildFn, { onReset, right } = {}) {
    const collapsed = !!this.collapsed[id];
    const body = h('div', { class: 'sec-body' });
    const head = h('button', { class: 'sec-head', 'aria-expanded': String(!collapsed) },
      h('span', { class: 'sec-chev', html: icon('chevron', 16) }), h('span', { class: 'sec-title' }, title));
    const sec = h('section', { class: 'sec' + (collapsed ? ' collapsed' : '') }, h('div', { class: 'sec-headrow' }, head, right || null));
    if (onReset) {
      const rb = h('button', { class: 'icon-btn sm', title: 'Varsayılana sıfırla', 'aria-label': `${title} sıfırla`, html: icon('reset', 14) });
      rb.onclick = onReset;
      sec.firstChild.append(rb);
    }
    head.onclick = () => {
      const c = sec.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!c));
      this.collapsed[id] = c;
      localStorage.setItem('kurgu.collapsed', JSON.stringify(this.collapsed));
    };
    buildFn(body);
    sec.append(body);
    this.root.append(sec);
    return sec;
  }

  // sayısal satır: etiket + kaydırıcı + sürüklenebilir sayı
  numRow(parent, label, { get, set, min, max, step = 1, decimals = 0, suffix = '', def, slider = true, label2, display = (v) => v, parse = (v) => v, history }) {
    const row = h('div', { class: 'prow' });
    const lab = h('label', { class: 'plabel', title: def != null ? 'Sıfırlamak için çift tıklayın' : '' }, label);
    const dmin = display(min), dmax = display(max);
    const num = scrubNumber({
      value: display(get()), min: Math.min(dmin, dmax), max: Math.max(dmin, dmax), step, decimals, suffix,
      onStart: () => this.start(),
      onInput: (v) => this.live(() => { set(parse(v)); if (range) range.value = v; }),
      onCommit: () => this.end(history || label),
    });
    let range = null;
    if (slider) {
      range = h('input', { type: 'range', class: 'slider', min: Math.min(dmin, dmax), max: Math.max(dmin, dmax), step: step * (decimals ? 1 : 1), value: display(get()), 'aria-label': label });
      range.addEventListener('pointerdown', () => this.start());
      range.addEventListener('input', () => this.live(() => { set(parse(parseFloat(range.value))); num.set(parseFloat(range.value)); }));
      range.addEventListener('change', () => this.end(history || label));
      range.addEventListener('keydown', (e) => e.stopPropagation());
    }
    if (def != null) lab.ondblclick = () => this.once(label + ' sıfırla', () => set(def));
    row.append(lab, range || h('span'), num);
    if (label2) row.append(h('span', { class: 'punit' }, label2));
    parent.append(row);
    this.refreshers.push(() => { const v = display(get()); num.set(v); if (range && document.activeElement !== range) range.value = v; });
    return row;
  }

  selectRow(parent, label, options, get, set, history) {
    const sel = h('select', { class: 'inp sm', 'aria-label': label });
    for (const [k, v] of Object.entries(options)) sel.append(h('option', { value: k }, v));
    sel.value = get();
    sel.onchange = () => this.once(history || label, () => set(sel.value));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    parent.append(h('div', { class: 'prow two' }, h('label', { class: 'plabel' }, label), sel));
    this.refreshers.push(() => { sel.value = get(); });
    return sel;
  }

  toggleRow(parent, label, get, set) {
    const cb = h('input', { type: 'checkbox', checked: !!get() });
    cb.onchange = () => this.once(label, () => set(cb.checked));
    parent.append(h('label', { class: 'prow two check' }, h('span', { class: 'plabel' }, label), h('span', { class: 'switch' }, cb, h('span', { class: 'switch-ui' }))));
    this.refreshers.push(() => { cb.checked = !!get(); });
  }

  colorRow(parent, label, get, set) {
    const inp = h('input', { type: 'color', class: 'color-inp', value: get(), 'aria-label': label });
    inp.addEventListener('focus', () => this.start());
    inp.addEventListener('input', () => this.live(() => set(inp.value)));
    inp.addEventListener('change', () => this.end(label));
    parent.append(h('div', { class: 'prow two' }, h('label', { class: 'plabel' }, label), inp));
    this.refreshers.push(() => { inp.value = get(); });
  }

  // ---------- bölümler ----------
  timingSection(main, sel) {
    const fps = store.fps;
    this.section('timing', 'Zamanlama', (b) => {
      const tcField = (label, get, set) => {
        const inp = h('input', { class: 'inp tc', value: formatTC(get(), fps), 'aria-label': label, spellcheck: false });
        const commit = () => {
          const v = parseTC(inp.value, fps);
          if (v == null) { inp.value = formatTC(get(), fps); return toast('Geçersiz zaman kodu', 'warn'); }
          this.once(label, () => set(v));
          inp.value = formatTC(get(), fps);
        };
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { commit(); inp.blur(); } if (e.key === 'Escape') { inp.value = formatTC(get(), fps); inp.blur(); } });
        inp.addEventListener('change', commit);
        this.refreshers.push(() => { if (document.activeElement !== inp) inp.value = formatTC(get(), fps); });
        return h('label', { class: 'tc-field' }, h('span', {}, label), inp);
      };
      const group = sel;
      b.append(h('div', { class: 'tc-grid' },
        tcField('Başlangıç', () => main.start, (v) => { const d = v - main.start; group.forEach((c) => { c.start = Math.max(0, c.start + d); }); }),
        tcField('Süre', () => main.duration, (v) => {
          v = Math.max(1 / fps, v);
          group.forEach((c) => { const max = store.mediaMaxDur(c); c.duration = Math.min(v, max); });
        }),
      ));
      this.numRow(b, 'Hız', {
        get: () => main.speed, set: (v) => group.forEach((c) => {
          const srcLen = c.duration * c.speed;
          c.speed = v;
          c.duration = Math.min(srcLen / v, store.mediaMaxDur(c));
        }),
        min: 0.1, max: 8, step: 0.01, decimals: 2, suffix: '×', def: 1, history: 'Hız',
      });
    });
  }

  motionSection(c) {
    const T = c.transform;
    const P = store.project;
    this.section('motion', 'Hareket', (b) => {
      this.numRow(b, 'Konum X', { get: () => T.x, set: (v) => (T.x = v), min: -P.settings.width, max: P.settings.width, step: 1, def: 0 });
      this.numRow(b, 'Konum Y', { get: () => T.y, set: (v) => (T.y = v), min: -P.settings.height, max: P.settings.height, step: 1, def: 0 });
      this.numRow(b, 'Ölçek', { get: () => T.scale, set: (v) => (T.scale = v), min: 0.05, max: 5, step: 0.5, decimals: 0, suffix: '%', def: 1, display: (v) => v * 100, parse: (v) => v / 100 });
      this.numRow(b, 'Döndürme', { get: () => T.rotation, set: (v) => (T.rotation = v), min: -360, max: 360, step: 0.5, decimals: 1, suffix: '°', def: 0 });
      if (c.type === 'media') {
        this.selectRow(b, 'Sığdırma', { contain: 'Sığdır (kenar boşluklu)', cover: 'Doldur (kırparak)', fill: 'Esnet' }, () => T.fit, (v) => (T.fit = v), 'Sığdırma');
        const flips = h('div', { class: 'prow two' }, h('span', { class: 'plabel' }, 'Çevir'),
          h('div', { class: 'seg' },
            this.segBtn('Yatay', () => T.flipH, () => this.once('Yatay çevir', () => (T.flipH = !T.flipH))),
            this.segBtn('Dikey', () => T.flipV, () => this.once('Dikey çevir', () => (T.flipV = !T.flipV)))));
        b.append(flips);
        b.append(h('div', { class: 'sub-head' }, 'Kırpma'));
        for (const [k, l] of [['cropL', 'Sol'], ['cropR', 'Sağ'], ['cropT', 'Üst'], ['cropB', 'Alt']]) {
          this.numRow(b, l, { get: () => T[k], set: (v) => (T[k] = clamp(v, 0, 0.95)), min: 0, max: 0.9, step: 0.5, suffix: '%', def: 0, display: (v) => v * 100, parse: (v) => v / 100, history: 'Kırpma' });
        }
      }
    }, { onReset: () => this.once('Hareketi sıfırla', () => { const o = T.opacity, bl = T.blend; Object.assign(T, DEFAULT_TRANSFORM(), { opacity: o, blend: bl }); }) });
  }

  segBtn(label, get, fn) {
    const b = h('button', { class: 'seg-btn' + (get() ? ' on' : ''), 'aria-pressed': String(!!get()) }, label);
    b.onclick = () => { fn(); b.classList.toggle('on', !!get()); b.setAttribute('aria-pressed', String(!!get())); };
    this.refreshers.push(() => b.classList.toggle('on', !!get()));
    return b;
  }

  opacitySection(c) {
    const T = c.transform;
    this.section('opacity', 'Opaklık ve Karışım', (b) => {
      this.numRow(b, 'Opaklık', { get: () => T.opacity, set: (v) => (T.opacity = v), min: 0, max: 1, step: 0.5, suffix: '%', def: 1, display: (v) => v * 100, parse: (v) => clamp(v / 100, 0, 1) });
      this.selectRow(b, 'Karışım', BLENDS, () => T.blend, (v) => (T.blend = v), 'Karışım modu');
      this.numRow(b, 'Giriş (fade)', { get: () => c.fadeIn, set: (v) => (c.fadeIn = clamp(v, 0, c.duration)), min: 0, max: Math.min(10, c.duration), step: 0.01, decimals: 2, suffix: ' sn', def: 0 });
      this.numRow(b, 'Çıkış (fade)', { get: () => c.fadeOut, set: (v) => (c.fadeOut = clamp(v, 0, c.duration)), min: 0, max: Math.min(10, c.duration), step: 0.01, decimals: 2, suffix: ' sn', def: 0 });
    });
  }

  colorSection(c) {
    const C = c.color;
    this.section('color', 'Renk Düzeltme', (b) => {
      const grid = h('div', { class: 'preset-grid', role: 'listbox', 'aria-label': 'Renk ön ayarları' });
      for (const [k, p] of Object.entries(COLOR_PRESETS)) {
        const btn = h('button', { class: 'preset' + (C.preset === k ? ' on' : ''), role: 'option', 'aria-selected': String(C.preset === k), title: p.label },
          h('span', { class: 'preset-sw', style: { filter: p.filter || 'none' } }), h('span', { class: 'preset-l' }, p.label));
        btn.onclick = () => { this.once('Renk ön ayarı', () => (C.preset = k)); grid.querySelectorAll('.preset').forEach((x) => { x.classList.toggle('on', x === btn); x.setAttribute('aria-selected', String(x === btn)); }); };
        grid.append(btn);
      }
      b.append(grid);
      const pct = { min: -1, max: 1, step: 0.5, suffix: '', def: 0, display: (v) => v * 100, parse: (v) => v / 100 };
      this.numRow(b, 'Parlaklık', { ...pct, get: () => C.brightness, set: (v) => (C.brightness = v) });
      this.numRow(b, 'Kontrast', { ...pct, get: () => C.contrast, set: (v) => (C.contrast = v) });
      this.numRow(b, 'Doygunluk', { ...pct, get: () => C.saturation, set: (v) => (C.saturation = v) });
      this.numRow(b, 'Sıcaklık', { ...pct, get: () => C.temperature, set: (v) => (C.temperature = v) });
      this.numRow(b, 'Ton (Tint)', { ...pct, get: () => C.tint, set: (v) => (C.tint = v) });
      this.numRow(b, 'Renk tonu', { get: () => C.hue, set: (v) => (C.hue = v), min: -180, max: 180, step: 1, suffix: '°', def: 0 });
      this.numRow(b, 'Vinyet', { get: () => C.vignette, set: (v) => (C.vignette = v), min: 0, max: 1, step: 0.5, def: 0, display: (v) => v * 100, parse: (v) => v / 100 });
      this.numRow(b, 'Bulanıklık', { get: () => C.blur, set: (v) => (C.blur = v), min: 0, max: 30, step: 0.1, decimals: 1, suffix: ' px', def: 0 });
    }, { onReset: () => { this.once('Rengi sıfırla', () => Object.assign(C, DEFAULT_COLOR())); this.build(); } });
  }

  textSection(c) {
    const T = c.text;
    this.section('text', 'Metin', (b) => {
      const ta = h('textarea', { class: 'inp ta', rows: 3, 'aria-label': 'Metin içeriği' }, T.content);
      ta.addEventListener('focus', () => this.start());
      ta.addEventListener('input', () => this.live(() => (T.content = ta.value)));
      ta.addEventListener('blur', () => this.end('Metin'));
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      this.refreshers.push(() => { if (document.activeElement !== ta) ta.value = T.content; });
      b.append(ta);
      const fontSel = this.selectRow(b, 'Yazı tipi', Object.fromEntries(FONTS.map((f) => [f, f])), () => T.font, (v) => (T.font = v), 'Yazı tipi');
      [...fontSel.options].forEach((o) => (o.style.fontFamily = o.value));
      this.numRow(b, 'Boyut', { get: () => T.size, set: (v) => (T.size = v), min: 8, max: 400, step: 1, suffix: ' px', def: 96 });
      this.colorRow(b, 'Renk', () => T.color, (v) => (T.color = v));
      const styleRow = h('div', { class: 'prow two' }, h('span', { class: 'plabel' }, 'Stil'), h('div', { class: 'seg' },
        this.segBtn('K', () => T.bold, () => this.once('Kalın', () => (T.bold = !T.bold))),
        this.segBtn('İ', () => T.italic, () => this.once('İtalik', () => (T.italic = !T.italic)))));
      styleRow.querySelectorAll('.seg-btn')[0].style.fontWeight = '800';
      styleRow.querySelectorAll('.seg-btn')[1].style.fontStyle = 'italic';
      styleRow.querySelectorAll('.seg-btn')[0].title = 'Kalın';
      styleRow.querySelectorAll('.seg-btn')[1].title = 'İtalik';
      b.append(styleRow);
      const alignRow = h('div', { class: 'prow two' }, h('span', { class: 'plabel' }, 'Hizalama'), h('div', { class: 'seg' },
        ...[['left', 'Sol'], ['center', 'Orta'], ['right', 'Sağ']].map(([k, l]) => this.segBtn(l, () => T.align === k, () => { this.once('Hizalama', () => (T.align = k)); this.refreshers.forEach((f) => f()); }))));
      b.append(alignRow);
      this.numRow(b, 'Satır aralığı', { get: () => T.lineHeight, set: (v) => (T.lineHeight = v), min: 0.8, max: 3, step: 0.01, decimals: 2, def: 1.2 });
      this.numRow(b, 'Harf aralığı', { get: () => T.letterSpacing, set: (v) => (T.letterSpacing = v), min: -10, max: 60, step: 0.5, decimals: 1, suffix: ' px', def: 0 });
      b.append(h('div', { class: 'sub-head' }, 'Kontur ve Gölge'));
      this.numRow(b, 'Kontur', { get: () => T.stroke, set: (v) => (T.stroke = v), min: 0, max: 20, step: 0.1, decimals: 1, suffix: ' px', def: 0 });
      this.colorRow(b, 'Kontur rengi', () => T.strokeColor, (v) => (T.strokeColor = v));
      this.numRow(b, 'Gölge', { get: () => T.shadow, set: (v) => (T.shadow = v), min: 0, max: 1, step: 0.5, def: 0.5, display: (v) => v * 100, parse: (v) => v / 100, suffix: '%' });
      b.append(h('div', { class: 'sub-head' }, 'Arka plan kutusu'));
      this.toggleRow(b, 'Kutu', () => T.bg, (v) => (T.bg = v));
      this.colorRow(b, 'Kutu rengi', () => T.bgColor, (v) => (T.bgColor = v));
      this.numRow(b, 'Kutu opaklığı', { get: () => T.bgOpacity, set: (v) => (T.bgOpacity = v), min: 0, max: 1, step: 0.5, def: 0.55, display: (v) => v * 100, parse: (v) => v / 100, suffix: '%' });
    });
  }

  fillSection(c) {
    this.section('fill', 'Dolgu', (b) => {
      this.colorRow(b, c.gradient ? 'Renk 1' : 'Renk', () => c.fill, (v) => (c.fill = v));
      this.toggleRow(b, 'Gradyan', () => c.gradient, (v) => { c.gradient = v; setTimeout(() => this.build()); });
      if (c.gradient) this.colorRow(b, 'Renk 2', () => c.fill2, (v) => (c.fill2 = v));
    });
  }

  animSection(c) {
    this.section('anim', 'Animasyon', (b) => {
      this.selectRow(b, 'Hazır hareket', ANIMATIONS, () => c.animation, (v) => (c.animation = v), 'Animasyon');
    });
  }

  transitionSection(c) {
    this.section('trans', 'Giriş Geçişi', (b) => {
      const opts = { '': 'Yok', ...TRANSITIONS };
      this.selectRow(b, 'Tür', opts, () => c.transitionIn?.type || '', (v) => { c.transitionIn = v ? { type: v, duration: c.transitionIn?.duration || 1 } : null; setTimeout(() => this.build()); }, 'Geçiş');
      if (c.transitionIn) {
        this.numRow(b, 'Süre', { get: () => c.transitionIn?.duration || 1, set: (v) => { if (c.transitionIn) c.transitionIn.duration = clamp(v, 0.1, Math.max(0.1, c.duration)); }, min: 0.1, max: 5, step: 0.01, decimals: 2, suffix: ' sn', def: 1, history: 'Geçiş süresi' });
      }
      b.append(h('p', { class: 'hint' }, 'İpucu: Efektler panelinden bir geçişi iki klip arasındaki kesme noktasına sürükleyin.'));
    });
  }

  audioSection(c) {
    const dB = (v) => (v <= 0.0001 ? '-∞' : (20 * Math.log10(v)).toFixed(1));
    this.section('audio', 'Ses', (b) => {
      const row = this.numRow(b, 'Seviye', { get: () => c.volume, set: (v) => (c.volume = v), min: 0, max: 2, step: 0.5, suffix: '%', def: 1, display: (v) => v * 100, parse: (v) => clamp(v / 100, 0, 2), label2: dB(c.volume) + ' dB', history: 'Ses seviyesi' });
      const unit = row.querySelector('.punit');
      this.refreshers.push(() => { unit.textContent = dB(c.volume) + ' dB'; });
      this.numRow(b, 'Giriş (fade)', { get: () => c.audioFadeIn, set: (v) => (c.audioFadeIn = clamp(v, 0, c.duration)), min: 0, max: Math.min(10, c.duration), step: 0.01, decimals: 2, suffix: ' sn', def: 0 });
      this.numRow(b, 'Çıkış (fade)', { get: () => c.audioFadeOut, set: (v) => (c.audioFadeOut = clamp(v, 0, c.duration)), min: 0, max: Math.min(10, c.duration), step: 0.01, decimals: 2, suffix: ' sn', def: 0 });
      this.toggleRow(b, 'Sessiz', () => c.muted, (v) => (c.muted = v));
      if (c.speed !== 1) b.append(h('p', { class: 'hint' }, 'Not: Hız değişimi ses perdesini de değiştirir.'));
    });
  }

  buildMulti(sel) {
    this.root.append(h('div', { class: 'insp-title' }, h('span', { class: 'insp-icon', html: icon('layers', 16) }), h('div', { class: 'insp-name' }, `${sel.length} klip seçili`)));
    const vids = sel.filter((c) => store.track(c.trackId).kind === 'video');
    const auds = sel.filter((c) => store.track(c.trackId).kind === 'audio');
    this.section('multi', 'Toplu düzenleme', (b) => {
      if (vids.length) {
        this.selectRow(b, 'Renk ön ayarı', Object.fromEntries(Object.entries(COLOR_PRESETS).map(([k, v]) => [k, v.label])), () => vids[0].color.preset, (v) => vids.forEach((c) => (c.color.preset = v)), 'Toplu renk');
        this.numRow(b, 'Opaklık', { get: () => vids[0].transform.opacity, set: (v) => vids.forEach((c) => (c.transform.opacity = v)), min: 0, max: 1, step: 0.5, suffix: '%', def: 1, display: (v) => v * 100, parse: (v) => clamp(v / 100, 0, 1) });
      }
      if (auds.length) this.numRow(b, 'Ses seviyesi', { get: () => auds[0].volume, set: (v) => auds.forEach((c) => (c.volume = v)), min: 0, max: 2, step: 0.5, suffix: '%', def: 1, display: (v) => v * 100, parse: (v) => clamp(v / 100, 0, 2) });
      b.append(h('p', { class: 'hint' }, 'Değerler seçili tüm kliplere uygulanır.'));
    });
  }

  buildProject() {
    const P = store.project;
    const S = P.settings;
    this.root.append(h('div', { class: 'insp-title' }, h('span', { class: 'insp-icon', html: icon('gear', 16) }), h('div', { class: 'insp-name' }, 'Proje')));
    this.section('proj', 'Sekans Ayarları', (b) => {
      const nameInp = h('input', { class: 'inp sm', value: P.name, 'aria-label': 'Proje adı' });
      nameInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameInp.blur(); });
      nameInp.addEventListener('change', () => this.once('Proje adı', () => { P.name = nameInp.value.trim() || 'Adsız Proje'; }));
      b.append(h('div', { class: 'prow two' }, h('label', { class: 'plabel' }, 'Ad'), nameInp));
      const presets = { '1920x1080': '1080p Yatay (1920×1080)', '3840x2160': '4K UHD (3840×2160)', '1280x720': '720p (1280×720)', '1080x1920': 'Dikey / Reels (1080×1920)', '1080x1080': 'Kare (1080×1080)', '1080x1350': 'Instagram 4:5 (1080×1350)', '2560x1080': 'Sinema 21:9 (2560×1080)' };
      const key = `${S.width}x${S.height}`;
      if (!presets[key]) presets[key] = `Özel (${S.width}×${S.height})`;
      this.selectRow(b, 'Çözünürlük', presets, () => `${S.width}x${S.height}`, (v) => { const [w, hh] = v.split('x').map(Number); S.width = w; S.height = hh; store.emit('resolution'); }, 'Çözünürlük');
      this.selectRow(b, 'Kare hızı', { 23.976: '23.976 fps', 24: '24 fps', 25: '25 fps', 29.97: '29.97 fps', 30: '30 fps', 50: '50 fps', 60: '60 fps' }, () => String(S.fps), (v) => { S.fps = parseFloat(v); }, 'Kare hızı');
      this.colorRow(b, 'Arka plan', () => S.background, (v) => (S.background = v));
      this.numRow(b, 'Ana ses', { get: () => P.master ?? 1, set: (v) => (P.master = v), min: 0, max: 2, step: 0.5, suffix: '%', def: 1, display: (v) => v * 100, parse: (v) => clamp(v / 100, 0, 2), history: 'Ana ses' });
    });
    const d = store.duration();
    this.section('stats', 'Özet', (b) => {
      b.append(h('dl', { class: 'stats' },
        h('dt', {}, 'Süre'), h('dd', {}, formatTC(d, S.fps)),
        h('dt', {}, 'Klip'), h('dd', {}, String(P.clips.length)),
        h('dt', {}, 'Medya'), h('dd', {}, String(P.media.length)),
        h('dt', {}, 'İşaretçi'), h('dd', {}, String(P.markers.length))));
      b.append(h('p', { class: 'hint' }, 'Bir klip seçerek özelliklerini burada düzenleyebilirsiniz.'));
    });
  }
}
