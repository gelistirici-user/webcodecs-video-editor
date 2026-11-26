// Kopyalar: node_modules içindeki tarayıcı modüllerini src/vendor altına alır.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'vendor');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(
  path.join(root, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'),
  path.join(out, 'mediabunny.mjs')
);
console.log('vendor: mediabunny.mjs kopyalandı');

// Whisper (otomatik altyazı): transformers.js + ONNX Runtime wasm
const tdir = path.join(out, 'transformers');
fs.mkdirSync(tdir, { recursive: true });
const tsrc = path.join(root, 'node_modules', '@huggingface', 'transformers', 'dist');
for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) fs.copyFileSync(path.join(tsrc, f), path.join(tdir, f));
console.log('vendor: transformers.js kopyalandı');
