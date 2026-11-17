function sidebarSettingsMenuShortcut(action) {
  const key = CONFIG_KEYBINDING_GET_ACTION(action)?.key;
  return key
    ? String(key).replace(/(^|\+)Mod(?=\+|$)/gi, "$1CommandOrControl")
    : null;
}

function buildSidebarSettingsContextMenu(editor) {
  return {
    openSettingsUI: {
      name: "Open Settings UI",
      keys: () => sidebarSettingsMenuShortcut("open_settings"),
      callback: () => editor.openSettings(),
    },
    openSettingsJSON: {
      name: "Open Settings JSON",
      callback: () => editor.openSettingsJson?.(),
    },
    openVersionManager: {
      name: "Open Version Manager",
      callback: () => editor.openVersionManager?.(),
    },
  };
}