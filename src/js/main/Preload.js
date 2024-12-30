const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  quit: () => ipcRenderer.invoke('App:quit'),
  selectFile: () => ipcRenderer.invoke('FileManager:selectFile'),
  selectFiles: () => ipcRenderer.invoke('FileManager:selectFiles'),
  selectNewFile: (name) => ipcRenderer.invoke('FileManager:selectNewFile', name),
  getFileContent: (file) => ipcRenderer.invoke('FileManager:getFileContent', file),
  saveFile: (path, content) => ipcRenderer.invoke('FileManager:saveFile', path, content),
});
