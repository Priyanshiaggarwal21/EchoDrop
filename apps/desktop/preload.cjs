const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('echoDesktop', {
  restore: () => ipcRenderer.invoke('workspace:restore'),
  start: () => ipcRenderer.invoke('workspace:start'),
  state: () => ipcRenderer.invoke('workspace:state'),
  open: (area) => ipcRenderer.invoke('workspace:open', area),
  transfer: (request) => ipcRenderer.invoke('workspace:transfer', request),
  download: (path) => ipcRenderer.invoke('workspace:download', path),
  pairing: (path, body) => ipcRenderer.invoke('workspace:pairing', path, body),
  project: (action, value) => ipcRenderer.invoke('workspace:project', action, value),
  preview: (action, kind) => ipcRenderer.invoke('workspace:preview', action, kind),
});
