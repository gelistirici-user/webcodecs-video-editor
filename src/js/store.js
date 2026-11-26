// Proje durumu, geri al/yinele ve kurgu işlemleri
import { uid, EPS, clamp } from './utils.js';

export const DEFAULT_TRANSFORM = () => ({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'contain', cropL: 0, cropR: 0, cropT: 0, cropB: 0, blend: 'source-over', flipH: false, flipV: false });
export const DEFAULT_COLOR = () => ({ brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0, vignette: 0, blur: 0, preset: 'none' });
export const DEFAULT_TEXT = () => ({ content: 'Yeni Başlık', font: 'Segoe UI', size: 96, color: '#ffffff', bold: true, italic: false, align: 'center', stroke: 0, strokeColor: '#000000', shadow: 0.5, bg: false, bgColor: '#000000', bgOpacity: 0.55, lineHeight: 1.2, letterSpacing: 0 });

export function newProject() {
  return {
    version: 1,
    name: 'Adsız Proje',
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    media: [],
    tracks: [
      { id: uid('t'), kind: 'video', name: 'V1', muted: false, locked: false, hidden: false },
      { id: uid('t'), kind: 'video', name: 'V2', muted: false, locked: false, hidden: false },
      { id: uid('t'), kind: 'video', name: 'V3', muted: false, locked: false, hidden: false },
      { id: uid('t'), kind: 'audio', name: 'A1', muted: false, locked: false, solo: false, volume: 1 },
      { id: uid('t'), kind: 'audio', name: 'A2', muted: false, locked: false, solo: false, volume: 1 },
    ],
    clips: [],
    markers: [],
    inPoint: null,
    outPoint: null,
    master: 1,
    activeSeq: { id: uid('s'), name: 'Sekans 1' },
    sequences: [], // etkin olmayan sekanslar: { id, name, tracks, clips, markers, inPoint, outPoint }
  };
}

const freshTracks = () => [
  { id: uid('t'), kind: 'video', name: 'V1', muted: false, locked: false, hidden: false },
  { id: uid('t'), kind: 'video', name: 'V2', muted: false, locked: false, hidden: false },
  { id: uid('t'), kind: 'audio', name: 'A1', muted: false, locked: false, solo: false, volume: 1 },
  { id: uid('t'), kind: 'audio', name: 'A2', muted: false, locked: false, solo: false, volume: 1 },
];

export function makeClip(type, props = {}) {
  const base = {
    id: uid('c'), type, trackId: null, mediaId: null, linkId: null,
    start: 0, in: 0, duration: 5, speed: 1, name: '',
    transform: DEFAULT_TRANSFORM(), color: DEFAULT_COLOR(),
    fadeIn: 0, fadeOut: 0, animation: 'none', transitionIn: null,
    volume: 1, audioFadeIn: 0, audioFadeOut: 0, muted: false,
  };
  if (type === 'text') base.text = DEFAULT_TEXT();
  if (type === 'color') { base.fill = '#1e88e5'; base.fill2 = '#8e24aa'; base.gradient = false; }
  return Object.assign(base, props);
}

class Store {
  constructor() {
    this.project = newProject();
    this.selection = new Set();
    this.playhead = 0;
    this.filePath = null;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Map();
    this.clipboard = null;
    this.mediaCache = new Map(); // mediaId -> { thumbs, peaks, ... } (kaydedilmez)
    this._pending = null;
  }

  on(ev, fn) { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev).add(fn); return () => this.listeners.get(ev).delete(fn); }
  emit(ev, data) { this.listeners.get(ev)?.forEach((fn) => fn(data)); }

  // ---------- geçmiş ----------
  snapshot() { return JSON.stringify(this.project); }
  begin() { if (!this._pending) this._pending = this.snapshot(); }
  commit(label = 'Düzenleme') {
    if (!this._pending) return;
    const now = this.snapshot();
    if (now !== this._pending) {
      this.undoStack.push({ label, data: this._pending, sel: [...this.selection] });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.dirty = true;
    }
    this._pending = null;
    this.emit('change', { label });
  }
  cancel() {
    if (!this._pending) return;
    this.project = JSON.parse(this._pending);
    this._pending = null;
    this.emit('change', {});
  }
  transact(label, fn) { this.begin(); const r = fn(this.project); this.commit(label); return r; }
  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, data: this.snapshot(), sel: [...this.selection] });
    this.project = JSON.parse(e.data);
    this.selection = new Set(e.sel.filter((id) => this.clip(id)));
    this.dirty = true;
    this.emit('change', { undo: true });
    this.emit('selection');
    return e.label;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, data: this.snapshot(), sel: [...this.selection] });
    this.project = JSON.parse(e.data);
    this.selection = new Set(e.sel.filter((id) => this.clip(id)));
    this.dirty = true;
    this.emit('change', { redo: true });
    this.emit('selection');
    return e.label;
  }
  load(project, filePath = null) {
    this.project = project;
    this.ensureSeqs();
    this.filePath = filePath;
    this.undoStack = [];
    this.redoStack = [];
    this.selection.clear();
    this.playhead = 0;
    this.dirty = false;
    this.emit('load');
    this.emit('change', { load: true });
    this.emit('selection');
  }

  // ---------- sekanslar ----------
  ensureSeqs() {
    const P = this.project;
    if (!P.activeSeq) P.activeSeq = { id: uid('s'), name: 'Sekans 1' };
    if (!P.sequences) P.sequences = [];
  }
  sequenceList() {
    this.ensureSeqs();
    const P = this.project;
    const all = [{ id: P.activeSeq.id, name: P.activeSeq.name, active: true }, ...P.sequences.map((q) => ({ id: q.id, name: q.name, active: false }))];
    // sekme sırası sabit kalsın (etkin sekans değişince yer değiştirmesin)
    const order = (P.seqOrder || []).filter((id) => all.some((q) => q.id === id));
    for (const q of all) if (!order.includes(q.id)) order.push(q.id);
    P.seqOrder = order;
    return order.map((id) => all.find((q) => q.id === id));
  }
  // iç içe veri: etkin sekans üst düzey alanlarda, diğerleri sequences içinde
  seqData(id) {
    const P = this.project;
    if (!id || id === P.activeSeq?.id) return P;
    const q = (P.sequences || []).find((x) => x.id === id);
    return q ? { ...P, tracks: q.tracks, clips: q.clips, markers: q.markers || [] } : null;
  }
  seqName(id) { return this.sequenceList().find((x) => x.id === id)?.name || 'Sekans'; }
  seqDuration(id) { const d = this.seqData(id); return d ? d.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) : 0; }
  // id sekansı, from sekansının içinde (doğrudan/dolaylı) kullanılıyor mu? (döngü engeli)
  seqContains(from, id, depth = 0) {
    if (from === id) return true;
    if (depth > 8) return true;
    const d = this.seqData(from);
    return !!d && d.clips.some((c) => c.type === 'seq' && this.seqContains(c.seqId, id, depth + 1));
  }
  // begin/commit içinde çağrılır
  switchSequence(id) {
    this.ensureSeqs();
    const P = this.project;
    if (id === P.activeSeq.id) return false;
    const i = P.sequences.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const target = P.sequences[i];
    P.sequences[i] = { id: P.activeSeq.id, name: P.activeSeq.name, tracks: P.tracks, clips: P.clips, markers: P.markers, inPoint: P.inPoint, outPoint: P.outPoint, playhead: this.playhead };
    P.activeSeq = { id: target.id, name: target.name };
    P.tracks = target.tracks; P.clips = target.clips; P.markers = target.markers || []; P.inPoint = target.inPoint ?? null; P.outPoint = target.outPoint ?? null;
    this.selection.clear();
    this.playhead = target.playhead || 0;
    return true;
  }
  newSequence(name) {
    this.ensureSeqs();
    const q = { id: uid('s'), name: name || `Sekans ${this.sequenceList().length + 1}`, tracks: freshTracks(), clips: [], markers: [], inPoint: null, outPoint: null };
    this.project.sequences.push(q);
    return q;
  }
  renameSequence(id, name) {
    const P = this.project;
    if (P.activeSeq.id === id) P.activeSeq.name = name; else { const q = P.sequences.find((x) => x.id === id); if (q) q.name = name; }
  }
  deleteSequence(id) {
    const P = this.project;
    if (P.activeSeq.id === id || this.sequenceList().length < 2) return false;
    P.sequences = P.sequences.filter((x) => x.id !== id);
    // bu sekansa başvuran iç içe klipleri kaldır
    const strip = (clips) => clips.filter((c) => !(c.type === 'seq' && c.seqId === id));
    P.clips = strip(P.clips);
    P.sequences.forEach((q) => { q.clips = strip(q.clips); });
    this.cleanupLinks();
    return true;
  }
  // Seçili klipleri yeni bir sekansa taşı, yerine iç içe sekans klibi koy (Premiere "Nest")
  nestSelection(name) {
    this.ensureSeqs();
    const P = this.project;
    const sel = this.selectedClips();
    if (!sel.length) return null;
    const t0 = Math.min(...sel.map((c) => c.start));
    const t1 = Math.max(...sel.map((c) => c.start + c.duration));
    const usedTracks = P.tracks.filter((t) => sel.some((c) => c.trackId === t.id));
    // yeni sekansın izleri: kullanılan izlerin kopyaları (aynı sırayla)
    const map = new Map();
    const tracks = P.tracks.filter((t) => usedTracks.includes(t)).map((t) => { const n = { ...t, id: uid('t') }; map.set(t.id, n.id); return n; });
    if (!tracks.some((t) => t.kind === 'video')) tracks.unshift({ id: uid('t'), kind: 'video', name: 'V1', muted: false, locked: false, hidden: false });
    if (!tracks.some((t) => t.kind === 'audio')) tracks.push({ id: uid('t'), kind: 'audio', name: 'A1', muted: false, locked: false, solo: false, volume: 1 });
    const inner = sel.map((c) => ({ ...JSON.parse(JSON.stringify(c)), trackId: map.get(c.trackId), start: c.start - t0 }));
    const q = { id: uid('s'), name: name || `İç içe ${this.sequenceList().length}`, tracks, clips: inner, markers: [], inPoint: null, outPoint: null };
    P.sequences.push(q);
    const ids = new Set(sel.map((c) => c.id));
    P.clips = P.clips.filter((c) => !ids.has(c.id));
    this.cleanupLinks();
    const vt = sel.find((c) => this.track(c.trackId).kind === 'video') ? sel.filter((c) => this.track(c.trackId).kind === 'video').map((c) => this.track(c.trackId)).sort((a, b) => P.tracks.indexOf(a) - P.tracks.indexOf(b))[0] : null;
    const at = sel.find((c) => this.track(c.trackId).kind === 'audio') ? this.track(sel.find((c) => this.track(c.trackId).kind === 'audio').trackId) : null;
    const link = vt && at ? uid('l') : null;
    const made = [];
    if (vt) { const c = makeClip('seq', { seqId: q.id, trackId: vt.id, start: t0, duration: t1 - t0, linkId: link, name: q.name }); P.clips.push(c); made.push(c); }
    if (at) { const c = makeClip('seq', { seqId: q.id, trackId: at.id, start: t0, duration: t1 - t0, linkId: link, name: q.name }); P.clips.push(c); made.push(c); }
    this.selection = new Set(made.map((c) => c.id));
    return q;
  }
  // Etkin sekansa başka bir sekansı iç içe klip olarak yerleştir
  placeSequence(id, start) {
    const P = this.project;
    if (this.seqContains(id, P.activeSeq.id)) return null;
    const d = this.seqDuration(id);
    if (d <= 0) return null;
    const vt = this.videoTracks()[0], at = this.audioTracks()[0];
    const link = uid('l');
    const made = [];
    for (const t of [vt, at].filter(Boolean)) {
      this.clearRange(t.id, start, start + d);
      const c = makeClip('seq', { seqId: id, trackId: t.id, start, duration: d, linkId: link, name: this.seqName(id) });
      P.clips.push(c); made.push(c);
    }
    return made;
  }

  // ---------- erişim ----------
  get fps() { return this.project.settings.fps; }
  clip(id) { return this.project.clips.find((c) => c.id === id); }
  track(id) { return this.project.tracks.find((t) => t.id === id); }
  media(id) { return this.project.media.find((m) => m.id === id); }
  videoTracks() { return this.project.tracks.filter((t) => t.kind === 'video'); }
  audioTracks() { return this.project.tracks.filter((t) => t.kind === 'audio'); }
  clipsOn(trackId) { return this.project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start); }
  linked(clip) { return clip.linkId ? this.project.clips.filter((c) => c.linkId === clip.linkId) : [clip]; }
  duration() { return this.project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0); }
  selectedClips() { return [...this.selection].map((id) => this.clip(id)).filter(Boolean); }

  setPlayhead(t) {
    const fps = this.fps;
    t = Math.max(0, Math.round(t * fps) / fps);
    if (t === this.playhead) return;
    this.playhead = t;
    this.emit('playhead', t);
  }
  select(ids, mode = 'replace') {
    if (mode === 'replace') this.selection = new Set(ids);
    else if (mode === 'add') ids.forEach((i) => this.selection.add(i));
    else if (mode === 'toggle') ids.forEach((i) => (this.selection.has(i) ? this.selection.delete(i) : this.selection.add(i)));
    this.emit('selection');
  }

  // ---------- kurgu işlemleri (begin/commit dışarıda) ----------
  mediaMaxDur(clip) {
    if (clip.type === 'seq') return (this.seqDuration(clip.seqId) - clip.in) / clip.speed;
    if (clip.type !== 'media') return Infinity;
    const m = this.media(clip.mediaId);
    if (!m || m.kind === 'image') return Infinity;
    return (m.duration - clip.in) / clip.speed;
  }

  // Bir izde [start,end) aralığını boşaltır (üzerine yazma davranışı)
  clearRange(trackId, start, end, exclude = new Set()) {
    const P = this.project;
    for (const c of [...P.clips]) {
      if (c.trackId !== trackId || exclude.has(c.id)) continue;
      const cs = c.start, ce = c.start + c.duration;
      if (ce <= start + EPS || cs >= end - EPS) continue;
      if (cs >= start - EPS && ce <= end + EPS) {
        P.clips.splice(P.clips.indexOf(c), 1);
        this.selection.delete(c.id);
      } else if (cs < start && ce > end) {
        const right = JSON.parse(JSON.stringify(c));
        right.id = uid('c');
        right.linkId = null;
        right.transitionIn = null;
        const cut = end - cs;
        right.start = end;
        right.in = c.in + cut * c.speed;
        right.duration = ce - end;
        c.duration = start - cs;
        P.clips.push(right);
      } else if (cs < start) {
        c.duration = start - cs;
      } else {
        const cut = end - cs;
        c.start = end;
        c.in += cut * c.speed;
        c.duration -= cut;
        c.transitionIn = null;
      }
    }
  }

  splitClip(clip, t) {
    if (t <= clip.start + EPS || t >= clip.start + clip.duration - EPS) return null;
    const right = JSON.parse(JSON.stringify(clip));
    right.id = uid('c');
    right.linkId = null; // bağlantıyı çağıran taraf (splitAt) yeniden kurar
    const cut = t - clip.start;
    right.start = t;
    right.in = clip.in + cut * clip.speed;
    right.duration = clip.duration - cut;
    right.transitionIn = null;
    right.fadeIn = 0;
    right.audioFadeIn = 0;
    clip.duration = cut;
    clip.fadeOut = 0;
    clip.audioFadeOut = 0;
    this.project.clips.push(right);
    return right;
  }

  // Bağlantılı grupları birlikte böler; yeni sağ parçalar yeni bir linkId paylaşır
  splitAt(clips, t) {
    const done = new Set();
    const created = [];
    const relink = new Map();
    for (const c of clips) {
      if (done.has(c.id)) continue;
      for (const g of this.linked(c)) {
        if (done.has(g.id)) continue;
        done.add(g.id);
        if (this.track(g.trackId)?.locked) continue;
        const r = this.splitClip(g, t);
        if (r) {
          if (g.linkId) {
            if (!relink.has(g.linkId)) relink.set(g.linkId, uid('l'));
            r.linkId = relink.get(g.linkId);
          }
          created.push(r);
        }
      }
    }
    return created;
  }

  removeClips(ids, ripple = false) {
    const P = this.project;
    const removed = P.clips.filter((c) => ids.has(c.id) && !this.track(c.trackId)?.locked);
    if (!removed.length) return;
    P.clips = P.clips.filter((c) => !removed.includes(c));
    removed.forEach((c) => this.selection.delete(c.id));
    if (ripple) {
      // her izdeki boşluğu kapat (yalnızca etkilenen izler)
      const byTrack = new Map();
      removed.forEach((c) => { if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []); byTrack.get(c.trackId).push(c); });
      for (const [tid, list] of byTrack) {
        list.sort((a, b) => b.start - a.start);
        for (const r of list) {
          for (const c of P.clips) if (c.trackId === tid && c.start >= r.start + r.duration - EPS) c.start -= r.duration;
        }
      }
    }
    this.cleanupLinks();
  }

  closeGap(trackId, t) {
    const clips = this.clipsOn(trackId);
    let prevEnd = 0;
    for (const c of clips) {
      if (c.start > t) {
        const gap = c.start - prevEnd;
        if (gap <= EPS || prevEnd > t) return false;
        for (const k of clips) if (k.start >= c.start - EPS) k.start -= gap;
        return true;
      }
      prevEnd = Math.max(prevEnd, c.start + c.duration);
    }
    return false;
  }

  cleanupLinks() {
    const counts = new Map();
    this.project.clips.forEach((c) => c.linkId && counts.set(c.linkId, (counts.get(c.linkId) || 0) + 1));
    this.project.clips.forEach((c) => { if (c.linkId && counts.get(c.linkId) < 2) c.linkId = null; });
  }

  // Medya klibini zaman çizelgesine yerleştirir (video+ses bağlantılı)
  placeMedia(media, trackId, start, opts = {}) {
    const P = this.project;
    const track = this.track(trackId);
    const srcIn = opts.in ?? media.srcIn ?? 0;
    const srcOut = opts.out ?? media.srcOut ?? (media.kind === 'image' ? null : media.duration);
    const fps = this.fps;
    // kare hizalı başlangıç ve süre (kaynağın sonunu aşmamak için aşağı yuvarla)
    start = Math.round(start * fps) / fps;
    const dur = media.kind === 'image' ? (opts.duration || 5) : Math.max(1 / fps, Math.floor((srcOut - srcIn) * fps + 1e-6) / fps);
    const placed = [];
    const linkId = media.kind === 'video' && media.hasAudio ? uid('l') : null;
    let vTrack = null, aTrack = null;
    if (media.kind === 'audio') aTrack = track?.kind === 'audio' ? track : this.audioTracks()[0];
    else {
      vTrack = track?.kind === 'video' ? track : this.videoTracks()[0];
      if (linkId) {
        // ses izi: video izinin sırasına karşılık gelen ses izi
        const vi = this.videoTracks().indexOf(vTrack);
        const at = this.audioTracks();
        aTrack = track?.kind === 'audio' ? track : at[Math.min(vi, at.length - 1)] || at[0];
        if (!aTrack) { aTrack = this.addTrack('audio'); }
      }
    }
    if (vTrack && vTrack.locked) return [];
    if (aTrack && aTrack.locked) aTrack = null;
    const mode = opts.mode || 'overwrite';
    if (mode === 'insert') {
      const tracks = [vTrack, aTrack].filter(Boolean);
      // ekleme: oynatma kafasından sonraki klipleri ilgili izlerde kaydır
      // (liste kopyası üzerinde dön: bölmeden doğan sağ parçalar ikinci kez kaydırılmasın)
      const relink = new Map();
      for (const t of tracks) {
        for (const c of [...P.clips]) {
          if (c.trackId !== t.id) continue;
          if (c.start < start - EPS && c.start + c.duration > start + EPS) {
            const r = this.splitClip(c, start);
            if (r) {
              r.start += dur;
              if (c.linkId) { if (!relink.has(c.linkId)) relink.set(c.linkId, uid('l')); r.linkId = relink.get(c.linkId); }
            }
          } else if (c.start >= start - EPS) c.start += dur;
        }
      }
    }
    if (vTrack) {
      this.clearRange(vTrack.id, start, start + dur);
      const c = makeClip('media', { mediaId: media.id, trackId: vTrack.id, start, in: srcIn, duration: dur, linkId, name: media.name });
      P.clips.push(c); placed.push(c);
    }
    if (aTrack && (media.kind === 'audio' || linkId)) {
      this.clearRange(aTrack.id, start, start + dur);
      const c = makeClip('media', { mediaId: media.id, trackId: aTrack.id, start, in: srcIn, duration: dur, linkId: media.kind === 'audio' ? null : linkId, name: media.name });
      P.clips.push(c); placed.push(c);
    }
    if (!placed.some((c) => c.linkId)) placed.forEach((c) => (c.linkId = null));
    return placed;
  }

  addTrack(kind) {
    const list = kind === 'video' ? this.videoTracks() : this.audioTracks();
    const t = kind === 'video'
      ? { id: uid('t'), kind, name: `V${list.length + 1}`, muted: false, locked: false, hidden: false }
      : { id: uid('t'), kind, name: `A${list.length + 1}`, muted: false, locked: false, solo: false, volume: 1 };
    const P = this.project;
    const lastIdx = P.tracks.lastIndexOf(list[list.length - 1]);
    P.tracks.splice(lastIdx + 1, 0, t);
    return t;
  }

  removeTrack(id) {
    const t = this.track(id);
    const P = this.project;
    const same = P.tracks.filter((x) => x.kind === t.kind);
    if (same.length <= 1) return false;
    P.clips = P.clips.filter((c) => c.trackId !== id);
    P.tracks = P.tracks.filter((x) => x.id !== id);
    let i = 1;
    P.tracks.filter((x) => x.kind === t.kind).forEach((x) => { if (/^[VA]\d+$/.test(x.name)) x.name = (t.kind === 'video' ? 'V' : 'A') + i; i++; });
    this.cleanupLinks();
    return true;
  }

  // Klibin bir kenarını kırpar; komşu kliplere taşmaz, kaynak sınırlarına uyar
  trimClip(clip, edge, t, original) {
    const fps = this.fps;
    const min = 1 / fps;
    const neighbors = this.clipsOn(clip.trackId).filter((c) => c.id !== clip.id);
    const m = clip.type === 'media' ? this.media(clip.mediaId) : clip.type === 'seq' ? { duration: this.seqDuration(clip.seqId), kind: 'seq' } : null;
    const hasSrcLimit = m && m.kind !== 'image';
    if (edge === 'left') {
      const end = original.start + original.duration;
      const prevEnd = neighbors.filter((c) => c.start + c.duration <= original.start + EPS).reduce((a, c) => Math.max(a, c.start + c.duration), 0);
      let lo = prevEnd;
      if (hasSrcLimit) lo = Math.max(lo, original.start - original.in / original.speed);
      t = clamp(t, lo, end - min);
      clip.start = t;
      clip.duration = end - t;
      clip.in = original.in + (t - original.start) * original.speed;
    } else {
      const nextStart = neighbors.filter((c) => c.start >= original.start + original.duration - EPS).reduce((a, c) => Math.min(a, c.start), Infinity);
      let hi = nextStart;
      if (hasSrcLimit) hi = Math.min(hi, original.start + (m.duration - original.in) / original.speed);
      t = clamp(t, original.start + min, hi);
      clip.duration = t - original.start;
    }
  }
}

export const store = new Store();
