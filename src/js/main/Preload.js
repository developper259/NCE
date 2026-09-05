const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  quit: () => ipcRenderer.invoke("App:quit"),
  approveQuit: () => ipcRenderer.invoke("App:approveQuit"),

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

  getAgentApiKey: (providerId) =>
    ipcRenderer.invoke("FileManager:getAgentApiKey", providerId),

  setAgentApiKey: (providerId, apiKey) =>
    ipcRenderer.invoke("FileManager:setAgentApiKey", providerId, apiKey),

  startWatching: (projectPath) =>
    ipcRenderer.invoke("Watcher:startWatching", projectPath),

  stopWatching: () => ipcRenderer.invoke("Watcher:stopWatching"),

  openContextMenu: (actions) => ipcRenderer.invoke("ContextMenu:show", actions),

  renameEntry: (oldPath, newPath) =>
    ipcRenderer.invoke("FileManager:rename", oldPath, newPath),

  deleteEntry: (targetPath) =>
    ipcRenderer.invoke("FileManager:delete", targetPath),

  createFile: (dirPath, fileName, content = "", overwrite = false) =>
    ipcRenderer.invoke(
      "FileManager:createFile",
      dirPath,
      fileName,
      content,
      overwrite,
    ),

  createFolder: (dirPath, folderName) =>
    ipcRenderer.invoke("FileManager:createFolder", dirPath, folderName),

  copyEntry: (sourcePath, destPath) =>
    ipcRenderer.invoke("FileManager:copy", sourcePath, destPath),

  moveEntry: (sourcePath, destPath) =>
    ipcRenderer.invoke("FileManager:move", sourcePath, destPath),

  duplicateEntry: (targetPath) =>
    ipcRenderer.invoke("FileManager:duplicate", targetPath),

  revealInExplorer: (targetPath) =>
    ipcRenderer.invoke("FileManager:revealInExplorer", targetPath),

  pathExists: (targetPath) =>
    ipcRenderer.invoke("FileManager:pathExists", targetPath),

  searchInFiles: (rootPath, query, options = {}) =>
    ipcRenderer.invoke("WorkspaceSearch:search", rootPath, query, options),

  getProjectMap: (rootPath, targetPath, options = {}) =>
    ipcRenderer.invoke(
      "WorkspaceSearch:projectMap",
      rootPath,
      targetPath,
      options,
    ),

  onSaveRequest: (callback) =>
    ipcRenderer.on("Request:saveState", () => callback()),

  onLoadState: (callback) =>
    ipcRenderer.on("Request:loadState", (_event, state) => callback(state)),

  onFileSystemChange: (callback) =>
    ipcRenderer.on("file-system-change", (_event, data) => callback(data)),

  onContextMenuTriggered: (callback) =>
    ipcRenderer.on("ContextMenu:triggered", (_event, actionName) =>
      callback(actionName),
    ),
});
