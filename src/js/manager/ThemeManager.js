const THEME_PREFERENCES = Object.freeze(["system", "dark", "light"]);

const THEME_DEFINITIONS = Object.freeze({
  dark: Object.freeze({ id: "dark", syntaxTheme: "dark" }),
  light: Object.freeze({ id: "light", syntaxTheme: "light" }),
});

class ThemeManager {
  constructor(editor) {
    this.editor = editor;
    this.preference = "system";
    this.resolvedTheme = "dark";
    this.mediaQuery = null;
    this.initialized = false;
    this.destroyed = false;
    this.handleSystemThemeChange = this.handleSystemThemeChange.bind(this);
  }

  init() {
    if (this.initialized) return this;
    this.initialized = true;
    this.destroyed = false;
    this.preference = this.normalizePreference(SETTINGS_GET("appearance.theme"));
    this.applyTheme(this.resolveTheme());
    this.installSystemListener();
    return this;
  }

  getPreference() {
    return this.preference;
  }

  getResolvedTheme() {
    return this.resolvedTheme;
  }

  openThemePicker() {
    const quickPanel = this.editor?.quickPanel;
    if (!quickPanel) return false;
    if (quickPanel.isOpen("theme-picker")) {
      quickPanel.input?.focus();
      return true;
    }

    const items = [
      { id: "system", label: "System", keywords: ["automatic", "os"] },
      { id: "dark", label: "Dark", keywords: ["night"] },
      { id: "light", label: "Light", keywords: ["day"] },
    ];
    quickPanel.open({
      id: "theme-picker",
      mode: "pick",
      title: "Color Theme",
      placeholder: "Select a theme...",
      items,
      selectedId: this.preference,
      onSelectionChange: (item) => this.setTheme(item?.id),
      onAccept: (item) => this.setTheme(item.id),
    });
    return true;
  }

  resolveTheme(preference = this.getPreference()) {
    if (preference !== "system") return preference === "light" ? "light" : "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
      ? "dark"
      : window.matchMedia
        ? "light"
        : "dark";
  }

  applyTheme(theme) {
    const definition = THEME_DEFINITIONS[theme] || THEME_DEFINITIONS.dark;
    this.resolvedTheme = definition.id;
    document.documentElement.dataset.theme = definition.id;
    window.api?.setNativeThemeSource?.(this.preference, definition.id);
    const editorElement = this.editor?.editorOBJ;
    if (editorElement?.classList) {
      editorElement.classList.remove("nsh-theme-dark", "nsh-theme-light");
      editorElement.classList.add(`nsh-theme-${definition.syntaxTheme}`);
    }
    return definition.id;
  }

  async setTheme(preference) {
    if (!this.isValidPreference(preference)) return false;
    const saved = await SETTINGS_SET("appearance.theme", preference);
    if (!saved) return false;
    this.preference = preference;
    this.applyTheme(this.resolveTheme(preference));
    return true;
  }

  syncFromSettings(preference) {
    this.preference = this.normalizePreference(preference);
    return this.applyTheme(this.resolveTheme());
  }

  handleSystemThemeChange() {
    if (this.preference === "system") this.applyTheme(this.resolveTheme());
  }

  destroy() {
    if (this.mediaQuery) {
      if (this.mediaQuery.removeEventListener) {
        this.mediaQuery.removeEventListener("change", this.handleSystemThemeChange);
      } else if (this.mediaQuery.removeListener) {
        this.mediaQuery.removeListener(this.handleSystemThemeChange);
      }
    }
    this.mediaQuery = null;
    this.initialized = false;
    this.destroyed = true;
  }

  isValidPreference(value) {
    return THEME_PREFERENCES.includes(value);
  }

  normalizePreference(value) {
    return this.isValidPreference(value) ? value : "system";
  }

  installSystemListener() {
    if (!window.matchMedia || this.mediaQuery) return;
    this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    if (this.mediaQuery.addEventListener) {
      this.mediaQuery.addEventListener("change", this.handleSystemThemeChange);
    } else if (this.mediaQuery.addListener) {
      this.mediaQuery.addListener(this.handleSystemThemeChange);
    }
  }
}
