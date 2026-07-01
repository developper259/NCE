const USERCONFIG_KEYBINDING = [
  {
    action: "save",
    description: "Sauvegarder le fichier actuel",
    key: "Meta+S",
    in_editor: false,
  },
  {
    action: "open_file",
    description: "Ouvrir un fichier",
    key: "Meta+O",
    in_editor: false,
  },
  {
    action: "open_folder",
    description: "Ouvrir un dossier",
    key: "Meta+Shift+O",
    in_editor: false,
  },
  {
    action: "find_file",
    description: "Rechercher un fichier",
    key: "Meta+Shift+f",
    in_editor: false,
  },
  {
    action: "new_file",
    description: "Créer un nouveau fichier",
    key: "Meta+N",
    in_editor: false,
  },
  {
    action: "close_file",
    description: "Fermer le fichier actuel",
    key: "Meta+W",
    in_editor: false,
  },
  {
    action: "close_all_file",
    description: "Fermer tout les fichiers",
    key: "Meta+Shift+W",
    in_editor: false,
  },
  {
    action: "copy",
    description: "Copier la sélection",
    key: "Meta+C",
    in_editor: true,
  },
  {
    action: "paste",
    description: "Coller le contenu",
    key: "Meta+V",
    in_editor: true,
  },
  {
    action: "cut",
    description: "Couper la sélection",
    key: "Meta+X",
    in_editor: true,
  },
  {
    action: "undo",
    description: "Annuler la dernière action",
    key: "Meta+Z",
    in_editor: true,
  },
  {
    action: "redo",
    description: "Rétablir la dernière action",
    key: "Meta+Y",
    in_editor: true,
  },
  {
    action: "find",
    description: "Rechercher dans le fichier",
    key: "Meta+F",
    in_editor: true,
  },
  {
    action: "replace",
    description: "Remplacer dans le fichier",
    key: "Meta+H",
    in_editor: true,
  },
  {
    action: "open_command",
    description: "Ouvrir le panel de commande",
    key: "Meta+Shift+Y",
    in_editor: false,
  },
  {
    action: "delete_line",
    description: "Supprimer la ligne actuelle",
    key: "Meta+Shift+K",
    in_editor: true,
  },
  {
    action: "select_all",
    description: "Sélectionner tout",
    key: "Meta+A",
    in_editor: true,
  },
  {
    action: "toggle_file_explorer",
    description: "Ouvrir/Fermer l'explorateur de fichiers",
    key: "Meta+B",
    in_editor: false,
  },
  {
    key: "Escape",
    action: "escape",
    in_editor: false,
  },
  {
    key: "Tab",
    action: "indent_right",
    in_editor: true,
  },
  {
    key: "Delete",
    action: "delete_right",
    in_editor: true,
  },
  {
    key: "Backspace",
    action: "delete_left",
    in_editor: true,
  },
  {
    key: "Enter",
    action: "newline",
    in_editor: true,
  },
  {
    key: "ArrowUp",
    action: "move_up",
    in_editor: false,
  },
  {
    key: "ArrowDown",
    action: "move_down",
    in_editor: false,
  },
  {
    key: "ArrowLeft",
    action: "move_left",
    in_editor: false,
  },
  {
    key: "ArrowRight",
    action: "move_right",
    in_editor: false,
  },
  {
    key: "Home",
    action: "move_to_line_start",
    in_editor: true,
  },
  {
    key: "End",
    action: "move_to_line_end",
    in_editor: true,
  },
  {
    key: "Insert",
    action: "toggle_insert_mode",
    in_editor: true,
  },
];

USERCONFIG_CONFIG = {
  tab_width: 4,
};

USERCONFIG_SIDEBAR_MENUS = [
  {
    id: "file-explorer",
    title: "File Explorer",
    icon: "fi fi-rr-folder",
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
    if (item.key.toLowerCase() == key.toLowerCase()) return item;
  }
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
