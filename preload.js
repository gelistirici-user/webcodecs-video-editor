const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  isElectron: true,
  openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  openProject: () => ipcRenderer.invoke('dialog:openProject'),
  saveProjectDialog: (s) => ipcRenderer.invoke('dialog:saveProject', s),
  saveExportDialog: (s, ext) => ipcRenderer.invoke('dialog:saveExport', s, ext),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),
  writeText: (p, t) => ipcRenderer.invoke('fs:writeText', p, t),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  userData: () => ipcRenderer.invoke('app:userData'),
  pendingOpen: () => ipcRenderer.invoke('app:pendingOpen'),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
  onCloseRequest: (cb) => ipcRenderer.on('app:close-request', () => cb()),
  pathForFile: (file) => webUtils.getPathForFile(file),
  exportOpen: (p) => ipcRenderer.invoke('export:open', p),
  exportWrite: (id, pos, data) => ipcRenderer.invoke('export:write', id, pos, data),
  exportClose: (id, remove, p) => ipcRenderer.invoke('export:close', id, remove, p),
});
