import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('agent', {
  load: () => ipcRenderer.invoke('config:load'), save: (v: unknown) => ipcRenderer.invoke('config:save', v),
  printers: () => ipcRenderer.invoke('printers:list'), test: (deviceName: string) => ipcRenderer.invoke('printer:test', deviceName),
  status: () => ipcRenderer.invoke('status:get'), close: () => ipcRenderer.send('window:hide'),
  activity: () => ipcRenderer.invoke('activity:list'), clearActivity: () => ipcRenderer.invoke('activity:clear'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
});
