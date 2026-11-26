// Görüntü analizi: sabitleme (global kayma) ve bölge takibi (şablon eşleme)
import { Input, UrlSource, ALL_FORMATS, CanvasSink } from '../vendor/mediabunny.mjs';
import { store } from './store.js';
import { clamp } from './utils.js';
import { srcTimeAt } from './timemap.js';

// Kaynağın [a, b] aralığındaki kareleri gri tonlamalı olarak verir
async function* grayFrames(url, times, width) {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const tr = await input.getPrimaryVideoTrack();
    if (!tr || !(await tr.canDecode())) throw new Error('Video çözümlenemiyor');
    const w = Math.min(width, tr.displayWidth), hh = Math.round((w * tr.displayHeight) / tr.displayWidth);
    const sink = new CanvasSink(tr, { width: w, height: hh, fit: 'fill', poolSize: 2 });
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = hh;
    const tx = tmp.getContext('2d', { willReadFrequently: true });
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (!wc) { i++; continue; }
      tx.drawImage(wc.canvas, 0, 0);
      const d = tx.getImageData(0, 0, w, hh).data;
      const g = new Float32Array(w * hh);
      for (let p = 0, q = 0; p < g.length; p++, q += 4) g[p] = 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
      yield { t: times[i], gray: g, w, h: hh, srcW: tr.displayWidth, srcH: tr.displayHeight };
      i++;
    }
  } finally { input.dispose?.(); }
}

// İki kare arasındaki global kayma (piksel); merkez bölgede SAD + parabolik alt piksel
function globalShift(a, b, w, hh, R = 8) {
  const m = Math.round(Math.min(w, hh) * 0.12) + R;
  let best = Infinity, bx = 0, by = 0;
  const sad = (dx, dy) => {
    let s = 0;
    for (let y = m; y < hh - m; y += 2) {
      const ro = y * w, rs = (y + dy) * w;
      for (let x = m; x < w - m; x += 2) s += Math.abs(a[ro + x] - b[rs + x + dx]);
    }
    return s;
  };
  const cache = new Map();
  const S = (dx, dy) => { const k = dx * 1000 + dy; if (!cache.has(k)) cache.set(k, sad(dx, dy)); return cache.get(k); };
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const s = S(dx, dy); if (s < best) { best = s; bx = dx; by = dy; } }
  const sub = (l, c, r) => { const d = l - 2 * c + r; return d > 0 ? clamp((l - r) / (2 * d), -0.5, 0.5) : 0; };
  const fx = bx > -R && bx < R ? sub(S(bx - 1, by), best, S(bx + 1, by)) : 0;
  const fy = by > -R && by < R ? sub(S(bx, by - 1), best, S(bx, by + 1)) : 0;
  return [bx + fx, by + fy];
}

const smoothArr = (arr, win) => arr.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - win); k <= Math.min(arr.length - 1, i + win); k++) { s += arr[k]; n++; } return s / n; });

/**
 * Sabitleme analizi: klibin kaynak aralığındaki titreşimi ölçer.
 * Sonuç: { fps, t0, dx[], dy[] } (kaynak genişliğine/yüksekliğine oranla düzeltme), zoom önerisi
 */
export async function analyzeStabilization(clip, { smoothness = 0.5, onProgress, signal } = {}) {
  const m = store.media(clip.mediaId);
  const fps = Math.min(30, m.fps || store.fps);
  const a = Math.min(srcTimeAt(clip, clip.start, m), srcTimeAt(clip, clip.start + clip.duration, m));
  const b = Math.max(srcTimeAt(clip, clip.start, m), srcTimeAt(clip, clip.start + clip.duration, m));
  const times = [];
  for (let t = a; t <= b + 1e-6; t += 1 / fps) times.push(Math.min(t, m.duration - 0.001));
  const xs = [0], ys = [0];
  let prev = null, W = 0, H = 0, i = 0;
  for await (const f of grayFrames(m.url, times, 192)) {
    if (signal?.aborted) throw new DOMException('İptal edildi', 'AbortError');
    W = f.w; H = f.h;
    if (prev) { const [dx, dy] = globalShift(prev, f.gray, W, H); xs.push(xs[xs.length - 1] + dx); ys.push(ys[ys.length - 1] + dy); }
    prev = f.gray;
    if (++i % 10 === 0) onProgress?.(i / times.length);
  }
  const win = Math.round(4 + smoothness * 40);
  const sx = smoothArr(xs, win), sy = smoothArr(ys, win);
  // düzeltme = yumuşatılmış yol - ham yol (oranlı)
  const dx = xs.map((v, k) => Math.round(((sx[k] - v) / W) * 1e5) / 1e5);
  const dy = ys.map((v, k) => Math.round(((sy[k] - v) / H) * 1e5) / 1e5);
  const maxOff = Math.max(...dx.map(Math.abs), ...dy.map(Math.abs), 0);
  return { on: true, fps, t0: a, dx, dy, zoom: Math.round((1 + Math.min(0.25, maxOff * 2.2)) * 1000) / 1000, smoothness };
}

// Sabitleme düzeltmesi (oran) — kaynak zamanına göre doğrusal ara değer
export function stabAt(stab, srcT) {
  if (!stab?.on || !stab.dx?.length) return null;
  const x = clamp((srcT - stab.t0) * stab.fps, 0, stab.dx.length - 1);
  const i = Math.floor(x), f = x - i, j = Math.min(i + 1, stab.dx.length - 1);
  return [stab.dx[i] + (stab.dx[j] - stab.dx[i]) * f, stab.dy[i] + (stab.dy[j] - stab.dy[i]) * f];
}

/**
 * Bölge takibi: kaynak karede (oransal) kutuyu ileri yönde izler.
 * box: { cx, cy, w, h } kaynak genişlik/yüksekliğine oranla. Sonuç: [{ t (zaman çizelgesi), cx, cy }]
 */
export async function trackRegion(clip, fromT, toT, box, { onProgress, signal } = {}) {
  const m = store.media(clip.mediaId);
  const fps = Math.min(30, m.fps || store.fps);
  const tl = [];
  for (let t = fromT; t <= toT + 1e-6; t += 1 / fps) tl.push(t);
  const times = tl.map((t) => srcTimeAt(clip, t, m));
  const out = [];
  let tpl = null, wgt = null, cx = 0, cy = 0, tw = 0, th = 0, i = 0;
  for await (const f of grayFrames(m.url, times, 480)) {
    if (signal?.aborted) throw new DOMException('İptal edildi', 'AbortError');
    const { w, h: hh, gray } = f;
    if (!tpl) {
      tw = clamp(Math.round(box.w * w), 8, w - 2); th = clamp(Math.round(box.h * hh), 8, hh - 2);
      cx = box.cx * w; cy = box.cy * hh;
      // merkez ağırlıklı (Gauss) eşleme: kutu kenarındaki arka plan baskın olmasın
      wgt = new Float32Array(tw * th);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const u = (x - tw / 2) / (tw / 2), v = (y - th / 2) / (th / 2); wgt[y * tw + x] = Math.exp(-2.2 * (u * u + v * v)); }
    } else {
      // arama: önceki konum çevresinde ±R piksel
      const R = Math.round(clamp(Math.max(tw, th) * 0.6, 8, 28));
      let best = Infinity, bx = cx, by = cy;
      const x0 = Math.round(cx - tw / 2), y0 = Math.round(cy - th / 2);
      const step = tw * th > 2500 ? 2 : 1;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const sx = x0 + dx, sy = y0 + dy;
        if (sx < 0 || sy < 0 || sx + tw >= w || sy + th >= hh) continue;
        let s = 0;
        for (let y = 0; y < th && s < best; y += step) { const ro = (sy + y) * w + sx, to = y * tw; for (let x = 0; x < tw; x += step) s += wgt[to + x] * Math.abs(gray[ro + x] - tpl[to + x]); }
        // küçük hareket tercihi: eşit eşleşmelerde en yakın konum
        s *= 1 + 0.002 * (dx * dx + dy * dy);
        if (s < best) { best = s; bx = cx + dx; by = cy + dy; }
      }
      cx = bx; cy = by;
    }
    // şablonu güncelle (yavaş kayma ile ışık değişimine uyum)
    const nt = new Float32Array(tw * th);
    const x0 = Math.round(cx - tw / 2), y0 = Math.round(cy - th / 2);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) nt[y * tw + x] = gray[clamp(y0 + y, 0, hh - 1) * w + clamp(x0 + x, 0, w - 1)];
    if (tpl) for (let k = 0; k < tpl.length; k++) tpl[k] = tpl[k] * 0.85 + nt[k] * 0.15; else tpl = nt;
    out.push({ t: tl[i], cx: cx / w, cy: cy / hh });
    if (++i % 5 === 0) onProgress?.(i / tl.length);
  }
  return out;
}
