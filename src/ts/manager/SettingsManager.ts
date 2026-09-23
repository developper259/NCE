import fs from "node:fs/promises";
import path from "node:path";

export interface Settings {
  editor: { tabWidth: number };
  files: { autoSave: boolean };
  appearance: { theme: ThemePreference };
  agent: { hiddenModels: string[] };
  keybindings: Record<string, string | null>;
}

export type ThemePreference = "system" | "dark" | "light";

export const DEFAULT_KEYBINDINGS: Readonly<Record<string, string | null>> =
  Object.freeze({
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
    quit_app: "Mod+Q",
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

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  editor: Object.freeze({ tabWidth: 2 }),
  files: Object.freeze({ autoSave: false }),
  appearance: Object.freeze({ theme: "system" as ThemePreference }),
  agent: { hiddenModels: [] as string[] },
  keybindings: DEFAULT_KEYBINDINGS,
});

const KNOWN_KEYS = new Set([
  "editor.tabWidth",
  "files.autoSave",
  "appearance.theme",
  "agent.hiddenModels",
  ...Object.keys(DEFAULT_KEYBINDINGS).map((action) => `keybindings.${action}`),
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeKeybinding(
  key: string | null | undefined,
  platform: string = process.platform,
): string {
  if (!key || !String(key).trim()) return "";
  const primaryModifier = platform === "darwin" ? "meta" : "ctrl";
  const parts = String(key)
    .split("+")
    .map((part) => {
      const value = part.trim().toLowerCase();
      if (value === "mod") return primaryModifier;
      if (value === "cmd" || value === "command") return "meta";
      if (value === "control") return "ctrl";
      if (value === "option") return "alt";
      return value;
    });

  if (parts.length > 1) {
    const lastKey = parts.pop()!;
    parts.sort();
    parts.push(lastKey);
  }

  return parts.join("+");
}

export class SettingsManager {
  readonly settingsPath: string;
  private settings: any = clone(DEFAULT_SETTINGS);
  private writeQueue: Promise<boolean> = Promise.resolve(true);

  constructor(userDataPath: string) {
    this.settingsPath = path.join(userDataPath, "settings.json");
  }

  async initialize(): Promise<Settings> {
    let source: Record<string, unknown> = {};
    let missing = false;
    try {
      const content = await fs.readFile(this.settingsPath, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!isObject(parsed))
        throw new Error("settings.json must contain an object");
      source = parsed;
    } catch (error: any) {
      missing = error?.code === "ENOENT";
      if (!missing)
        console.warn(
          "[Settings] Invalid settings.json; restoring defaults",
          error,
        );
    }

    if (missing) {
      const legacyAutoSave = await this.readLegacyAutoSave();
      if (legacyAutoSave !== undefined) {
        source = { files: { autoSave: legacyAutoSave } };
      }
    }

    this.settings = this.validateAndMerge(source);
    await this.save();
    return this.getAll();
  }

  get(key: string): unknown {
    if (!KNOWN_KEYS.has(key)) return undefined;
    const [section, property] = key.split(".");
    return (this.settings as any)[section][property];
  }

  getAll(): Settings {
    return {
      editor: { tabWidth: this.settings.editor.tabWidth },
      files: { autoSave: this.settings.files.autoSave },
      appearance: { theme: this.settings.appearance.theme },
      agent: { hiddenModels: [...this.settings.agent.hiddenModels] },
      keybindings: Object.fromEntries(
        Object.keys(DEFAULT_KEYBINDINGS).map((action) => [
          action,
          this.settings.keybindings[action],
        ]),
      ),
    };
  }

  validateKeybindingAssignment(
    action: string,
    shortcut: string | null | undefined,
  ): {
    valid: boolean;
    conflictAction?: string;
    conflictShortcut?: string;
  } {
    if (
      shortcut === null ||
      shortcut === undefined ||
      String(shortcut).trim() === ""
    ) {
      return { valid: true };
    }

    const normalized = normalizeKeybinding(shortcut);
    if (!normalized) return { valid: true };

    for (const [otherAction, otherShortcut] of Object.entries(
      this.settings.keybindings || {},
    )) {
      if (otherAction === action) continue;
      if (!otherShortcut || !String(otherShortcut).trim()) continue;

      const otherNormalized = normalizeKeybinding(otherShortcut as string);
      if (normalized === otherNormalized) {
        return {
          valid: false,
          conflictAction: otherAction,
          conflictShortcut: otherShortcut as string,
        };
      }
    }

    return { valid: true };
  }

  set(key: string, value: unknown): Promise<boolean> {
    if (!this.isValid(key, value)) return Promise.resolve(false);
    this.writeQueue = this.writeQueue
      .catch(() => false)
      .then(async () => {
        const [section, property] = key.split(".");
        if (section === "keybindings") {
          const validation = this.validateKeybindingAssignment(
            property,
            value as string | null,
          );
          if (!validation.valid) return false;
        }

        const nextSettings = clone(this.settings);
        (nextSettings as any)[section][property] =
          key === "agent.hiddenModels"
            ? [...new Set(value as string[])]
            : value;
        const saved = await this.writeSnapshot(nextSettings);
        if (saved) this.settings = nextSettings;
        return saved;
      });
    return this.writeQueue;
  }

  save(): Promise<boolean> {
    this.writeQueue = this.writeQueue
      .catch(() => false)
      .then(() => this.writeSnapshot(clone(this.settings)));
    return this.writeQueue;
  }

  private validateAndMerge(
    source: Record<string, unknown>,
  ): Settings & Record<string, unknown> {
    const merged: any = clone(source);
    if (!isObject(merged.editor)) merged.editor = {};
    if (!isObject(merged.files)) merged.files = {};
    if (!isObject(merged.appearance)) merged.appearance = {};
    if (!isObject(merged.agent)) merged.agent = {};
    if (!isObject(merged.keybindings)) merged.keybindings = {};
    merged.editor.tabWidth = this.isValid(
      "editor.tabWidth",
      merged.editor.tabWidth,
    )
      ? merged.editor.tabWidth
      : DEFAULT_SETTINGS.editor.tabWidth;
    merged.files.autoSave = this.isValid(
      "files.autoSave",
      merged.files.autoSave,
    )
      ? merged.files.autoSave
      : DEFAULT_SETTINGS.files.autoSave;
    merged.appearance.theme = this.isValid(
      "appearance.theme",
      merged.appearance.theme,
    )
      ? merged.appearance.theme
      : DEFAULT_SETTINGS.appearance.theme;
    merged.agent.hiddenModels = this.isValid(
      "agent.hiddenModels",
      merged.agent.hiddenModels,
    )
      ? [...new Set(merged.agent.hiddenModels.filter((value: unknown) =>
          typeof value === "string" && value.trim().length > 0 && value.length <= 512,
        ))]
      : [];

    const seenShortcuts = new Map<string, string>();
    for (const [action, shortcut] of Object.entries(DEFAULT_KEYBINDINGS)) {
      const key = `keybindings.${action}`;
      const candidate = merged.keybindings[action];
      if (candidate === null) {
        merged.keybindings[action] = null;
      } else if (this.isValid(key, candidate)) {
        const normalized = normalizeKeybinding(candidate);
        if (seenShortcuts.has(normalized)) {
          const defaultNorm = shortcut ? normalizeKeybinding(shortcut) : "";
          if (shortcut && !seenShortcuts.has(defaultNorm)) {
            merged.keybindings[action] = shortcut;
            seenShortcuts.set(defaultNorm, action);
          } else {
            merged.keybindings[action] = null;
          }
        } else {
          merged.keybindings[action] = candidate;
          if (normalized) seenShortcuts.set(normalized, action);
        }
      } else {
        const defaultNorm = shortcut ? normalizeKeybinding(shortcut) : "";
        if (shortcut && !seenShortcuts.has(defaultNorm)) {
          merged.keybindings[action] = shortcut;
          if (defaultNorm) seenShortcuts.set(defaultNorm, action);
        } else {
          merged.keybindings[action] = null;
        }
      }
    }
    return merged;
  }

  private isValid(key: string, value: unknown): boolean {
    if (key === "editor.tabWidth") {
      return (
        Number.isInteger(value) &&
        (value as number) >= 1 &&
        (value as number) <= 16
      );
    }
    if (key === "files.autoSave") return typeof value === "boolean";
    if (key === "appearance.theme") {
      return value === "system" || value === "dark" || value === "light";
    }
    if (key === "agent.hiddenModels") {
      return (
        Array.isArray(value) &&
        value.every(
          (entry) =>
            typeof entry === "string" &&
            entry.trim().length > 0 &&
            entry.length <= 512,
        )
      );
    }
    if (key.startsWith("keybindings.") && KNOWN_KEYS.has(key)) {
      if (value === null) return true;
      return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 128
      );
    }
    return false;
  }

  private async readLegacyAutoSave(): Promise<boolean | undefined> {
    try {
      const legacy = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(this.settingsPath), "state.json"),
          "utf8",
        ),
      );
      return typeof legacy?.preferences?.autoSave === "boolean"
        ? legacy.preferences.autoSave
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeSnapshot(
    snapshot: Record<string, unknown>,
  ): Promise<boolean> {
    const temporaryPath = `${this.settingsPath}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
      const handle = await fs.open(temporaryPath, "w");
      try {
        await handle.writeFile(
          `${JSON.stringify(snapshot, null, 2)}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, this.settingsPath);
      try {
        const directory = await fs.open(path.dirname(this.settingsPath), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {}
      return true;
    } catch (error) {
      console.error("[Settings] Failed to save settings.json", error);
      try {
        await fs.unlink(temporaryPath);
      } catch {}
      return false;
    }
  }
}
