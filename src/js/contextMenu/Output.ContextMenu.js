function buildOutputContextMenu(editor) {
  const isFileContext = (context) => context?.isFile === true;
  const hasSelection = (context) =>
    isFileContext(context) && Boolean(context.selectedText);
  const execute = (action) => editor.keyBinding?.exec({ action });
  const shortcut = (action) => {
    const key = CONFIG_KEYBINDING_GET_ACTION(action)?.key;
    return key
      ? String(key).replace(/(^|\+)Mod(?=\+|$)/gi, "$1CommandOrControl")
      : null;
  };
  const copyPath = (context, relative) =>
    editor.fileExplorer.fileOperations.copyPathToClipboard(
      context.filePath,
      context.rootPath,
      relative,
    );

  return {
    undo: {
      name: "Undo",
      keys: () => shortcut("undo"),
      enabled: (context) =>
        isFileContext(context) &&
        editor.historyController?.canUndo(context.file) === true,
      callback: () => execute("undo"),
    },
    redo: {
      name: "Redo",
      keys: () => shortcut("redo"),
      enabled: (context) =>
        isFileContext(context) &&
        editor.historyController?.canRedo(context.file) === true,
      callback: () => execute("redo"),
    },
    sep1: { type: "separator" },
    cut: {
      name: "Cut",
      keys: () => shortcut("cut"),
      enabled: hasSelection,
      callback: () => execute("cut"),
    },
    copy: {
      name: "Copy",
      keys: () => shortcut("copy"),
      enabled: hasSelection,
      callback: () => execute("copy"),
    },
    paste: {
      name: "Paste",
      keys: () => shortcut("paste"),
      enabled: isFileContext,
      callback: () => execute("paste"),
    },
    sep2: { type: "separator" },
    selectAll: {
      name: "Select All",
      keys: () => shortcut("select_all"),
      enabled: isFileContext,
      callback: () => execute("select_all"),
    },
    sep3: { type: "separator" },
    find: {
      name: "Find",
      keys: () => shortcut("find"),
      enabled: isFileContext,
      callback: () => execute("find"),
    },
    goToLine: {
      name: "Go to Line",
      keys: () => shortcut("go_to_line"),
      enabled: isFileContext,
      callback: () => execute("go_to_line"),
    },
    openCommandPalette: {
      name: "Open Command Palette",
      keys: () => shortcut("open_command"),
      enabled: isFileContext,
      callback: () => execute("open_command"),
    },
    searchSelection: {
      name: "Search Selection in Workspace",
      enabled: (context) =>
        hasSelection(context) &&
        Boolean(context.selectedText.trim()) &&
        Boolean(context.rootPath),
      callback: (context) => {
        editor.searchSidebar.query = context.selectedText;
        editor.sidebarManager.openMenu("search");
        return editor.searchSidebar.runSearch();
      },
    },
    sep4: { type: "separator" },
    copyFilePath: {
      name: "Copy File Path",
      enabled: (context) => isFileContext(context) && Boolean(context.filePath),
      callback: (context) => copyPath(context, false),
    },
    copyRelativePath: {
      name: "Copy Relative Path",
      enabled: (context) =>
        isFileContext(context) &&
        Boolean(context.filePath) &&
        Boolean(context.rootPath) &&
        NCEPath.isInside(context.filePath, context.rootPath),
      callback: (context) => copyPath(context, true),
    },
    revealInFileExplorer: {
      name: "Reveal in File Explorer",
      enabled: (context) => isFileContext(context) && Boolean(context.filePath),
      callback: (context) =>
        editor.fileExplorer.fileOperations.revealInExplorer(context.filePath),
    },
  };
}
