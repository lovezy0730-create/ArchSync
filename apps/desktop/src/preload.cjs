const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('archsyncDesktop',Object.freeze({
  chooseFolder: () => ipcRenderer.invoke('archsync:choose-folder'),
  /** Startup/diagnostic page: subscribe to main-process status updates. */
  onStartupStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => { try { callback(status); } catch { /* page handler error */ } };
    ipcRenderer.on('archsync:startup-status', listener);
    return () => ipcRenderer.removeListener('archsync:startup-status', listener);
  },
  getStartupInfo: () => ipcRenderer.invoke('archsync:startup-info'),
  retryStartup: () => ipcRenderer.invoke('archsync:retry-startup'),
  openLogs: () => ipcRenderer.invoke('archsync:open-logs'),
}));
