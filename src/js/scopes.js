// Renk sayfası ölçümleri: dalga formu (luma), RGB histogram, vektörskop
const SW = 320, SH = 180;

export class Scopes {
  constructor(canvas, source) {
    this.canvas = canvas;
    this.source = source;
    this.mode = 'waveform';
    this.tmp = document.createElement('canvas');
    this.tmp.width = 256; this.tmp.height = 144;
    this.tctx = this.tmp.getContext('2d', { willReadFrequently: true });
    this.active = false;
    this._last = 0;
  }

  update(force = false) {
    if (!this.active) return;
    const now = performance.now();
    if (!force && now - this._last < 90) return;
    this._last = now;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth || SW, H = this.canvas.clientHeight || SH;
    if (this.canvas.width !== Math.round(W * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, W, H);
    this.tctx.drawImage(this.source, 0, 0, 256, 144);
    const d = this.tctx.getImageData(0, 0, 256, 144).data;
    if (this.mode === 'waveform') this.waveform(ctx, d, W, H);
    else if (this.mode === 'histogram') this.histogram(ctx, d, W, H);
    else this.vectorscope(ctx, d, W, H);
  }

  grid(ctx, W, H, labels) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.lineWidth = 1;
    labels.forEach((l, i) => {
      const y = Math.round(8 + (H - 16) * (i / (labels.length - 1))) + 0.5;
      ctx.beginPath(); ctx.moveTo(22, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillText(l, 2, y + 3);
    });
  }

  waveform(ctx, d, W, H) {
    this.grid(ctx, W, H, ['100', '75', '50', '25', '0']);
    const img = ctx.createImageData(256, 128);
    const acc = new Uint16Array(256 * 128);
    for (let y = 0; y < 144; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const row = 127 - Math.min(127, Math.round(l / 2));
      acc[row * 256 + x]++;
    }
    for (let i = 0; i < acc.length; i++) {
      const v = Math.min(255, acc[i] * 40);
      img.data[i * 4] = v * 0.55; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.7; img.data[i * 4 + 3] = v ? 255 : 0;
    }
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    c.getContext('2d').putImageData(img, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(c, 22, 8, W - 24, H - 16);
    ctx.globalCompositeOperation = 'source-over';
  }

  histogram(ctx, d, W, H) {
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < d.length; i += 4) { bins[0][d[i]]++; bins[1][d[i + 1]]++; bins[2][d[i + 2]]++; }
    let mx = 1;
    bins.forEach((b) => b.forEach((v, i) => { if (i > 0 && i < 255 && v > mx) mx = v; }));
    const cols = ['rgba(255,70,70,0.6)', 'rgba(70,255,110,0.55)', 'rgba(80,140,255,0.6)'];
    ctx.globalCompositeOperation = 'lighter';
    bins.forEach((b, k) => {
      ctx.fillStyle = cols[k];
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, b[i] / mx) * (H - 6));
      ctx.lineTo(W, H); ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  vectorscope(ctx, d, W, H) {
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // ten tonu çizgisi
    ctx.strokeStyle = 'rgba(255,180,120,0.3)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(-2.15) * R, cy + Math.sin(-2.15) * R); ctx.stroke();
    const targets = { R: [255, 0, 0], Y: [255, 255, 0], G: [0, 255, 0], C: [0, 255, 255], B: [0, 0, 255], M: [255, 0, 255] };
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px "Segoe UI", sans-serif';
    for (const [k, [r, g, b]] of Object.entries(targets)) {
      const u = -0.1146 * r - 0.3854 * g + 0.5 * b, v = 0.5 * r - 0.4542 * g - 0.0458 * b;
      ctx.fillText(k, cx + (u / 128) * R * 0.75 - 3, cy - (v / 128) * R * 0.75 + 3);
    }
    ctx.fillStyle = 'rgba(120,255,160,0.35)';
    for (let i = 0; i < d.length; i += 8) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const u = -0.1146 * r - 0.3854 * g + 0.5 * b, v = 0.5 * r - 0.4542 * g - 0.0458 * b;
      ctx.fillRect(cx + (u / 128) * R * 0.75, cy - (v / 128) * R * 0.75, 1, 1);
    }
  }
}
