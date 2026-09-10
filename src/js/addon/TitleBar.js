class TitleBar {
  constructor(editor) {
    this.editor = editor;
    this.platform = editor.api.platform || "linux";
    this.root = document.querySelector(".nce-titlebar");
    this.menubar = this.root?.querySelector(".nce-titlebar-menubar");
    this.title = this.root?.querySelector(".nce-titlebar-title");
    this.openMenuId = null;
    this.activeItemIndex = -1;
    this.previousFocus = null;
    this.menuButtons = [];
    this.onDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.onDocumentKeyDown = this.handleDocumentKeyDown.bind(this);

    document.documentElement.dataset.platform = this.platform;
    if (!this.root || !this.menubar || !this.title) return;
    this.buildMenus();
    document.addEventListener("pointerdown", this.onDocumentPointerDown);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    this.refresh();
  }

  get menuDefinitions() {
    return [
      {
        id: "file",
        label: "File",
        items: [
          ["New File", "new_file"],
          ["Open File...", "open_file"],
          ["Open Folder...", "open_folder"],
          null,
          ["Save", "save", { needsFile: true }],
          ["Save As...", "saveAs", { needsFile: true }],
          null,
          ["Auto Save", "auto_save", { checkbox: true }],
          null,
          ["Close File", "close_file", { needsFile: true }],
          ["Close All Files", "close_all_file", { needsFile: true }],
          null,
          ["Exit NCE", "exit"],
        ],
      },
      {
        id: "edit",
        label: "Edit",
        items: [
          ["Undo", "undo", { needsFile: true }],
          ["Redo", "redo", { needsFile: true }],
          null,
          ["Cut", "cut", { needsFile: true }],
          ["Copy", "copy", { needsFile: true }],
          ["Paste", "paste", { needsFile: true }],
          null,
          ["Find", "find", { needsFile: true }],
          null,
          ["Select All", "select_all", { needsFile: true }],
          ["Delete Line", "delete_line", { needsFile: true }],
          null,
          ["Settings", "open_settings"],
        ],
      },
      {
        id: "view",
        label: "View",
        items: [
          ["File Explorer", "toggle_file_explorer"],
          ["Search", "toggle_search"],
          ["Agent", "toggle_agent"],
          null,
          ["Command Palette", "open_command"],
          null,
          ["Toggle Fullscreen", "view.fullscreen"],
          // DEV ONLY — uncomment for local development.
        ],
      },
      {
        id: "help",
        label: "Help",
        items: [["About NCE", "help.about"]],
      },
    ];
  }

  buildMenus() {
    this.menubar.replaceChildren();
    if (this.platform === "darwin") return;
    const fragment = document.createDocumentFragment();
    for (const definition of this.menuDefinitions) {
      const group = document.createElement("div");
      group.className = "nce-titlebar-menu-group";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nce-titlebar-menu-button";
      button.textContent = definition.label;
      button.dataset.menu = definition.id;
      button.setAttribute("role", "menuitem");
      button.setAttribute("aria-haspopup", "true");
      button.setAttribute("aria-expanded", "false");
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.toggleMenu(definition.id));
      button.addEventListener("mouseenter", () => {
        if (this.openMenuId) this.openMenu(definition.id);
      });
      const menu = this.createMenu(definition);
      group.append(button, menu);
      fragment.appendChild(group);
      this.menuButtons.push(button);
    }
    this.menubar.appendChild(fragment);
  }

  createMenu(definition) {
    const menu = document.createElement("div");
    menu.className = "nce-titlebar-dropdown";
    menu.dataset.menuPanel = definition.id;
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    for (const item of definition.items) {
      if (!item) {
        const separator = document.createElement("div");
        separator.className = "nce-titlebar-separator";
        separator.setAttribute("role", "separator");
        menu.appendChild(separator);
        continue;
      }
      const [label, command, options = {}] = item;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nce-titlebar-menu-item";
      button.dataset.command = command;
      button.dataset.needsFile = String(Boolean(options.needsFile));
      button.dataset.checkbox = String(Boolean(options.checkbox));
      button.setAttribute(
        "role",
        options.checkbox ? "menuitemcheckbox" : "menuitem",
      );
      if (options.checkbox) {
        button.classList.add("is-checkbox");
        button.setAttribute("aria-checked", "false");
      }
      button.tabIndex = -1;
      const text = document.createElement("span");
      text.textContent = label;
      const shortcut = document.createElement("span");
      shortcut.className = "nce-titlebar-shortcut";
      shortcut.textContent = this.getShortcut(command);
      button.append(text, shortcut);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.execute(command));
      menu.appendChild(button);
    }
    return menu;
  }

  getShortcut(command) {
    if (command === "saveAs") {
      const save = this.getShortcut("save");
      return save ? save.replace("S", "Shift+S") : "";
    }
    if (command === "view.fullscreen") return "F11";
    const binding = USERCONFIG_KEYBINDING.find(
      (item) => item.action === command,
    );
    return binding ? CONFIG_KEYBINDING_DISPLAY(binding.key) : "";
  }

  toggleMenu(id) {
    if (this.openMenuId === id) this.closeMenus();
    else this.openMenu(id);
  }

  openMenu(id, focusItem = false) {
    this.previousFocus ||= document.activeElement;
    this.openMenuId = id;
    this.activeItemIndex = -1;
    for (const button of this.menuButtons) {
      const active = button.dataset.menu === id;
      button.classList.toggle("is-open", active);
      button.setAttribute("aria-expanded", String(active));
      const panel = button.nextElementSibling;
      panel.hidden = !active;
    }
    this.refreshDisabledItems();
    if (focusItem) this.moveItemFocus(1);
  }

  closeMenus({ restoreFocus = true } = {}) {
    if (!this.openMenuId) return;
    this.openMenuId = null;
    this.activeItemIndex = -1;
    for (const button of this.menuButtons) {
      button.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
      button.nextElementSibling.hidden = true;
    }
    if (restoreFocus && this.previousFocus?.focus) {
      this.previousFocus.focus({ preventScroll: true });
    }
    this.previousFocus = null;
  }

  refreshDisabledItems() {
    const hasFile = Boolean(this.editor.tabManager.activeFile);
    this.root.querySelectorAll(".nce-titlebar-menu-item").forEach((item) => {
      item.disabled = item.dataset.needsFile === "true" && !hasFile;
    });
    this.refreshAutoSaveState();
  }

  refreshAutoSaveState() {
    const item = this.root?.querySelector('[data-command="auto_save"]');
    if (item)
      item.setAttribute(
        "aria-checked",
        String(this.editor.getAutoSaveState?.() === true),
      );
  }

  execute(command) {
    this.closeMenus({ restoreFocus: false });
    if (command === "auto_save") return this.editor.toggleAutoSave?.();
    if (command === "exit") return this.editor.api.quit();
    if (command.includes(".")) return this.editor.api.appCommand(command);
    const method = command === "saveAs" ? "control_save" : `control_${command}`;
    const action = this.editor.keyBinding?.[method];
    if (typeof action === "function") {
      return action.call(this.editor.keyBinding, command === "saveAs");
    }
  }

  getOpenItems() {
    if (!this.openMenuId) return [];
    const panel = this.root.querySelector(
      `[data-menu-panel="${this.openMenuId}"]`,
    );
    return Array.from(
      panel?.querySelectorAll(".nce-titlebar-menu-item") || [],
    ).filter((item) => !item.disabled);
  }

  moveItemFocus(direction) {
    const items = this.getOpenItems();
    if (!items.length) return;
    this.activeItemIndex =
      (this.activeItemIndex + direction + items.length) % items.length;
    items[this.activeItemIndex].focus();
  }

  switchMenu(direction) {
    const index = this.menuButtons.findIndex(
      (button) => button.dataset.menu === this.openMenuId,
    );
    const next =
      (index + direction + this.menuButtons.length) % this.menuButtons.length;
    this.openMenu(this.menuButtons[next].dataset.menu, true);
  }

  handleDocumentPointerDown(event) {
    if (this.openMenuId && !this.root.contains(event.target)) this.closeMenus();
  }

  handleDocumentKeyDown(event) {
    if (
      (event.key === "Alt" || event.key === "F10") &&
      !this.openMenuId &&
      this.platform !== "darwin"
    ) {
      event.preventDefault();
      this.openMenu(this.menuButtons[0].dataset.menu, true);
      return;
    }
    if (!this.openMenuId) return;
    if (event.key === "Escape") this.closeMenus();
    else if (event.key === "ArrowDown") this.moveItemFocus(1);
    else if (event.key === "ArrowUp") this.moveItemFocus(-1);
    else if (event.key === "ArrowRight") this.switchMenu(1);
    else if (event.key === "ArrowLeft") this.switchMenu(-1);
    else if (event.key === "Enter" && document.activeElement?.dataset.command)
      document.activeElement.click();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  refresh() {
    if (!this.title) return;
    const file = this.editor.tabManager.activeFile;
    const project = this.editor.fileExplorer?.projectName;
    const context = file?.name
      ? `${file.name}${project ? ` · ${project}` : ""}`
      : project || "NCE";
    const showDirtyIndicator =
      file && !file.isSaved && (file.autoSave !== true || file.deletedFromDisk);
    this.title.textContent = `${showDirtyIndicator ? "● " : ""}${context}`;
    this.title.title = context;
    this.refreshDisabledItems();
  }

  destroy() {
    this.closeMenus({ restoreFocus: false });
    document.removeEventListener("pointerdown", this.onDocumentPointerDown);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
  }
}
