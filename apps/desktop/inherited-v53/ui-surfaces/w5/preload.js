const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('damarDesktop', Object.freeze({
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', Boolean(ignore)),
  setStandbyMode: (standby) => ipcRenderer.send('set-standby-mode', Boolean(standby)),
  getCursorPoint: () => ipcRenderer.invoke('damar-cursor-point'),
  windowControl: (action) => ipcRenderer.send('window-control', action),
  navigateSurface: (surface) => ipcRenderer.invoke('damar-navigate-surface', surface),
  launchCli: () => ipcRenderer.invoke('launch-damar-cli'),
  runtimeRequest: (request) => ipcRenderer.invoke('damar-runtime-request', request),
  on: (event, listener) => {
    const allowed = new Set(['play-outro-before-close', 'window-restored', 'toggle-standby-orb']);
    if (!allowed.has(event) || typeof listener !== 'function') return () => {};
    const wrapped = () => listener();
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  }
}));
