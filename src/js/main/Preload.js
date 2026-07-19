const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  quit: () => ipcRenderer.invoke("App:quit"),
  selectFile: () => ipcRenderer.invoke("FileManager:selectFile"),
  selectFiles: () => ipcRenderer.invoke("FileManager:selectFiles"),
  selectNewFile: (name) =>
    ipcRenderer.invoke("FileManager:selectNewFile", name),
  getFileContent: (file) =>
    ipcRenderer.invoke("FileManager:getFileContent", file),
  saveFile: (path, content) =>
    ipcRenderer.invoke("FileManager:saveFile", path, content),
  confirmUnsavedChanges: (fileName) =>
    ipcRenderer.invoke("FileManager:confirmUnsavedChanges", fileName),
  getFolderContent: (dirPath) =>
    ipcRenderer.invoke("FileManager:getFolderContent", dirPath),
  selectFolder: () => ipcRenderer.invoke("FileManager:selectFolder"),
  initializeFile: (filePath) =>
    ipcRenderer.invoke("FileManager:initializeFile", filePath),
  getFileChunk: (filePath, startLine, lineCount) =>
    ipcRenderer.invoke(
      "FileManager:getFileChunk",
      filePath,
      startLine,
      lineCount,
    ),
  saveEditorState: (stateString) =>
    ipcRenderer.invoke("FileManager:saveState", stateString),

  loadEditorState: () => ipcRenderer.invoke("FileManager:loadState"),

  onSaveRequest: (callback) =>
    ipcRenderer.on("Request:saveState", () => callback()),

  onLoadState: (callback) =>
    ipcRenderer.on("Request:loadState", (_event, state) => callback(state)),
});
