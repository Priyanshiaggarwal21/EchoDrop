const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('echoDesktop', {
  secureContent: { run: (projectId, action, value) => ipcRenderer.invoke('workspace:secure-content', projectId, action, value) },
  remoteCollaboration: { run: (projectId, action, value) => ipcRenderer.invoke('workspace:remote-collaboration', projectId, action, value) },
  collaboration: {
    snapshot: projectId => ipcRenderer.invoke('workspace:collaboration', 'snapshot', projectId),
    execute: (projectId, command) => ipcRenderer.invoke('workspace:collaboration', 'execute', projectId, command),
  },
  registry: {
    list: () => ipcRenderer.invoke('workspace:registry', 'list'),
    selectFolder: () => ipcRenderer.invoke('workspace:registry', 'select-folder'),
    create: (input, folderToken) => ipcRenderer.invoke('workspace:registry', 'create', { input, folderToken }),
    update: (id, patch) => ipcRenderer.invoke('workspace:registry', 'update', { id, patch }),
    openFolder: id => ipcRenderer.invoke('workspace:registry', 'open-folder', id),
  },
  onNavigation: (callback) => {
    const listener = (_event, direction) => { if (direction === 'back' || direction === 'forward') callback(direction); };
    ipcRenderer.on('workspace:navigate', listener);
    return () => ipcRenderer.removeListener('workspace:navigate', listener);
  },
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
