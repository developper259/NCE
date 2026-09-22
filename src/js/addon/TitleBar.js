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
    this.altKeyUsed = false;
    this.menuButtons = [];
    this.recentFolders = [];
    this.onDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.onDocumentKeyDown = this.handleDocumentKeyDown.bind(this);
    this.onDocumentKeyUp = this.handleDocumentKeyUp.bind(this);
    this.onWindowResize = () => this.repositionOpenSubmenus();

    document.documentElement.dataset.platform = this.platform;
    if (!this.root || !this.menubar || !this.title) return;
    this.buildMenus();
    document.addEventListener("pointerdown", this.onDocumentPointerDown);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    document.addEventListener("keyup", this.onDocumentKeyUp, true);
    window.addEventListener("resize", this.onWindowResize);
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

    const open = () => this.openSubmenu(trigger, submenu);
    const close = () => this.closeSubmenu(trigger, submenu);
    trigger.addEventListener("mouseenter", open);
    wrapper.addEventListener("mouseleave", () => {
      window.clearTimeout(wrapper._submenuCloseTimer);
      wrapper._submenuCloseTimer = window.setTimeout(() => {
        if (!wrapper.matches(":hover") && !submenu.matches(":hover")) close();
      }, 120);
    });
    submenu.addEventListener("mouseenter", () => window.clearTimeout(wrapper._submenuCloseTimer));
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

  openSubmenu(trigger, submenu) {
    const wrapper = trigger.parentElement;
    wrapper?.parentElement?.querySelectorAll(":scope > .nce-titlebar-submenu-item").forEach((item) => {
      if (item !== wrapper) {
        const otherTrigger = item.querySelector(":scope > .nce-titlebar-menu-item");
        const otherSubmenu = item.querySelector(":scope > .nce-titlebar-submenu");
        if (otherTrigger && otherSubmenu) this.closeSubmenu(otherTrigger, otherSubmenu);
      }
    });
    submenu.hidden = false;
    submenu.style.visibility = "hidden";
    submenu.style.position = "fixed";
    submenu.style.left = "0px";
    submenu.style.top = "0px";
    const triggerRect = trigger.getBoundingClientRect();
    const parentMenu = wrapper?.parentElement;
    const parentMenuRect = parentMenu?.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const parentRight = parentMenuRect?.right ?? triggerRect.right;
    const parentLeft = parentMenuRect?.left ?? triggerRect.left;
    let left = parentRight - 1;
    if (parentRight + submenuRect.width > window.innerWidth) {
      left = parentLeft - submenuRect.width;
    }
    left = Math.max(0, Math.min(left, window.innerWidth - submenuRect.width));
    const top = Math.max(0, Math.min(triggerRect.top, window.innerHeight - submenuRect.height));
    submenu.style.setProperty("left", `${left}px`);
    submenu.style.setProperty("top", `${top}px`);
    submenu.style.visibility = "";
    trigger.setAttribute("aria-expanded", "true");
  }

  repositionOpenSubmenus() {
    this.root?.querySelectorAll(".nce-titlebar-submenu-item").forEach((wrapper) => {
      const trigger = wrapper.querySelector(":scope > .nce-titlebar-menu-item");
      const submenu = wrapper.querySelector(":scope > .nce-titlebar-submenu");
      if (trigger && submenu && !submenu.hidden) this.openSubmenu(trigger, submenu);
    });
  }

  closeSubmenu(trigger, submenu) {
    submenu.hidden = true;
    submenu.style.visibility = "";
    trigger.setAttribute("aria-expanded", "false");
    submenu.querySelectorAll(":scope .nce-titlebar-submenu").forEach((child) => {
      child.hidden = true;
      child.style.visibility = "";
    });
  }

  populateRecentSubmenu(submenu) {
    submenu.replaceChildren();
    if (this.recentFolders.length === 0) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "nce-titlebar-menu-item";
      empty.textContent = "No Recent Folders";
      empty.dataset.staticDisabled = "true";
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
    this.root?.querySelectorAll(".nce-titlebar-submenu").forEach((submenu) => {
      submenu.hidden = true;
      submenu.style.visibility = "";
    });
    this.root?.querySelectorAll(".nce-titlebar-submenu-item > .nce-titlebar-menu-item").forEach((trigger) => {
      trigger.setAttribute("aria-expanded", "false");
    });
    if (restoreFocus && this.previousFocus?.focus) {
      this.previousFocus.focus({ preventScroll: true });
    }
    this.previousFocus = null;
  }

  refreshDisabledItems() {
    const hasFile = Boolean(this.editor.tabManager.activeFile);
    this.root.querySelectorAll(".nce-titlebar-menu-item").forEach((item) => {
      if (item.dataset.staticDisabled === "true") item.disabled = true;
      else if (item.dataset.needsFile !== undefined) {
        item.disabled = item.dataset.needsFile === "true" && !hasFile;
      }
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
    const activeSubmenu = document.activeElement?.closest?.(
      ".nce-titlebar-submenu:not([hidden])",
    );
    if (activeSubmenu) {
      return Array.from(activeSubmenu.children).filter(
        (item) =>
          item.classList?.contains("nce-titlebar-menu-item") && !item.disabled,
      );
    }
    return Array.from(panel?.children || [])
      .map((item) =>
        item.classList?.contains("nce-titlebar-submenu-item")
          ? item.querySelector(":scope > .nce-titlebar-menu-item")
          : item,
      )
      .filter(
        (item) =>
          item?.classList?.contains("nce-titlebar-menu-item") && !item.disabled,
      );
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
    if (event.key === "Alt") this.altKeyUsed = false;
    else if (event.altKey) this.altKeyUsed = true;

    if (
      event.key === "F10" &&
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
    else if (
      event.key === "ArrowRight" &&
      document.activeElement?.dataset.command === "open_recent_menu"
    ) {
      const trigger = document.activeElement;
      const submenu = trigger.nextElementSibling;
      this.openSubmenu(trigger, submenu);
      const firstItem = submenu.querySelector(
        ".nce-titlebar-menu-item:not(:disabled)",
      );
      firstItem?.focus();
      if (firstItem) this.activeItemIndex = 0;
    } else if (
      event.key === "ArrowLeft" &&
      document.activeElement?.closest?.(".nce-titlebar-submenu")
    ) {
      const submenu = document.activeElement.closest(".nce-titlebar-submenu");
      const trigger = submenu.previousElementSibling;
      if (trigger) this.closeSubmenu(trigger, submenu);
      trigger?.focus();
      this.activeItemIndex = this.getOpenItems().indexOf(trigger);
    } else if (event.key === "ArrowRight") this.switchMenu(1);
    else if (event.key === "ArrowLeft") this.switchMenu(-1);
    else if (
      event.key === "Enter" &&
      document.activeElement?.classList?.contains("nce-titlebar-menu-item") &&
      !document.activeElement.disabled
    )
      document.activeElement.click();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  handleDocumentKeyUp(event) {
    if (event.key !== "Alt") return;
    if (!this.openMenuId && !this.altKeyUsed && this.platform !== "darwin") {
      event.preventDefault();
      this.openMenu(this.menuButtons[0].dataset.menu, true);
    }
    this.altKeyUsed = false;
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
    document.removeEventListener("keyup", this.onDocumentKeyUp, true);
    window.removeEventListener("resize", this.onWindowResize);
  }
}
