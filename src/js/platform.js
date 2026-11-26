// Electron / tarayıcı soyutlaması
import { fileKind } from './utils.js';

export const native = window.native || null;
export const isElectron = !!native;

export const pathToUrl = (p) => 'media://file/' + encodeURIComponent(p);
const baseName = (p) => p.split(/[\\/]/).pop();

function pickBrowserFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}

function describeFile(file) {
  const kind = fileKind(file.name);
  if (!kind) return null;
  if (isElectron) {
    const p = native.pathForFile(file);
    if (p) return { name: file.name, path: p, url: pathToUrl(p), kind };
  }
  return { name: file.name, path: null, url: URL.createObjectURL(file), kind, file };
}

export async function pickMedia() {
  if (isElectron) {
    const paths = await native.openMedia();
    return paths.map((p) => ({ name: baseName(p), path: p, url: pathToUrl(p), kind: fileKind(p) })).filter((x) => x.kind);
  }
  const files = await pickBrowserFiles('video/*,audio/*,image/*');
  return files.map(describeFile).filter(Boolean);
}

export async function pickSingleMedia() {
  if (isElectron) {
    const paths = await native.openMedia();
    if (!paths[0]) return null;
    return { name: baseName(paths[0]), path: paths[0], url: pathToUrl(paths[0]), kind: fileKind(paths[0]) };
  }
  const [f] = await pickBrowserFiles('video/*,audio/*,image/*', false);
  return f ? describeFile(f) : null;
}

export const filesFromDrop = (fileList) => [...fileList].map(describeFile).filter(Boolean);

function serialize(project) {
  const clone = JSON.parse(JSON.stringify(project));
  clone.media.forEach((m) => { if (m.url && m.url.startsWith('blob:')) m.url = null; });
  return JSON.stringify(clone, null, 1);
}

export async function saveProject(project, filePath, saveAs = false) {
  const text = serialize(project);
  if (isElectron) {
    let p = filePath;
    if (!p || saveAs) p = await native.saveProjectDialog((project.name || 'Proje') + '.kurgu');
    if (!p) return null;
    await native.writeText(p, text);
    return p;
  }
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (project.name || 'Proje') + '.kurgu';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'browser';
}

export async function openProjectFile(path = null) {
  if (isElectron) {
    const p = path || (await native.openProject());
    if (!p) return null;
    const project = JSON.parse(await native.readText(p));
    for (const m of project.media) {
      m.offline = !(m.path && (await native.exists(m.path)));
      if (m.path) m.url = pathToUrl(m.path);
    }
    return { project, path: p };
  }
  const [f] = await pickBrowserFiles('.kurgu,application/json', false);
  if (!f) return null;
  const project = JSON.parse(await f.text());
  project.media.forEach((m) => { m.offline = true; });
  return { project, path: null };
}

export const projectNameFromPath = (p) => baseName(p).replace(/\.kurgu$/i, '');
