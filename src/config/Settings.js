const DEFAULT_KEYBINDINGS = Object.freeze({
  save: "Mod+S",
  open_file: "Mod+O",
  quick_open: "Mod+P",
  go_to_line: "Mod+G",
  open_folder: "Mod+Shift+O",
  new_file: "Mod+N",
  close_file: "Mod+W",
  close_all_file: "Mod+Shift+W",
  copy: "Mod+C",
  paste: "Mod+V",
  cut: "Mod+X",
  undo: "Mod+Z",
  redo: "Mod+Y",
  find: "Mod+F",
  open_command: "Mod+Shift+P",
  delete_line: "Mod+Shift+K",
  select_all: "Mod+A",
  toggle_file_explorer: "Mod+B",
  toggle_search: "Mod+Shift+F",
  toggle_agent: "Mod+L",
  open_settings: "Mod+,",
  reload_window: "Mod+R",
  escape: "Escape",
  indent_right: "Tab",
  delete_right: "Delete",
  delete_left: "Backspace",
  newline: "Enter",
  move_up: "ArrowUp",
  move_down: "ArrowDown",
  move_left: "ArrowLeft",
  move_right: "ArrowRight",
  move_to_line_start: "Home",
  move_to_line_end: "End",
  toggle_insert_mode: "Insert",
});

const DEFAULT_RENDERER_SETTINGS = Object.freeze({
  editor: Object.freeze({ tabWidth: 2 }),
  files: Object.freeze({ autoSave: false }),
  keybindings: DEFAULT_KEYBINDINGS,
});

let RENDERER_SETTINGS = {
  editor: { ...DEFAULT_RENDERER_SETTINGS.editor },
  files: { ...DEFAULT_RENDERER_SETTINGS.files },
  keybindings: { ...DEFAULT_RENDERER_SETTINGS.keybindings },
};

function SETTINGS_INITIALIZE(settings) {
  RENDERER_SETTINGS = {
    editor: {
      tabWidth:
        Number.isInteger(settings?.editor?.tabWidth) &&
        settings.editor.tabWidth >= 1 &&
        settings.editor.tabWidth <= 16
          ? settings.editor.tabWidth
          : DEFAULT_RENDERER_SETTINGS.editor.tabWidth,
    },
    files: {
      autoSave:
        typeof settings?.files?.autoSave === "boolean"
          ? settings.files.autoSave
          : DEFAULT_RENDERER_SETTINGS.files.autoSave,
    },
    keybindings: Object.fromEntries(
      Object.entries(DEFAULT_KEYBINDINGS).map(([action, shortcut]) => [
        action,
        settings?.keybindings?.[action] === null
          ? null
          : typeof settings?.keybindings?.[action] === "string" &&
              settings.keybindings[action].trim() &&
              settings.keybindings[action].length <= 128
            ? settings.keybindings[action]
            : shortcut,
      ]),
    ),
  };

  if (typeof USERCONFIG_KEYBINDING !== "undefined") {
    for (const binding of USERCONFIG_KEYBINDING) {
      binding.key = RENDERER_SETTINGS.keybindings[binding.action];
    }
  }
}

function SETTINGS_GET(key) {
  const [section, property] = String(key).split(".");
  return RENDERER_SETTINGS[section]?.[property];
}

async function SETTINGS_SET(key, value) {
  const [section, property] = String(key).split(".");
  const previous = RENDERER_SETTINGS[section]?.[property];
  if (
    !(section in RENDERER_SETTINGS) ||
    !(property in RENDERER_SETTINGS[section])
  ) {
    return false;
  }
  RENDERER_SETTINGS[section][property] = value;
  const saved = await window.api.setSetting(key, value);
  if (!saved) RENDERER_SETTINGS[section][property] = previous;
  if (
    saved &&
    section === "keybindings" &&
    typeof USERCONFIG_KEYBINDING !== "undefined"
  ) {
    const binding = USERCONFIG_KEYBINDING.find(
      (item) => item.action === property,
    );
    if (binding) binding.key = value;
  }
  return saved;
}
