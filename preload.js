const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vx', {
  hello: () => ipcRenderer.invoke('vx:hello'),
  retry: () => ipcRenderer.send('vx:retry'),
  quit: () => ipcRenderer.send('vx:quit'),
  openAdmin: () => ipcRenderer.send('vx:open-admin'),
  openSettings: () => ipcRenderer.send('vx:open-settings'),
  back: () => ipcRenderer.send('vx:back'),
  settingsGet: () => ipcRenderer.invoke('vx:settings-get'),
  settingsSave: (cfg) => ipcRenderer.invoke('vx:settings-save', cfg),
  chooseSa: () => ipcRenderer.invoke('vx:choose-sa'),
  testUpstream: (host, port) => ipcRenderer.invoke('vx:test-upstream', host, port),
  onState: (cb) => ipcRenderer.on('vx:state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('vx:log', (_e, line) => cb(line)),
});