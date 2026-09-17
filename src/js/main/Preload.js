const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  agentFileOperation: (root, operation, args) =>
    ipcRenderer.invoke("Agent:fileOperation", root, operation, args),
  quit: () => ipcRenderer.invoke("App:quit"),
  appCommand: (command) => ipcRenderer.invoke("App:command", command),
  readClipboardText: () => ipcRenderer.invoke("Clipboard:readText"),
  setMenuShortcutsIgnored: (ignored) =>
    ipcRenderer.invoke("App:setIgnoreMenuShortcuts", ignored === true),
  setActiveFileContext: (hasActiveFile) =>
    ipcRenderer.invoke("App:setActiveFileContext", hasActiveFile === true),
  setAutoSaveState: (enabled) =>
    ipcRenderer.invoke("App:setAutoSaveState", enabled === true),
  getSettings: () => ipcRenderer.invoke("Settings:getAll"),
  getSetting: (key) => ipcRenderer.invoke("Settings:get", key),
  setSetting: (key, value) => ipcRenderer.invoke("Settings:set", key, value),
  getRecentFolders: () => ipcRenderer.invoke("RecentFolders:getAll"),
  addRecentFolder: (folderPath) =>
    ipcRenderer.invoke("RecentFolders:add", folderPath),
  removeRecentFolder: (folderPath) =>
    ipcRenderer.invoke("RecentFolders:remove", folderPath),
  clearRecentFolders: () => ipcRenderer.invoke("RecentFolders:clear"),
  onAutoSaveToggleRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("auto-save-toggle-requested", listener);
    return () =>
      ipcRenderer.removeListener("auto-save-toggle-requested", listener);
  },
  onOpenSettingsRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("open-settings-requested", listener);
    return () =>
      ipcRenderer.removeListener("open-settings-requested", listener);
  },
  onKeybindingActionRequested: (callback) => {
    const listener = (_event, action, modifiers) =>
      callback(action, modifiers || {});
    ipcRenderer.on("keybinding-action-requested", listener);
    return () =>
      ipcRenderer.removeListener("keybinding-action-requested", listener);
  },
  onOpenRecentFolderRequested: (callback) => {
    const listener = (_event, folderPath) => callback(folderPath);
    ipcRenderer.on("open-recent-folder-requested", listener);
    return () =>
      ipcRenderer.removeListener("open-recent-folder-requested", listener);
  },
  onRecentFoldersChanged: (callback) => {
    const listener = (_event, folders) => callback(folders);
    ipcRenderer.on("recent-folders-changed", listener);
    return () => ipcRenderer.removeListener("recent-folders-changed", listener);
  },
  approveQuit: () => ipcRenderer.invoke("App:approveQuit"),
  cancelQuit: () => ipcRenderer.invoke("App:cancelQuit"),
  rendererReady: () => ipcRenderer.invoke("App:rendererReady"),
  getNshEndpoint: () => ipcRenderer.invoke("NSH:getEndpoint"),
  runAgentProcess: (request) => ipcRenderer.invoke("Agent:runProcess", request),
  cancelAgentProcess: (requestId) =>
    ipcRenderer.invoke("Agent:cancelProcess", requestId),
  resolveAgentRuntime: (request) =>
    ipcRenderer.invoke("Agent:resolveRuntime", request),
  respondAgentApproval: (payload) =>
    ipcRenderer.invoke("Agent:respondApproval", payload),
  cancelAgentApproval: (approvalId) =>
    ipcRenderer.invoke("Agent:cancelApproval", approvalId),
  onAgentApprovalRequested: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("Agent:approvalRequested", listener);
    return () =>
      ipcRenderer.removeListener("Agent:approvalRequested", listener);
  },

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

  deleteEntry: (targetPath, force = false) =>
    ipcRenderer.invoke(
      "FileManager:delete",
      targetPath,
      typeof force === "boolean" ? force : false,
    ),

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

  pathStatus: (targetPath) =>
    ipcRenderer.invoke("FileManager:pathStatus", targetPath),

  searchInFiles: (rootPath, query, options = {}) =>
    ipcRenderer.invoke("WorkspaceSearch:search", rootPath, query, options),

  getProjectMap: (rootPath, targetPath, options = {}) =>
    ipcRenderer.invoke(
      "WorkspaceSearch:projectMap",
      rootPath,
      targetPath,
      options,
    ),

  listProjectFiles: (rootPath) =>
    ipcRenderer.invoke("WorkspaceSearch:projectFiles", rootPath),

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
