const SETTINGS_UI = Object.freeze([
  {
    key: "editor.tabWidth",
    category: "Editor",
    label: "Tab Width",
    description: "Number of spaces used for indentation.",
    keywords: ["tab", "indent", "spaces"],
    control: "select",
    options: [2, 4, 8],
  },
  {
    key: "files.autoSave",
    category: "Files",
    label: "Auto Save",
    description: "Automatically save modified files.",
    keywords: ["auto", "save", "files"],
    control: "checkbox",
  },
]);

class SettingsView {
  constructor(editor) {
    this.editor = editor;
    this.host = editor.domManager.getElement(".settings-view-host");
    this.category = SETTINGS_UI[0].category;
    this.query = "";
    this.build();
  }

  build() {
    if (!this.host) return;
    this.host.innerHTML = `
      <div class="settings-search-wrap">
        <i class="fi fi-rr-search" aria-hidden="true"></i>
        <input class="settings-search" type="search" placeholder="Search settings..."
          aria-label="Search settings" autocomplete="off" spellcheck="false">
      </div>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings categories"></nav>
        <main class="settings-content"></main>
      </div>`;
    this.search = this.host.querySelector(".settings-search");
    this.nav = this.host.querySelector(".settings-nav");
    this.content = this.host.querySelector(".settings-content");
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.renderNavigation();
    this.render();
  }

  getSettings() {
    const shortcuts =
      typeof USERCONFIG_KEYBINDING === "undefined"
        ? []
        : USERCONFIG_KEYBINDING.filter((binding) => binding.description)
          .map((binding) => ({
            key: `keybindings.${binding.action}`,
            category: "Shortcuts",
            label: binding.description,
            description: `Keyboard shortcut for ${binding.action.replace(/_/g, " ")}.`,
            keywords: [binding.action, "shortcut", "keybinding"],
            control: "shortcut",
          }));
    return [...SETTINGS_UI, ...shortcuts];
  }

  renderNavigation() {
    const categories = [
      ...new Set(this.getSettings().map((setting) => setting.category)),
    ];
    this.nav.replaceChildren(
      ...categories.map((category) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-nav-item";
        button.textContent = category;
        button.dataset.category = category;
        button.addEventListener("click", () => {
          this.category = category;
          this.renderNavigation();
          this.render();
        });
        if (category === this.category) button.classList.add("active");
        return button;
      }),
    );
  }

  getVisibleSettings() {
    const settings = this.getSettings();
    if (!this.query)
      return settings.filter((item) => item.category === this.category);
    return settings.filter((item) =>
      [item.label, item.description, item.category, ...(item.keywords || [])]
        .join(" ")
        .toLowerCase()
        .includes(this.query),
    );
  }

  render() {
    if (!this.content) return;
    const settings = this.getVisibleSettings();
    this.content.replaceChildren();
    if (!settings.length) {
      const empty = document.createElement("p");
      empty.className = "settings-empty";
      empty.textContent = "No settings found.";
      this.content.appendChild(empty);
      return;
    }
    const categories = [...new Set(settings.map((item) => item.category))];
    for (const category of categories) {
      const section = document.createElement("section");
      section.className = "settings-section";
      const title = document.createElement("h2");
      title.textContent = category;
      section.appendChild(title);
      for (const setting of settings.filter(
        (item) => item.category === category,
      )) {
        section.appendChild(this.createRow(setting));
      }
      this.content.appendChild(section);
    }
  }

  createRow(setting) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const text = document.createElement("div");
    const label = document.createElement("label");
    const controlId = `setting-${setting.key.replace(/\./g, "-")}`;
    label.className = "setting-label";
    label.htmlFor = controlId;
    label.textContent = setting.label;
    const description = document.createElement("p");
    description.className = "setting-description";
    description.textContent = setting.description;
    text.append(label, description);
    const control =
      setting.control === "select"
        ? this.createSelect(setting, controlId)
        : setting.control === "checkbox"
          ? this.createCheckbox(setting, controlId)
          : setting.control === "shortcut"
            ? this.createShortcutInput(setting, controlId)
            : this.createTextInput(setting, controlId);
    row.append(text, control);
    return row;
  }

  createSelect(setting, id) {
    const select = document.createElement("select");
    select.id = id;
    select.className = "setting-select";
    for (const value of setting.options) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      select.appendChild(option);
    }
    select.value = String(SETTINGS_GET(setting.key));
    select.addEventListener("change", async () => {
      const previous = SETTINGS_GET(setting.key);
      if (!(await SETTINGS_SET(setting.key, Number(select.value))))
        select.value = String(previous);
      this.editor.bottomBar?.refreshScrollers?.();
    });
    return select;
  }

  createCheckbox(setting, id) {
    const label = document.createElement("label");
    label.className = "setting-toggle";
    label.htmlFor = id;
    const input = document.createElement("input");
    input.id = id;
    input.type = "checkbox";
    input.checked = SETTINGS_GET(setting.key) === true;
    const track = document.createElement("span");
    track.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () =>
      this.editor.setAutoSaveState(input.checked),
    );
    label.append(input, track);
    return label;
  }

  createTextInput(setting, id) {
    const input = document.createElement("input");
    input.id = id;
    input.type = "text";
    input.className = "setting-input";
    input.value = String(SETTINGS_GET(setting.key) || "");
    input.setAttribute("aria-label", setting.label);
    input.addEventListener("change", async () => {
      const previous = String(SETTINGS_GET(setting.key) || "");
      const value = input.value.trim();
      if (!(await SETTINGS_SET(setting.key, value))) {
        input.value = previous;
      }
    });
    return input;
  }

  createShortcutInput(setting, id) {
    const wrapper = document.createElement("div");
    wrapper.className = "setting-shortcut-wrap";

    const display = document.createElement("button");
    display.id = id;
    display.type = "button";
    display.className = "setting-shortcut-btn";
    display.setAttribute("aria-label", `Change shortcut for ${setting.label}`);

    const currentKey = SETTINGS_GET(setting.key) || "";
    this._renderShortcutKeys(display, currentKey);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "setting-shortcut-reset";
    resetBtn.title = "Reset to default";
    resetBtn.innerHTML = '<i class="fi fi-rr-undo" aria-hidden="true"></i>';
    resetBtn.tabIndex = -1;

    let listening = false;
    let keydownHandler = null;
    let keyupHandler = null;

    const buildCurrentParts = (e) => {
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push("Mod");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      return parts;
    };

    const renderLiveParts = (parts) => {
      display.replaceChildren();
      if (!parts.length) {
        display.textContent = "Press a key combination...";
        return;
      }
      const shortcut = document.createElement("span");
      shortcut.className = "setting-shortcut-key recording";
      shortcut.textContent = `${this._formatShortcutDisplay(parts.join("+"))} …`;
      display.appendChild(shortcut);
    };

    const startListening = () => {
      if (listening) return;
      listening = true;
      display.classList.add("listening");
      display.textContent = "Press a key combination...";

      keydownHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Show modifiers progressively
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
          renderLiveParts(buildCurrentParts(e));
          return;
        }

        // Final key pressed — build full combo
        const parts = buildCurrentParts(e);
        let key = e.key;
        if (key === " ") key = "Space";
        else if (key.length === 1) key = key.toUpperCase();
        parts.push(key);

        const combo = parts.join("+");
        stopListening();
        applyShortcut(combo);
      };

      keyupHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Update display when a modifier is released
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
          const parts = buildCurrentParts(e);
          renderLiveParts(parts);
        }
      };

      document.addEventListener("keydown", keydownHandler, true);
      document.addEventListener("keyup", keyupHandler, true);

      // Cancel on click outside
      setTimeout(() => {
        document.addEventListener("mousedown", cancelOnClickOutside, true);
      }, 0);
    };

    const cancelOnClickOutside = (e) => {
      if (!display.contains(e.target)) {
        stopListening();
      }
    };

    const stopListening = () => {
      if (!listening) return;
      listening = false;
      display.classList.remove("listening");
      document.removeEventListener("keydown", keydownHandler, true);
      document.removeEventListener("keyup", keyupHandler, true);
      document.removeEventListener("mousedown", cancelOnClickOutside, true);
      keydownHandler = null;
      keyupHandler = null;
      const currentVal = SETTINGS_GET(setting.key) || "";
      this._renderShortcutKeys(display, currentVal);
    };

    const applyShortcut = async (combo) => {
      const previous = SETTINGS_GET(setting.key) || "";
      if (!(await SETTINGS_SET(setting.key, combo))) {
        this._renderShortcutKeys(display, previous);
      } else {
        this._renderShortcutKeys(display, combo);
      }
    };

    display.addEventListener("click", (e) => {
      e.stopPropagation();
      startListening();
    });

    display.addEventListener("keydown", (e) => {
      if (!listening && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        startListening();
      }
    });

    resetBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      stopListening();
      const action = setting.key.split(".")[1];
      const defaultKey = DEFAULT_KEYBINDINGS[action];
      if (defaultKey) {
        await applyShortcut(defaultKey);
      }
    });

    wrapper.append(display, resetBtn);
    return wrapper;
  }

  _renderShortcutKeys(container, keyCombo) {
    container.replaceChildren();
    const displayKey = this._formatShortcutDisplay(keyCombo);
    if (!displayKey) {
      container.textContent = "Not set";
      return;
    }
    const shortcut = document.createElement("span");
    shortcut.className = "setting-shortcut-key";
    shortcut.textContent = displayKey;
    container.appendChild(shortcut);
  }

  _formatShortcutDisplay(keyCombo) {
    const parts = CONFIG_KEYBINDING_DISPLAY(keyCombo)
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);

    if (window.api?.platform !== "darwin") return parts.join(" ");

    const macSymbols = {
      meta: "⌘",
      cmd: "⌘",
      command: "⌘",
      shift: "⇧",
      alt: "⌥",
      option: "⌥",
      ctrl: "⌃",
      control: "⌃",
    };
    return parts
      .map((part) => macSymbols[part.toLowerCase()] || part)
      .join(" ");
  }

  sync(key) {
    if (key === "files.autoSave") {
      const input = this.host?.querySelector("#setting-files-autoSave");
      if (input) input.checked = this.editor.getAutoSaveState();
    }
  }

  show() {
    if (this.host) this.host.hidden = false;
    this.render();
  }
  hide() {
    if (this.host) this.host.hidden = true;
  }
}
