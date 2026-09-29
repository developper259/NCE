function buildEmptyMenuContextMenu(editor) {
  const runAction = (action) => {
    const keybinding = CONFIG_KEYBINDING_GET_ACTION(action);
    if (keybinding) editor.keyBinding?.exec(keybinding);
  };

  return {
    newFile: {
      name: "New File",
      callback: () => runAction("new_file"),
    },
    openFile: {
      name: "Open File...",
      callback: () => runAction("open_file"),
    },
    openFolder: {
      name: "Open Folder...",
      callback: () => runAction("open_folder"),
    },
  };
}
