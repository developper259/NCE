const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('FileManager:selectFile'),
  getFileContent: (file) => ipcRenderer.invoke('FileManager:getFileContent', file),
});
