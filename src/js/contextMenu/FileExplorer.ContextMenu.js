function buildFileContextMenu(explorer) {
  return {
    open: {
      name: "Open",
      keys: "Enter",
      callback: (file) => explorer.openFile(file.path),
    },
    sep1: { type: "separator" },
    cut: {
      name: "Cut",
      keys: "Ctrl+X",
      callback: (file) => explorer.setClipboard(file, "cut"),
    },
    copy: {
      name: "Copy",
      keys: "Ctrl+C",
      callback: (file) => explorer.setClipboard(file, "copy"),
    },
    sep2: { type: "separator" },
    copyPath: {
      name: "Copy Path",
      callback: (file) =>
        explorer.fileOperations.copyPathToClipboard(
          file.path,
          explorer.rootPath,
          false,
        ),
    },
    copyRelativePath: {
      name: "Copy Relative Path",
      callback: (file) =>
        explorer.fileOperations.copyPathToClipboard(
          file.path,
          explorer.rootPath,
          true,
        ),
    },
    reveal: {
      name: "Reveal in File Explorer",
      callback: (file) => explorer.fileOperations.revealInExplorer(file.path),
    },
    sep3: { type: "separator" },
    duplicate: {
      name: "Duplicate",
      callback: (file) => explorer.duplicateEntry(file),
    },
    rename: {
      name: "Rename...",
      keys: "F2",
      callback: (file) => explorer.startRename(file),
    },
    delete: {
      name: "Delete",
      keys: "Delete",
      callback: (file) => explorer.deleteEntry(file),
    },
  };
}

function buildFolderContextMenu(explorer) {
  return {
    newFile: {
      name: "New File...",
      callback: (folder) => explorer.startCreateEntry(folder.path, "file"),
    },
    newFolder: {
      name: "New Folder...",
      callback: (folder) => explorer.startCreateEntry(folder.path, "folder"),
    },
    sep1: { type: "separator" },
    cut: {
      name: "Cut",
      keys: "Ctrl+X",
      callback: (folder) => explorer.setClipboard(folder, "cut"),
    },
    copy: {
      name: "Copy",
      keys: "Ctrl+C",
      callback: (folder) => explorer.setClipboard(folder, "copy"),
    },
    paste: {
      name: "Paste",
      keys: "Ctrl+V",
      callback: (folder) => explorer.pasteEntry(folder.path),
    },
    sep2: { type: "separator" },
    copyPath: {
      name: "Copy Path",
      callback: (folder) =>
        explorer.fileOperations.copyPathToClipboard(
          folder.path,
          explorer.rootPath,
          false,
        ),
    },
    copyRelativePath: {
      name: "Copy Relative Path",
      callback: (folder) =>
        explorer.fileOperations.copyPathToClipboard(
          folder.path,
          explorer.rootPath,
          true,
        ),
    },
    reveal: {
      name: "Reveal in File Explorer",
      callback: (folder) =>
        explorer.fileOperations.revealInExplorer(folder.path),
    },
    sep3: { type: "separator" },
    duplicate: {
      name: "Duplicate",
      callback: (folder) => explorer.duplicateEntry(folder),
    },
    rename: {
      name: "Rename...",
      keys: "F2",
      callback: (folder) => explorer.startRename(folder),
    },
    delete: {
      name: "Delete",
      keys: "Delete",
      callback: (folder) => explorer.deleteEntry(folder),
    },
  };
}

function buildBackgroundContextMenu(explorer) {
  return {
    newFile: {
      name: "New File...",
      callback: () => explorer.startCreateEntry(explorer.rootPath, "file"),
    },
    newFolder: {
      name: "New Folder...",
      callback: () => explorer.startCreateEntry(explorer.rootPath, "folder"),
    },
    sep1: { type: "separator" },
    paste: {
      name: "Paste",
      keys: "Ctrl+V",
      callback: () => explorer.pasteEntry(explorer.rootPath),
    },
    sep2: { type: "separator" },
    reveal: {
      name: "Reveal in File Explorer",
      callback: () =>
        explorer.fileOperations.revealInExplorer(explorer.rootPath),
    },
  };
}

function buildProjectContextMenu(explorer) {
  return {
    closeProject: {
      name: "Close Project",
      callback: () => explorer.closeProject(),
    },
    sep1: { type: "separator" },
    newFile: {
      name: "New File...",
      callback: () => explorer.startCreateEntry(explorer.rootPath, "file"),
    },
    newFolder: {
      name: "New Folder...",
      callback: () => explorer.startCreateEntry(explorer.rootPath, "folder"),
    },
    sep2: { type: "separator" },
    paste: {
      name: "Paste",
      keys: "Ctrl+V",
      callback: () => explorer.pasteEntry(explorer.rootPath),
    },
    sep3: { type: "separator" },
    copyPath: {
      name: "Copy Path",
      callback: () =>
        explorer.fileOperations.copyPathToClipboard(
          explorer.rootPath,
          explorer.rootPath,
          false,
        ),
    },
    reveal: {
      name: "Reveal in File Explorer",
      callback: () =>
        explorer.fileOperations.revealInExplorer(explorer.rootPath),
    },
  };
}
