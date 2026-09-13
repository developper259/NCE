import { normalizeKeybinding } from "../manager/SettingsManager";

const ELECTRON_MODIFIERS: Readonly<Record<string, string>> = Object.freeze({
  commandorcontrol: "CommandOrControl",
  meta: "Command",
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
  super: "Super",
});

const MODIFIER_ORDER = [
  "commandorcontrol",
  "meta",
  "ctrl",
  "alt",
  "shift",
  "super",
];

const ELECTRON_KEYS: Readonly<Record<string, string>> = Object.freeze({
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  backspace: "Backspace",
  delete: "Delete",
  end: "End",
  enter: "Enter",
  escape: "Escape",
  home: "Home",
  insert: "Insert",
  pagedown: "PageDown",
  pageup: "PageUp",
  capslock: "Capslock",
  numlock: "Numlock",
  scrolllock: "Scrolllock",
  printscreen: "PrintScreen",
  space: "Space",
  tab: "Tab",
});

const ELECTRON_PUNCTUATION = new Set(
  ")!@#$%^&*(:;+=<,_->.?/~`{][|\\}\"".split(""),
);
const MACOS_DEAD_KEYS = new Set(["^", "¨", "´", "`", "~"]);

function formatElectronKey(key: string): string | undefined {
  if (ELECTRON_KEYS[key]) return ELECTRON_KEYS[key];
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(key)) return key.toUpperCase();
  if (/^[a-z0-9]$/.test(key) || ELECTRON_PUNCTUATION.has(key)) {
    return key.toUpperCase();
  }
  return undefined;
}

export function toElectronAccelerator(
  shortcut: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!shortcut || !String(shortcut).trim()) return undefined;

  const electronShortcut = String(shortcut)
    .split("+")
    .map((part) =>
      part.trim().toLowerCase() === "mod" ? "CommandOrControl" : part,
    )
    .join("+");
  const normalized = normalizeKeybinding(electronShortcut);
  const parts = normalized.split("+");
  const key = parts.pop();
  if (!key) return undefined;
  if (parts.some((part) => !ELECTRON_MODIFIERS[part])) return undefined;
  if (platform === "darwin" && MACOS_DEAD_KEYS.has(key)) return undefined;

  const electronKey = formatElectronKey(key);
  if (!electronKey) return undefined;

  const modifiers = MODIFIER_ORDER.filter((modifier) =>
    parts.includes(modifier),
  ).map((modifier) => ELECTRON_MODIFIERS[modifier]);

  return [...modifiers, electronKey].join("+");
}
