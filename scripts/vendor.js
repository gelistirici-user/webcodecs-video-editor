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
