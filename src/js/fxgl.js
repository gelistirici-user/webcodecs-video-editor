// GPU renk motoru (WebGL2): renk çarkları (lift/gamma/gain), eğriler, 3B LUT, chroma key
// Hem önizleme hem dışa aktarma aynı gölgelendiriciyi kullanır.
import { clamp } from './utils.js';

export const DEFAULT_GRADE = () => ({
  lift: [0, 0, 0, 0], gamma: [0, 0, 0, 0], gain: [0, 0, 0, 0], // [r, g, b, ana] (−1..1)
  curves: { m: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
  lut: null, lutMix: 1,
  key: { on: false, color: '#00ff00', sim: 0.35, smooth: 0.1, spill: 0.6 },
});

const isIdentityCurve = (pts) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);
export function gradeActive(g) {
  if (!g) return false;
  const nz = (a) => a && a.some((v) => Math.abs(v) > 1e-4);
  return nz(g.lift) || nz(g.gamma) || nz(g.gain) || ['m', 'r', 'g', 'b'].some((k) => !isIdentityCurve(g.curves?.[k])) || !!g.lut || !!g.key?.on;
}

// Monoton kübik eğri (Fritsch–Carlson) -> 256 örnek
export function curveTable(pts, n = 256) {
  const P = [...pts].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(n);
  if (P.length < 2) { for (let i = 0; i < n; i++) out[i] = i / (n - 1); return out; }
  const k = P.length;
  const d = [], m = new Array(k);
  for (let i = 0; i < k - 1; i++) d.push((P[i + 1][1] - P[i][1]) / Math.max(1e-6, P[i + 1][0] - P[i][0]));
  m[0] = d[0]; m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= P[0][0]) { out[j] = P[0][1]; continue; }
    if (x >= P[k - 1][0]) { out[j] = P[k - 1][1]; continue; }
    while (seg < k - 2 && x > P[seg + 1][0]) seg++;
    const x0 = P[seg][0], x1 = P[seg + 1][0], hh = x1 - x0, t = (x - x0) / hh;
    const t2 = t * t, t3 = t2 * t;
    out[j] = clamp((2 * t3 - 3 * t2 + 1) * P[seg][1] + (t3 - 2 * t2 + t) * hh * m[seg] + (-2 * t3 + 3 * t2) * P[seg + 1][1] + (t3 - t2) * hh * m[seg + 1], 0, 1);
  }
  return out;
}

// .cube LUT dosyası
export function parseCube(text) {
  let size = 0;
  const data = [];
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue;
    const v = line.split(/\s+/).map(Number);
    if (v.length >= 3 && v.every((x) => isFinite(x))) data.push(v[0], v[1], v[2]);
  }
  if (!size || data.length !== size * size * size * 3) throw new Error('Geçersiz veya desteklenmeyen .cube dosyası (yalnızca 3B LUT)');
  // alan dışı değerleri 0..1'e normalize et
  for (let i = 0; i < data.length; i++) { const c = i % 3; data[i] = Math.round(clamp((data[i] - dmin[c]) / (dmax[c] - dmin[c] || 1), 0, 1) * 10000) / 10000; }
  return { size, data };
}

const hexRgb = (hex) => { const n = parseInt((hex || '#00ff00').slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D src; uniform sampler2D curves; uniform sampler3D lut;
uniform vec3 lift, gam, gain; uniform float useLut, lutMix, lutSize;
uniform float keyOn, sim, smth, spill; uniform vec3 keyCol;
vec2 cbcr(vec3 c){ return vec2(-0.1146*c.r-0.3854*c.g+0.5*c.b, 0.5*c.r-0.4542*c.g-0.0458*c.b); }
void main(){
  vec4 s = texture(src, uv);
  vec3 c = s.a > 0. ? s.rgb / s.a : s.rgb;
  // renk çarkları (ASC CDL benzeri)
  c = c * (1.0 + gain) + lift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / max(1.0 + gam, 0.05));
  c = clamp(c, 0.0, 1.0);
  // eğriler: kanal eğrisi sonra ana eğri
  c = vec3(texture(curves, vec2(c.r*255./256.+0.5/256., 0.5)).r, texture(curves, vec2(c.g*255./256.+0.5/256., 0.5)).g, texture(curves, vec2(c.b*255./256.+0.5/256., 0.5)).b);
  c = vec3(texture(curves, vec2(c.r*255./256.+0.5/256., 0.5)).a, texture(curves, vec2(c.g*255./256.+0.5/256., 0.5)).a, texture(curves, vec2(c.b*255./256.+0.5/256., 0.5)).a);
  if (useLut > 0.5) { vec3 q = c * ((lutSize - 1.0) / lutSize) + 0.5 / lutSize; c = mix(c, texture(lut, q).rgb, lutMix); }
  float a = s.a;
  if (keyOn > 0.5) {
    float d = distance(cbcr(c), cbcr(keyCol));
    float k = smoothstep(sim * 0.5, sim * 0.5 + smth * 0.5 + 0.001, d);
    a *= k;
    // yeşil/mavi taşmasını bastır
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 kc = normalize(keyCol + 1e-4);
    float sp = max(0.0, dot(c - lum, kc)) * spill * (1.0 - k * 0.5);
    c = clamp(c - kc * sp, 0.0, 1.0);
  }
  o = vec4(c * a, a);
}`;

let G = null;
function init() {
  if (G) return G;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  if (!gl) { G = { failed: true }; return G; }
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = (unit, target = gl.TEXTURE_2D) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t); gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE); return t; };
  const U = {};
  for (const n of ['src', 'curves', 'lut', 'lift', 'gam', 'gain', 'useLut', 'lutMix', 'lutSize', 'keyOn', 'sim', 'smth', 'spill', 'keyCol']) U[n] = gl.getUniformLocation(prog, n);
  const tSrc = tex(0), tCurves = tex(1), tLut = tex(2, gl.TEXTURE_3D);
  gl.uniform1i(U.src, 0); gl.uniform1i(U.curves, 1); gl.uniform1i(U.lut, 2);
  gl.activeTexture(gl.TEXTURE2);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 1, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); G = null; });
  G = { canvas, gl, U, tSrc, tCurves, tLut, curveKey: '', lutKey: '' };
  return G;
}

function uploadCurves(g, grade) {
  const key = JSON.stringify(grade.curves);
  if (g.curveKey === key) return;
  g.curveKey = key;
  const C = grade.curves || {};
  const tr = curveTable(C.r || [[0, 0], [1, 1]]), tg = curveTable(C.g || [[0, 0], [1, 1]]), tb = curveTable(C.b || [[0, 0], [1, 1]]), tm = curveTable(C.m || [[0, 0], [1, 1]]);
  const px = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) { px[i * 4] = Math.round(tr[i] * 255); px[i * 4 + 1] = Math.round(tg[i] * 255); px[i * 4 + 2] = Math.round(tb[i] * 255); px[i * 4 + 3] = Math.round(tm[i] * 255); }
  const { gl } = g;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, g.tCurves);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
}

function uploadLut(g, lut) {
  const key = lut ? lut.id || lut.name + lut.size : '';
  if (g.lutKey === key) return;
  g.lutKey = key;
  if (!lut) return;
  const { gl } = g;
  const n = lut.size;
  const px = new Uint8Array(n * n * n * 3);
  for (let i = 0; i < px.length; i++) px[i] = Math.round(lut.data[i] * 255);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_3D, g.tLut);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  // .cube: kırmızı en hızlı değişen eksen -> 3B dokunun x ekseni
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, n, n, n, 0, gl.RGB, gl.UNSIGNED_BYTE, px);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
}

/**
 * Kaynak görüntüye renk işlemlerini uygular, işlenmiş tuvali döndürür (yoksa null).
 * lutLookup(id) -> { size, data } proje LUT'u
 */
export function applyGrade(el, w, h, grade, lutLookup) {
  let g;
  try { g = init(); } catch (e) { console.warn('GPU renk motoru başlatılamadı', e); G = { failed: true }; return null; }
  if (g.failed) return null;
  const { gl, U, canvas } = g;
  const maxW = 1920;
  const k = Math.min(1, maxW / w);
  const cw = Math.max(2, Math.round(w * k)), ch = Math.max(2, Math.round(h * k));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  gl.viewport(0, 0, cw, ch);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, g.tSrc);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el); } catch { return null; }
  uploadCurves(g, grade);
  const lut = grade.lut ? lutLookup?.(grade.lut) : null;
  uploadLut(g, lut);
  const v3 = (a) => { const m = a?.[3] || 0; return [(a?.[0] || 0) + m, (a?.[1] || 0) + m, (a?.[2] || 0) + m]; };
  const L = v3(grade.lift), Ga = v3(grade.gamma), Gn = v3(grade.gain);
  gl.uniform3f(U.lift, L[0] * 0.5, L[1] * 0.5, L[2] * 0.5);
  gl.uniform3f(U.gam, Ga[0], Ga[1], Ga[2]);
  gl.uniform3f(U.gain, Gn[0], Gn[1], Gn[2]);
  gl.uniform1f(U.useLut, lut ? 1 : 0);
  gl.uniform1f(U.lutMix, clamp(grade.lutMix ?? 1, 0, 1));
  gl.uniform1f(U.lutSize, lut ? lut.size : 1);
  const K = grade.key || {};
  gl.uniform1f(U.keyOn, K.on ? 1 : 0);
  gl.uniform1f(U.sim, K.sim ?? 0.35); gl.uniform1f(U.smth, K.smooth ?? 0.1); gl.uniform1f(U.spill, K.spill ?? 0.6);
  const kc = hexRgb(K.color); gl.uniform3f(U.keyCol, kc[0], kc[1], kc[2]);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}
