// Kare birleştirici: hem önizleme hem dışa aktarma aynı kodu kullanır (ne görüyorsan o çıkar)
import { clamp, smooth, EPS } from './utils.js';

export const TRANSITIONS = {
  dissolve: 'Çapraz Geçiş',
  dip: 'Siyaha Geçiş',
  dipWhite: 'Beyaza Geçiş',
  wipe: 'Silme (Sola)',
  wipeUp: 'Silme (Yukarı)',
  slide: 'Kaydırma',
  push: 'İtme',
  zoom: 'Yakınlaşma',
  circle: 'Daire Açılım',
};

export const COLOR_PRESETS = {
  none: { label: 'Yok', filter: '' },
  vivid: { label: 'Canlı', filter: 'saturate(1.45) contrast(1.06)' },
  cinematic: { label: 'Sinematik', filter: 'contrast(1.15) saturate(0.85)', tint: [0, 90, 140, 0.12] },
  tealOrange: { label: 'Teal & Orange', filter: 'contrast(1.12) saturate(1.15)', tint: [255, 120, 40, 0.1] },
  warm: { label: 'Sıcak', filter: 'saturate(1.1)', tint: [255, 140, 30, 0.14] },
  cool: { label: 'Soğuk', filter: 'saturate(0.95)', tint: [40, 120, 255, 0.14] },
  vintage: { label: 'Vintage', filter: 'sepia(0.35) contrast(1.08) saturate(0.8) brightness(1.04)' },
  faded: { label: 'Soluk Film', filter: 'contrast(0.82) brightness(1.08) saturate(0.75)' },
  bw: { label: 'Siyah Beyaz', filter: 'grayscale(1) contrast(1.1)' },
  noir: { label: 'Noir', filter: 'grayscale(1) contrast(1.45) brightness(0.92)' },
  sepia: { label: 'Sepya', filter: 'sepia(0.9)' },
  dream: { label: 'Rüya', filter: 'brightness(1.08) saturate(1.2) contrast(0.92) blur(0.6px)' },
  invert: { label: 'Negatif', filter: 'invert(1)' },
};

export const ANIMATIONS = {
  none: 'Yok',
  zoomIn: 'Yakınlaş (Ken Burns)',
  zoomOut: 'Uzaklaş',
  panLeft: 'Sola kaydır',
  panRight: 'Sağa kaydır',
  fadeUp: 'Yukarı süzül (giriş)',
  pop: 'Zıplayarak giriş',
  typewriter: 'Daktilo (metin)',
};

export const BLENDS = {
  'source-over': 'Normal', multiply: 'Çoğalt', screen: 'Ekran', overlay: 'Kaplama', 'soft-light': 'Yumuşak Işık',
  'hard-light': 'Sert Işık', lighten: 'Aydınlat', darken: 'Koyulaştır', difference: 'Fark', color: 'Renk', luminosity: 'Parlaklık',
};

function mediaTime(clip, t, media) {
  let s = clip.in + (t - clip.start) * clip.speed;
  if (media && media.kind !== 'image' && media.duration) s = clamp(s, 0, Math.max(0, media.duration - 0.001));
  return Math.max(0, s);
}

// t anında görünen katmanlar (alttan üste)
export function layersAt(project, t, mediaById) {
  const layers = [];
  const vtracks = project.tracks.filter((tr) => tr.kind === 'video');
  for (const track of vtracks) {
    if (track.hidden) continue;
    const clips = project.clips.filter((c) => c.trackId === track.id && !c.muted).sort((a, b) => a.start - b.start);
    let handled = false;
    // geçişler
    for (let i = 0; i < clips.length; i++) {
      const B = clips[i];
      const tr = B.transitionIn;
      if (!tr || !tr.duration) continue;
      const A = clips.find((c) => Math.abs(c.start + c.duration - B.start) < 1e-3);
      const d = Math.min(tr.duration, B.duration, A ? A.duration * 2 : Infinity);
      const w0 = A ? B.start - d / 2 : B.start;
      if (t < w0 || t >= w0 + d) continue;
      const p = smooth(clamp((t - w0) / d, 0, 1));
      const mk = (c, extra) => ({ clip: c, track, srcTime: mediaTime(c, t, mediaById.get(c.mediaId)), alpha: 1, ...extra });
      const a = A ? mk(A) : null;
      const b = mk(B);
      const out = [];
      switch (tr.type) {
        case 'dip':
        case 'dipWhite': {
          const color = tr.type === 'dip' ? '#000000' : '#ffffff';
          if (p < 0.5) { if (a) out.push(a); out.push({ fill: color, alpha: p * 2 }); }
          else { out.push(b); out.push({ fill: color, alpha: 2 - p * 2 }); }
          break;
        }
        case 'wipe': if (a) out.push(a); b.clipRect = [0, 0, p, 1]; out.push(b); break;
        case 'wipeUp': if (a) out.push(a); b.clipRect = [0, 1 - p, 1, p]; out.push(b); break;
        case 'slide': if (a) out.push(a); b.offset = [1 - p, 0]; out.push(b); break;
        case 'push': if (a) { a.offset = [-p, 0]; out.push(a); } b.offset = [1 - p, 0]; out.push(b); break;
        case 'zoom': if (a) out.push(a); b.alpha = p; b.zoom = 0.7 + 0.3 * p; out.push(b); break;
        case 'circle': if (a) out.push(a); b.circle = p; out.push(b); break;
        default: if (a) out.push(a); b.alpha = A ? p : p; out.push(b);
      }
      layers.push(...out);
      handled = true;
      break;
    }
    if (handled) continue;
    const c = clips.find((k) => !k.muted && t >= k.start - EPS && t < k.start + k.duration - EPS);
    if (c) layers.push({ clip: c, track, srcTime: mediaTime(c, t, mediaById.get(c.mediaId)), alpha: 1 });
  }
  return layers;
}

export function buildFilter(color) {
  const f = [];
  if (color.brightness) f.push(`brightness(${(1 + color.brightness).toFixed(3)})`);
  if (color.contrast) f.push(`contrast(${(1 + color.contrast).toFixed(3)})`);
  if (color.saturation) f.push(`saturate(${Math.max(0, 1 + color.saturation).toFixed(3)})`);
  if (color.hue) f.push(`hue-rotate(${color.hue}deg)`);
  if (color.blur) f.push(`blur(${color.blur}px)`);
  const pre = COLOR_PRESETS[color.preset];
  if (pre && pre.filter) f.push(pre.filter);
  return f.join(' ') || 'none';
}

const layerCanvases = new Map();
function getLayerCanvas(W, H) {
  const key = `${W}x${H}`;
  let c = layerCanvases.get(key);
  if (!c) { c = document.createElement('canvas'); c.width = W; c.height = H; layerCanvases.set(key, c); }
  return c;
}

function animState(clip, t) {
  const local = t - clip.start;
  const q = clamp(local / Math.max(clip.duration, 0.001), 0, 1);
  const s = { scale: 1, dx: 0, dy: 0, alpha: 1, chars: 1 };
  switch (clip.animation) {
    case 'zoomIn': s.scale = 1 + 0.18 * q; break;
    case 'zoomOut': s.scale = 1.18 - 0.18 * q; break;
    case 'panLeft': s.scale = 1.15; s.dx = (0.5 - q) * 0.12; break;
    case 'panRight': s.scale = 1.15; s.dx = (q - 0.5) * 0.12; break;
    case 'fadeUp': { const e = smooth(clamp(local / 0.7, 0, 1)); s.dy = (1 - e) * 0.06; s.alpha = e; break; }
    case 'pop': { const e = clamp(local / 0.45, 0, 1); s.scale = e < 1 ? 0.6 + 0.4 * (1 + 0.25 * Math.sin(e * Math.PI)) * e : 1; s.alpha = clamp(e * 2, 0, 1); break; }
    case 'typewriter': s.chars = clamp(local / Math.max(0.5, Math.min(2.5, clip.duration * 0.6)), 0, 1); break;
  }
  return s;
}

export function fadeAlpha(clip, t) {
  let a = 1;
  const local = t - clip.start;
  if (clip.fadeIn > 0) a *= clamp(local / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0) a *= clamp((clip.duration - local) / clip.fadeOut, 0, 1);
  return a;
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function drawText(ctx, clip, k, W, H, chars) {
  const T = clip.text;
  const size = T.size * k;
  ctx.font = `${T.italic ? 'italic ' : ''}${T.bold ? '700 ' : '400 '}${size}px "${T.font}", "Segoe UI", sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(T.letterSpacing || 0) * k}px`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = T.align;
  let content = T.content;
  if (chars < 1) content = content.slice(0, Math.round(content.length * chars));
  const lines = wrapLines(ctx, content, W * 0.9);
  const lh = size * T.lineHeight;
  const totalH = lh * lines.length;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  const ax = T.align === 'left' ? -maxW / 2 : T.align === 'right' ? maxW / 2 : 0;
  if (T.bg) {
    const pad = size * 0.3;
    ctx.save();
    ctx.globalAlpha *= T.bgOpacity;
    ctx.fillStyle = T.bgColor;
    const r = size * 0.18;
    const x = -maxW / 2 - pad, y = -totalH / 2 - pad * 0.6, w = maxW + pad * 2, hh = totalH + pad * 1.2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, hh, r) : ctx.rect(x, y, w, hh);
    ctx.fill();
    ctx.restore();
  }
  lines.forEach((line, i) => {
    const y = -totalH / 2 + lh * (i + 0.5);
    if (T.shadow > 0) { ctx.shadowColor = `rgba(0,0,0,${0.75 * T.shadow})`; ctx.shadowBlur = size * 0.15 * T.shadow; ctx.shadowOffsetY = size * 0.04 * T.shadow; }
    if (T.stroke > 0) {
      ctx.lineWidth = T.stroke * k * 2;
      ctx.strokeStyle = T.strokeColor;
      ctx.lineJoin = 'round';
      ctx.strokeText(line, ax, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = T.color;
    ctx.fillText(line, ax, y);
    ctx.shadowColor = 'transparent';
  });
  return { w: maxW, h: totalH };
}

/**
 * Kareyi çizer.
 * getSource(layer) -> { el, w, h } | null  (video/img/canvas)
 */
export function drawFrame(ctx, W, H, project, t, layers, getSource) {
  const k = W / project.settings.width;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = project.settings.background || '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  for (const L of layers) {
    if (L.fill) {
      ctx.save();
      ctx.globalAlpha = clamp(L.alpha, 0, 1);
      ctx.fillStyle = L.fill;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      continue;
    }
    const clip = L.clip;
    const tr = clip.transform;
    const col = clip.color;
    const an = animState(clip, t);
    const alpha = clamp(L.alpha * tr.opacity * fadeAlpha(clip, t) * an.alpha, 0, 1);
    if (alpha <= 0.001) continue;

    const preset = COLOR_PRESETS[col.preset];
    const tint = preset?.tint;
    const needsLayer = !!(col.temperature || col.tint || col.vignette || tint);
    const target = needsLayer ? getLayerCanvas(W, H).getContext('2d') : ctx;
    if (needsLayer) target.clearRect(0, 0, W, H);

    target.save();
    if (!needsLayer) { target.globalAlpha = alpha; target.globalCompositeOperation = tr.blend || 'source-over'; }
    // geçiş maskeleri
    if (L.clipRect) {
      const [cx, cy, cw, ch] = L.clipRect;
      target.beginPath(); target.rect(cx * W, cy * H, cw * W, ch * H); target.clip();
    }
    if (L.circle != null) {
      target.beginPath(); target.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * L.circle, 0, Math.PI * 2); target.clip();
    }
    const off = L.offset || [0, 0];
    target.translate(W / 2 + tr.x * k + off[0] * W + an.dx * W, H / 2 + tr.y * k + off[1] * H + an.dy * H);
    target.rotate((tr.rotation * Math.PI) / 180);
    const sc = tr.scale * an.scale * (L.zoom || 1);
    target.scale(sc * (tr.flipH ? -1 : 1), sc * (tr.flipV ? -1 : 1));
    target.filter = buildFilter(col);

    if (clip.type === 'color') {
      if (clip.gradient) {
        const g = target.createLinearGradient(-W / 2, -H / 2, W / 2, H / 2);
        g.addColorStop(0, clip.fill); g.addColorStop(1, clip.fill2);
        target.fillStyle = g;
      } else target.fillStyle = clip.fill;
      target.fillRect(-W / 2, -H / 2, W, H);
    } else if (clip.type === 'text') {
      drawText(target, clip, k, W, H, an.chars);
    } else {
      const src = getSource(L);
      if (src && src.offline) {
        target.fillStyle = '#5c1418';
        target.fillRect(-W / 2, -H / 2, W, H);
        target.fillStyle = '#ffb3b3';
        target.font = `600 ${Math.round(H * 0.05)}px "Segoe UI", sans-serif`;
        target.textAlign = 'center';
        target.textBaseline = 'middle';
        target.fillText('Medya çevrimdışı', 0, 0);
      } else if (src && src.w && src.h) {
        const fit = tr.fit === 'cover' ? Math.max(W / src.w, H / src.h) : tr.fit === 'fill' ? null : Math.min(W / src.w, H / src.h);
        const dw = fit ? src.w * fit : W, dh = fit ? src.h * fit : H;
        const sx = src.w * tr.cropL, sy = src.h * tr.cropT;
        const sw = src.w * (1 - tr.cropL - tr.cropR), sh = src.h * (1 - tr.cropT - tr.cropB);
        if (sw > 1 && sh > 1) {
          try {
            target.drawImage(src.el, sx, sy, sw, sh, -dw / 2 + dw * tr.cropL, -dh / 2 + dh * tr.cropT, dw * (1 - tr.cropL - tr.cropR), dh * (1 - tr.cropT - tr.cropB));
          } catch { /* kaynak hazır değil */ }
        }
      }
    }
    target.restore();

    if (needsLayer) {
      const lc = target;
      lc.save();
      lc.globalCompositeOperation = 'source-atop';
      if (tint) { lc.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${tint[3]})`; lc.fillRect(0, 0, W, H); }
      if (col.temperature) {
        const a = Math.abs(col.temperature) * 0.22;
        lc.fillStyle = col.temperature > 0 ? `rgba(255,150,40,${a})` : `rgba(40,130,255,${a})`;
        lc.fillRect(0, 0, W, H);
      }
      if (col.tint) {
        const a = Math.abs(col.tint) * 0.18;
        lc.fillStyle = col.tint > 0 ? `rgba(230,40,200,${a})` : `rgba(40,220,90,${a})`;
        lc.fillRect(0, 0, W, H);
      }
      if (col.vignette) {
        const g = lc.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) / 2);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, `rgba(0,0,0,${clamp(col.vignette, 0, 1)})`);
        lc.fillStyle = g;
        lc.fillRect(0, 0, W, H);
      }
      lc.restore();
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = tr.blend || 'source-over';
      ctx.drawImage(lc.canvas, 0, 0);
      ctx.restore();
    }
  }
}

// Ses kazancı: klip sesi + ses geçişleri
export function audioGain(clip, t) {
  if (clip.muted) return 0;
  let g = clip.volume;
  const local = t - clip.start;
  if (clip.audioFadeIn > 0) g *= clamp(local / clip.audioFadeIn, 0, 1);
  if (clip.audioFadeOut > 0) g *= clamp((clip.duration - local) / clip.audioFadeOut, 0, 1);
  return g;
}

// Metin kutusunun sınırlarını hesaplar (önizlemede seçim kutusu için)
export function measureTextBox(clip, project) {
  const c = document.createElement('canvas').getContext('2d');
  const T = clip.text;
  c.font = `${T.italic ? 'italic ' : ''}${T.bold ? '700 ' : '400 '}${T.size}px "${T.font}", sans-serif`;
  const lines = wrapLines(c, T.content, project.settings.width * 0.9);
  const w = Math.max(...lines.map((l) => c.measureText(l).width));
  return { w, h: T.size * T.lineHeight * lines.length };
}
