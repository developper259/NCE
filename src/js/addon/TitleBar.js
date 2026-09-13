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
    this.recentFolders = [];
    this.onDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.onDocumentKeyDown = this.handleDocumentKeyDown.bind(this);

    document.documentElement.dataset.platform = this.platform;
    if (!this.root || !this.menubar || !this.title) return;
    this.buildMenus();
    document.addEventListener("pointerdown", this.onDocumentPointerDown);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    this.refresh();
    this.loadRecentFolders();
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
          ["Open Recent", "open_recent_menu", { recentSubmenu: true }],
          null,
          ["Save", "save", { needsFile: true }],
          ["Save As...", "saveAs", { needsFile: true }],
          null,
          ["Auto Save", "auto_save", { checkbox: true }],
          null,
          ["Close File", "close_file", { needsFile: true }],
          ["Close All Files", "close_all_file", { needsFile: true }],
          null,
          ["Exit NCE", "quit_app"],
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
          ["Go to Line...", "go_to_line", { needsFile: true }],
          null,
          ["Select All", "select_all", { needsFile: true }],
          ["Unselect All", "unselect_all", { needsFile: true }],
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
          ["Quick Open...", "quick_open"],
          null,
          ["Command Palette", "open_command"],
          null,
          ["Toggle Fullscreen", "view.fullscreen"],
          ["Reload Window", "reload_window"],
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
      if (options.recentSubmenu) {
        menu.appendChild(this.createRecentSubmenu(label));
        continue;
      }
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

  createRecentSubmenu(label) {
    const wrapper = document.createElement("div");
    wrapper.className = "nce-titlebar-submenu-item";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "nce-titlebar-menu-item";
    trigger.dataset.command = "open_recent_menu";
    trigger.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    trigger.tabIndex = -1;

    const text = document.createElement("span");
    text.textContent = label;
    const arrow = document.createElement("span");
    arrow.className = "nce-titlebar-submenu-arrow";
    arrow.textContent = "›";
    trigger.append(text, arrow);

    const submenu = document.createElement("div");
    submenu.className = "nce-titlebar-dropdown nce-titlebar-submenu";
    submenu.setAttribute("role", "menu");
    submenu.hidden = true;
    this.populateRecentSubmenu(submenu);

    const open = () => {
      submenu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    };
    trigger.addEventListener("mouseenter", open);
    wrapper.addEventListener("mouseleave", () => {
      submenu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    });
    trigger.addEventListener("mousedown", (event) => event.preventDefault());
    trigger.addEventListener("click", () => {
      if (submenu.hidden) open();
      else {
        submenu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
    });
    wrapper.append(trigger, submenu);
    return wrapper;
  }

  populateRecentSubmenu(submenu) {
    submenu.replaceChildren();
    if (this.recentFolders.length === 0) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "nce-titlebar-menu-item";
      empty.textContent = "No Recent Folders";
      empty.disabled = true;
      submenu.appendChild(empty);
      return;
    }

    for (const folderPath of this.recentFolders) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "nce-titlebar-menu-item nce-titlebar-recent-folder";
      item.textContent = folderPath;
      item.title = folderPath;
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => {
        this.closeMenus({ restoreFocus: false });
        this.editor.openRecentFolder(folderPath);
      });
      submenu.appendChild(item);
    }

    const separator = document.createElement("div");
    separator.className = "nce-titlebar-separator";
    separator.setAttribute("role", "separator");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "nce-titlebar-menu-item";
    clear.textContent = "Clear Recently Opened";
    clear.addEventListener("mousedown", (event) => event.preventDefault());
    clear.addEventListener("click", () => {
      this.closeMenus({ restoreFocus: false });
      this.editor.clearRecentFolders();
    });
    submenu.append(separator, clear);
  }

  async loadRecentFolders() {
    try {
      this.setRecentFolders(await this.editor.api.getRecentFolders?.());
    } catch (error) {
      console.error("Unable to load recent folders:", error);
    }
  }

  setRecentFolders(folders) {
    this.recentFolders = Array.isArray(folders)
      ? folders.filter((folderPath) => typeof folderPath === "string")
      : [];
    this.root
      ?.querySelectorAll(".nce-titlebar-submenu")
      .forEach((submenu) => this.populateRecentSubmenu(submenu));
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
    const showDirtyIndicator = file?.isVisuallyDirty() === true;
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
