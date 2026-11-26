// build/icon.png üretir (256x256): mavi yuvarlatılmış kare + beyaz oynat üçgeni + kesme çizgisi
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const S = 256;
const px = Buffer.alloc(S * S * 4);
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const s = (px1, py1, px2, py2, px3, py3) => (px1 - px3) * (py2 - py3) - (px2 - px3) * (py1 - py3);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const SS = 4; // kenar yumuşatma
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let a = 0, w = 0, cut = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const X = x + (sx + 0.5) / SS, Y = y + (sy + 0.5) / SS;
    if (inRound(X, Y, 12, 28, 244, 228, 46)) {
      a++;
      if (inTri(X, Y, [100, 82], [100, 174], [178, 128])) w++;
      else if (X > 40 && X < 216 && Y > 196 && Y < 204) cut++;
    }
  }
  const n = SS * SS, i = (y * S + x) * 4;
  const fa = a / n, fw = w / Math.max(1, a), fc = cut / Math.max(1, a);
  const t = y / S; // dikey gradyan
  const base = [Math.round(76 - 30 * t), Math.round(141 - 50 * t), 255 - Math.round(40 * t)];
  const mix = (b, wv, cv) => Math.round(b * (1 - fw - fc) + 255 * fw + cv * fc);
  px[i] = mix(base[0], 255, 255); px[i + 1] = mix(base[1], 255, 120); px[i + 2] = mix(base[2], 255, 120);
  px[i + 3] = Math.round(fa * 255);
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), png);
fs.copyFileSync(path.join(__dirname, '..', 'build', 'icon.png'), path.join(__dirname, '..', 'src', 'icon.png'));
console.log('build/icon.png yazıldı');
