const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('archsyncDesktop',Object.freeze({chooseFolder: () => ipcRenderer.invoke('archsync:choose-folder')}));
