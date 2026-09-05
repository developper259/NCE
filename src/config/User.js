const USERCONFIG_KEYBINDING = [
  {
    action: "save",
    description: "Save the current file",
    key: "Mod+S",
    in_editor: false,
  },
  {
    action: "open_file",
    description: "Open a file",
    key: "Mod+O",
    in_editor: false,
  },
  {
    action: "open_folder",
    description: "Open a folder",
    key: "Mod+Shift+O",
    in_editor: false,
  },
  {
    action: "new_file",
    description: "Create a new file",
    key: "Mod+N",
    in_editor: false,
  },
  {
    action: "close_file",
    description: "Close the current file",
    key: "Mod+W",
    in_editor: false,
  },
  {
    action: "close_all_file",
    description: "Close all files",
    key: "Mod+Shift+W",
    in_editor: false,
  },
  {
    action: "copy",
    description: "Copy the selection",
    key: "Mod+C",
    in_editor: true,
  },
  {
    action: "paste",
    description: "Paste content",
    key: "Mod+V",
    in_editor: true,
  },
  {
    action: "cut",
    description: "Cut the selection",
    key: "Mod+X",
    in_editor: true,
  },
  {
    action: "undo",
    description: "Undo the last action",
    key: "Mod+Z",
    in_editor: true,
  },
  {
    action: "redo",
    description: "Redo the last action",
    key: "Mod+Y",
    in_editor: true,
  },
  {
    action: "find",
    description: "Find in the current file",
    key: "Mod+F",
    in_editor: false,
  },
  {
    action: "replace",
    description: "Replace in the current file",
    key: "Mod+H",
    in_editor: true,
  },
  {
    action: "open_command",
    description: "Open the command palette",
    key: "Mod+Shift+P",
    in_editor: false,
  },
  {
    action: "delete_line",
    description: "Delete the current line",
    key: "Mod+Shift+K",
    in_editor: true,
  },
  {
    action: "select_all",
    description: "Select all",
    key: "Mod+A",
    in_editor: true,
  },
  {
    action: "toggle_file_explorer",
    description: "Toggle File Explorer",
    key: "Mod+B",
    in_editor: false,
  },
  {
    action: "toggle_search",
    description: "Toggle advanced search",
    key: "Mod+Shift+F",
    in_editor: false,
  },
  {
    action: "toggle_agent",
    description: "Open Agent",
    key: "Mod+L",
    in_editor: false,
  },
  { key: "Escape", action: "escape", in_editor: false },
  { key: "Tab", action: "indent_right", in_editor: true },
  { key: "Delete", action: "delete_right", in_editor: true },
  { key: "Backspace", action: "delete_left", in_editor: true },
  { key: "Enter", action: "newline", in_editor: true },
  { key: "ArrowUp", action: "move_up", in_editor: false },
  { key: "ArrowDown", action: "move_down", in_editor: false },
  { key: "ArrowLeft", action: "move_left", in_editor: false },
  { key: "ArrowRight", action: "move_right", in_editor: false },
  { key: "Home", action: "move_to_line_start", in_editor: true },
  { key: "End", action: "move_to_line_end", in_editor: true },
  { key: "Insert", action: "toggle_insert_mode", in_editor: true },
];

USERCONFIG_CONFIG = {
  tab_width: 2,
};

USERCONFIG_SIDEBAR_MENUS = [
  {
    id: "file-explorer",
    title: "File Explorer",
    icon: "fi fi-rr-folder",
    position: "left",
  },
  {
    id: "search",
    title: "Search",
    icon: "fi fi-rr-search",
    position: "left",
  },
];

USERCONFIG_FILE_ICONS = {
  js: "fi fi-brands-js",
  jsx: "fi fi-brands-react",
  ts: "fi fi-brands-js",
  tsx: "fi fi-brands-react",
  html: "fi fi-brands-html5",
  css: "fi fi-brands-css3",
  scss: "fi fi-brands-sass",
  sass: "fi fi-brands-sass",
  less: "fi fi-brands-less",
  json: "fi fi-rr-file-code",
  xml: "fi fi-rr-file-code",
  yaml: "fi fi-rr-file-code",
  yml: "fi fi-rr-file-code",
  md: "fi fi-brands-markdown",
  txt: "fi fi-rr-file-text",
  png: "fi fi-rr-image",
  svg: "fi fi-rr-image",
  jpg: "fi fi-rr-image",
  jpeg: "fi fi-rr-image",
  gif: "fi fi-rr-image",
  ico: "fi fi-rr-image",
  webp: "fi fi-rr-image",
  bmp: "fi fi-rr-image",
  tiff: "fi fi-rr-image",
  pdf: "fi fi-rr-file-pdf",
  doc: "fi fi-rr-file-word",
  docx: "fi fi-rr-file-word",
  xls: "fi fi-rr-file-excel",
  xlsx: "fi fi-rr-file-excel",
  ppt: "fi fi-rr-file-powerpoint",
  pptx: "fi fi-rr-file-powerpoint",
  zip: "fi fi-rr-file-zip",
  rar: "fi fi-rr-file-zip",
  tar: "fi fi-rr-file-zip",
  gz: "fi fi-rr-file-zip",
  "7z": "fi fi-rr-file-zip",
  mp3: "fi fi-rr-file-audio",
  mp4: "fi fi-rr-file-video",
  wav: "fi fi-rr-file-audio",
  ogg: "fi fi-rr-file-audio",
  mov: "fi fi-rr-file-video",
  avi: "fi fi-rr-file-video",
  mkv: "fi fi-rr-file-video",
  flv: "fi fi-rr-file-video",
  webm: "fi fi-rr-file-video",
  py: "fi fi-brands-python",
  rb: "fi fi-brands-ruby",
  php: "fi fi-brands-php",
  java: "fi fi-brands-java",
  go: "fi fi-brands-golang",
  rs: "fi fi-brands-rust",
  cpp: "fi fi-rr-file-code",
  c: "fi fi-rr-file-code",
  h: "fi fi-rr-file-code",
  hpp: "fi fi-rr-file-code",
  cs: "fi fi-brands-c-sharp",
  swift: "fi fi-brands-swift",
  kt: "fi fi-brands-kotlin",
  vue: "fi fi-brands-vue",
  svelte: "fi fi-brands-svelte",
  angular: "fi fi-brands-angular",
  dockerfile: "fi fi-brands-docker",
  docker: "fi fi-brands-docker",
  sh: "fi fi-rr-terminal",
  bash: "fi fi-rr-terminal",
  zsh: "fi fi-rr-terminal",
  ps1: "fi fi-rr-terminal",
  bat: "fi fi-rr-terminal",
  cmd: "fi fi-rr-terminal",
  sql: "fi fi-rr-database",
  db: "fi fi-rr-database",
  sqlite: "fi fi-rr-database",
  r: "fi fi-brands-r-project",
  m: "fi fi-brands-matlab",
  lua: "fi fi-brands-lua",
  scala: "fi fi-brands-scala",
  elixir: "fi fi-brands-elixir",
  erl: "fi fi-brands-elixir",
  hs: "fi fi-brands-haskell",
  clj: "fi fi-brands-clojure",
  fs: "fi fi-brands-f-sharp",
  dart: "fi fi-brands-dart",
  flutter: "fi fi-brands-flutter",
  groovy: "fi fi-brands-groovy",
  pl: "fi fi-brands-perl",
  pm: "fi fi-brands-perl",
  tcl: "fi fi-rr-file-code",
  vb: "fi fi-brands-vb",
  vbs: "fi fi-brands-vb",
  asm: "fi fi-rr-file-code",
  s: "fi fi-rr-file-code",
  makefile: "fi fi-rr-file-code",
  cmake: "fi fi-rr-file-code",
  gradle: "fi fi-brands-gradle",
  maven: "fi fi-brands-maven",
  npm: "fi fi-brands-npm",
  yarn: "fi fi-brands-yarn",
  pnpm: "fi fi-brands-pnpm",
  composer: "fi fi-brands-composer",
  pip: "fi fi-brands-python",
  gem: "fi fi-brands-ruby",
  cargo: "fi fi-brands-rust",
  go_mod: "fi fi-brands-golang",
  nuget: "fi fi-brands-nuget",
  cocoapods: "fi fi-brands-cocoapods",
  carthage: "fi fi-rr-file-code",
  swift_package: "fi fi-brands-swift",
  lock: "fi fi-rr-lock",
  env: "fi fi-rr-file-code",
  ini: "fi fi-rr-file-code",
  cfg: "fi fi-rr-file-code",
  conf: "fi fi-rr-file-code",
  toml: "fi fi-rr-file-code",
  properties: "fi fi-rr-file-code",
  gitignore: "fi fi-file",
  gitattributes: "fi fi-file",
  gitmodules: "fi fi-file",
  gitkeep: "fi fi-file",
  license: "fi fi-rr-file-text",
  readme: "fi fi-rr-file-text",
  changelog: "fi fi-rr-file-text",
  contributing: "fi fi-rr-file-text",
  authors: "fi fi-rr-file-text",
  history: "fi fi-rr-file-text",
  todo: "fi fi-rr-file-text",
  eot: "fi fi-rr-font",
  ttf: "fi fi-rr-font",
  otf: "fi fi-rr-font",
  woff: "fi fi-rr-font",
  woff2: "fi fi-rr-font",
  csv: "fi fi-rr-file-excel",
  rtf: "fi fi-rr-file-word",
  odt: "fi fi-rr-file-word",
  ods: "fi fi-rr-file-excel",
  odp: "fi fi-rr-file-powerpoint",
  key: "fi fi-rr-key",
  pem: "fi fi-rr-key",
  crt: "fi fi-rr-key",
  cer: "fi fi-rr-key",
  p12: "fi fi-rr-key",
  pfx: "fi fi-rr-key",
  default: "fi fi-rr-file",
};

function CONFIG_KEYBINDING_CONTAINSKEY(key) {
  if (CONFIG_KEYBINDING_GET_KEY(key)) return true;
  return false;
}

function CONFIG_KEYBINDING_CONTAINSACTIN(action) {
  if (CONFIG_KEYBINDING_GET_ACTION(action)) return true;
  return false;
}

function CONFIG_KEYBINDING_GET_KEY(key) {
  for (item of USERCONFIG_KEYBINDING) {
    if (
      CONFIG_KEYBINDING_NORMALIZE(item.key) == CONFIG_KEYBINDING_NORMALIZE(key)
    )
      return item;
  }
}

function CONFIG_KEYBINDING_PRIMARY_MODIFIER() {
  return window.api?.platform === "darwin" ? "Meta" : "Ctrl";
}

function CONFIG_KEYBINDING_NORMALIZE(key) {
  return String(key || "")
    .split("+")
    .map((part) => {
      const value = part.trim();
      return value.toLowerCase() === "mod"
        ? CONFIG_KEYBINDING_PRIMARY_MODIFIER().toLowerCase()
        : value.toLowerCase();
    })
    .join("+");
}

function CONFIG_KEYBINDING_DISPLAY(key) {
  return String(key || "").replace(
    /(^|\+)Mod(?=\+|$)/gi,
    CONFIG_KEYBINDING_PRIMARY_MODIFIER(),
  );
}

function CONFIG_KEYBINDING_GET_ACTION(action) {
  for (item of USERCONFIG_KEYBINDING) {
    if (item.action.toLowerCase() == action.toLowerCase()) return item;
  }
}

function CONFIG_GET(key) {
  return USERCONFIG_CONFIG[key];
}

function CONFIG_SET(key, val) {
  USERCONFIG_CONFIG[key] = val;
}
