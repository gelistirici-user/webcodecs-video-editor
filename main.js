// Kurgu Studio — Electron ana süreç
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

// media://file/<encodeURIComponent(mutlak yol)> — Range destekli, CORS açık yerel dosya sunumu.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const APP_ROOT = path.join(__dirname, 'src');
const APP_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
async function serveApp(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !rel) rel = '/index.html';
  const file = path.normalize(path.join(APP_ROOT, rel));
  if (!file.startsWith(APP_ROOT)) return new Response('Yasak', { status: 403 });
  try {
    const data = await fsp.readFile(file);
    return new Response(data, { headers: { 'Content-Type': APP_TYPES[path.extname(file)] || 'application/octet-stream' } });
  } catch { return new Response('Bulunamadı', { status: 404 }); }
}

function serveMedia(request) {
  const url = new URL(request.url);
  const filePath = decodeURIComponent(url.pathname.slice(1));
  let stat;
  try { stat = fs.statSync(filePath); } catch { return new Response('Bulunamadı', { status: 404 }); }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
    return new Response(stream, { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) } });
}

let win = null;
let allowClose = false;
const exportHandles = new Map();
let pendingOpen = process.argv.find((a) => a.toLowerCase().endsWith('.kurgu')) || null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 950, minWidth: 1100, minHeight: 680,
    backgroundColor: '#15171c', title: 'Kurgu Studio', show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('app://kurgu/index.html');
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('app:close-request');
  });
}

app.whenReady().then(() => {
  protocol.handle('media', serveMedia);
  protocol.handle('app', serveApp);
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
const mediaFilters = [
  { name: 'Medya', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
  { name: 'Tüm dosyalar', extensions: ['*'] },
];

ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Medya içe aktar', properties: ['openFile', 'multiSelections'], filters: mediaFilters });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Proje aç', properties: ['openFile'], filters: [{ name: 'Kurgu Studio Projesi', extensions: ['kurgu'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:saveProject', async (_e, suggested) => {
  const r = await dialog.showSaveDialog(win, { title: 'Projeyi kaydet', defaultPath: suggested || 'Proje.kurgu', filters: [{ name: 'Kurgu Studio Projesi', extensions: ['kurgu'] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:saveExport', async (_e, suggested, ext) => {
  const r = await dialog.showSaveDialog(win, { title: 'Dışa aktar', defaultPath: suggested, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('fs:readText', (_e, p) => fsp.readFile(p, 'utf8'));
ipcMain.handle('fs:writeText', (_e, p, text) => fsp.writeFile(p, text, 'utf8'));
ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
ipcMain.handle('fs:stat', async (_e, p) => { const s = await fsp.stat(p); return { size: s.size, mtime: s.mtimeMs }; });
ipcMain.handle('app:userData', () => app.getPath('userData'));
ipcMain.handle('app:pendingOpen', () => { const p = pendingOpen; pendingOpen = null; return p; });
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app:confirmClose', () => { allowClose = true; win.close(); });

// Dışa aktarma: dosyaya konumlu yazım (mediabunny StreamTarget)
ipcMain.handle('export:open', async (_e, p) => {
  const fh = await fsp.open(p, 'w');
  const id = String(Date.now()) + Math.random().toString(16).slice(2);
  exportHandles.set(id, fh);
  return id;
});
ipcMain.handle('export:write', async (_e, id, position, data) => {
  const fh = exportHandles.get(id);
  if (!fh) throw new Error('Geçersiz dosya');
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await fh.write(buf, 0, buf.length, position);
});
ipcMain.handle('export:close', async (_e, id, removeFile, p) => {
  const fh = exportHandles.get(id);
  exportHandles.delete(id);
  if (fh) await fh.close();
  if (removeFile && p) await fsp.rm(p, { force: true });
});
