class SidebarManager {
  constructor(editor) {
    this.editor = editor;
    this.menus = new Map();
    this.activeMenu = null;
    this.leftActiveMenu = null;
    this.rightActiveMenu = null;
    this.leftSidebar = null;
    this.rightSidebar = null;
    this.tabSelector = null;
    this.leftMenuContainer = null;
    this.rightMenuContainer = null;
    this.settingsMenuOpen = false;
    this.settingsOutsideClickHandler = null;
    this.settingsKeydownHandler = null;
    this.hiddenMenuIds = new Set();
    try {
      const stored = JSON.parse(
        localStorage.getItem("nce.sidebar.hiddenMenuIds") || "[]",
      );
      const knownIds = new Set(USERCONFIG_SIDEBAR_MENUS.map(({ id }) => id));
      if (Array.isArray(stored)) {
        this.hiddenMenuIds = new Set(stored.filter((id) => knownIds.has(id)));
      }
    } catch {}

    this.width = 350;
    this.selectorWidth = 48;

    this.leftScroller = null;
    this.rightScroller = null;

    this.init();
  }

  init() {
    this.tabSelector = this.editor.domManager.getElement(
      ".sidebar-tab-selector",
    );
    this.leftSidebar = this.editor.domManager.getElement(".sidebar-left");
    this.rightSidebar = this.editor.domManager.getElement(".sidebar-right");
    this.leftMenuContainer = this.editor.domManager.getElement(
      ".sidebar-left .sidebar-menu",
    );
    this.rightMenuContainer = this.editor.domManager.getElement(
      ".sidebar-right .sidebar-menu",
    );

    this.renderTabSelector();
    this.setupEventListeners();

    this.leftScroller = new SidebarScroller(
      this.editor,
      this.leftSidebar,
      this.leftMenuContainer,
    );
    this.leftScroller.init();
  }

  registerMenu(menu) {
    this.menus.set(menu.id, menu);
    menu.setElement(
      menu.position === "left"
        ? this.leftMenuContainer
        : this.rightMenuContainer,
    );
  }

  isMenuVisible(menuId) {
    return !this.hiddenMenuIds.has(menuId);
  }

  setMenuVisible(menuId, visible) {
    if (!USERCONFIG_SIDEBAR_MENUS.some((menu) => menu.id === menuId)) return;
    const wasVisible = this.isMenuVisible(menuId);
    if (visible) this.hiddenMenuIds.delete(menuId);
    else this.hiddenMenuIds.add(menuId);
    try {
      localStorage.setItem(
        "nce.sidebar.hiddenMenuIds",
        JSON.stringify([...this.hiddenMenuIds]),
      );
    } catch {}
    if (visible && !wasVisible) {
      this.openMenu(menuId);
      return;
    }
    const hiddenMenu = this.menus.get(menuId);
    if (!visible && hiddenMenu?.isOpen) {
      const fallback = USERCONFIG_SIDEBAR_MENUS
        .map((config) => this.menus.get(config.id))
        .find((menu) =>
          menu && menu.id !== menuId &&
          menu.position === hiddenMenu.position &&
          this.isMenuVisible(menu.id)
        );
      if (fallback) this.openMenu(fallback.id);
      else this.closeMenu(menuId);
      return;
    }
    this.renderTabSelector();
  }

  renderTabSelector() {
    if (!this.tabSelector) return;

    // The selector can be rebuilt after sidebar changes. The old menu nodes
    // are discarded with it, so never carry an open state across a render.
    this.settingsMenuOpen = false;

    const fragment = document.createDocumentFragment();

    for (const menuConfig of USERCONFIG_SIDEBAR_MENUS) {
      if (!this.isMenuVisible(menuConfig.id)) continue;
      const menu = this.menus.get(menuConfig.id);
      const iconDiv = document.createElement("div");
      iconDiv.className = "sidebar-tab-icon";
      if (menu && menu.isOpen) {
        iconDiv.classList.add("active");
      }
      iconDiv.dataset.menuId = menuConfig.id;
      iconDiv.title = menuConfig.title;

      const icon = document.createElement("i");
      icon.className = menuConfig.icon;
      iconDiv.appendChild(icon);

      fragment.appendChild(iconDiv);
    }

    const settingsContainer = document.createElement("div");
    settingsContainer.className = "sidebar-settings-container";

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "sidebar-tab-icon sidebar-settings-icon";
    settingsButton.title = "Settings";
    settingsButton.setAttribute("aria-label", "Open Settings");
    settingsButton.setAttribute("aria-haspopup", "menu");
    settingsButton.setAttribute("aria-expanded", "false");
    const settingsIcon = document.createElement("i");
    settingsIcon.className = "fi fi-rr-settings-sliders";
    settingsIcon.setAttribute("aria-hidden", "true");
    settingsButton.appendChild(settingsIcon);

    const settingsMenu = document.createElement("div");
    settingsMenu.className = "sidebar-settings-menu";
    settingsMenu.setAttribute("role", "menu");
    settingsMenu.hidden = true;

    const openSettingsUI = this.createSettingsMenuItem(
      "Open Settings UI",
      () => {
        this.closeSettingsMenu();
        this.editor.openSettings();
      },
    );
    const openSettingsJSON = this.createSettingsMenuItem(
      "Open Settings JSON",
      () => {
        this.closeSettingsMenu();
        this.editor.openSettingsJson?.();
      },
    );
    settingsMenu.append(openSettingsUI, openSettingsJSON);
    settingsButton.addEventListener("click", () =>
      this.toggleSettingsMenu(),
    );
    settingsContainer.append(settingsButton, settingsMenu);
    fragment.appendChild(settingsContainer);

    this.tabSelector.replaceChildren(fragment);
  }

  setupEventListeners() {
    if (this.tabSelector) {
      this.tabSelector.addEventListener("click", (e) => {
        const icon = e.target.closest(".sidebar-tab-icon[data-menu-id]");
        if (icon) {
          const menuId = icon.dataset.menuId;
          this.toggleMenu(menuId);
        }
      });
      this.tabSelector.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const icon = event.target.closest(
          ".sidebar-tab-icon[data-menu-id]",
        );
        this.editor.contextMenuManager?.openContextMenu(
          icon ? "sidebar-selector-icon" : "sidebar-selector-empty",
          icon ? { menuId: icon.dataset.menuId } : null,
        );
      });
      this.settingsOutsideClickHandler = (e) => {
        if (
          this.settingsMenuOpen &&
          !e.target.closest(".sidebar-settings-container")
        ) {
          this.closeSettingsMenu();
        }
      };
      this.settingsKeydownHandler = (e) => {
        if (e.key === "Escape" && this.settingsMenuOpen) {
          e.preventDefault();
          this.closeSettingsMenu({ restoreFocus: true });
        }
      };
      document.addEventListener("click", this.settingsOutsideClickHandler);
      document.addEventListener("keydown", this.settingsKeydownHandler);
    }
  }

  createSettingsMenuItem(label, action) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sidebar-settings-menu-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.addEventListener("click", action);
    item.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...item.parentElement.querySelectorAll("[role='menuitem']")];
      const index = items.indexOf(item);
      const next = event.key === "ArrowDown"
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
      event.preventDefault();
      items[next].focus();
    });
    return item;
  }

  toggleSettingsMenu() {
    if (this.settingsMenuOpen) {
      this.closeSettingsMenu({ restoreFocus: true });
    } else {
      this.openSettingsMenu();
    }
  }

  openSettingsMenu() {
    const container = this.tabSelector?.querySelector(
      ".sidebar-settings-container",
    );
    const button = container?.querySelector(".sidebar-settings-icon");
    const menu = container?.querySelector(".sidebar-settings-menu");
    if (!button || !menu) return;

    this.settingsMenuOpen = true;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
  }

  closeSettingsMenu({ restoreFocus = false } = {}) {
    const container = this.tabSelector?.querySelector(
      ".sidebar-settings-container",
    );
    const button = container?.querySelector(".sidebar-settings-icon");
    const menu = container?.querySelector(".sidebar-settings-menu");
    this.settingsMenuOpen = false;
    if (!button || !menu) return;

    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
  }

  destroy() {
    if (this.settingsOutsideClickHandler) {
      document.removeEventListener("click", this.settingsOutsideClickHandler);
      this.settingsOutsideClickHandler = null;
    }
    if (this.settingsKeydownHandler) {
      document.removeEventListener("keydown", this.settingsKeydownHandler);
      this.settingsKeydownHandler = null;
    }
    this.closeSettingsMenu();
  }

  getActiveMenuForPosition(position) {
    if (position === "left") return this.leftActiveMenu;
    if (position === "right") return this.rightActiveMenu;
    return this.activeMenu;
  }

  setActiveMenuForPosition(position, menu) {
    if (position === "left") {
      this.leftActiveMenu = menu;
    } else if (position === "right") {
      this.rightActiveMenu = menu;
    }

    this.activeMenu = menu;
  }

  clearActiveMenuForPosition(position) {
    if (position === "left") {
      this.leftActiveMenu = null;
    } else if (position === "right") {
      this.rightActiveMenu = null;
    }

    if (!this.leftActiveMenu && !this.rightActiveMenu) {
      this.activeMenu = null;
    }
  }

  toggleMenu(menuId) {
    const menu = this.menus.get(menuId);
    if (!menu) return;

    const currentActive = this.getActiveMenuForPosition(menu.position);
    if (currentActive && currentActive.id !== menuId) {
      currentActive.close();
    }

    menu.toggle();

    if (menu.isOpen) {
      this.setActiveMenuForPosition(menu.position, menu);
      this.openSidebar(menu.position);
      this.renderMenuContent(menu);
    } else {
      this.clearActiveMenuForPosition(menu.position);
      this.closeSidebar(menu.position);
    }

    this.renderTabSelector();
  }

  openMenu(menuId) {
    const menu = this.menus.get(menuId);
    if (!menu) return;

    const currentActive = this.getActiveMenuForPosition(menu.position);
    if (currentActive && currentActive.id !== menuId) {
      currentActive.close();
    }

    menu.open();
    this.setActiveMenuForPosition(menu.position, menu);
    this.openSidebar(menu.position);
    this.renderMenuContent(menu);
    this.renderTabSelector();
  }

  closeMenu(menuId) {
    const menu = this.menus.get(menuId);
    if (!menu) return;

    menu.close();
    if (this.getActiveMenuForPosition(menu.position)?.id === menuId) {
      this.clearActiveMenuForPosition(menu.position);
    }
    this.closeSidebar(menu.position);
    this.renderTabSelector();
  }

  getOpenSidebarWidth(position) {
    const sidebar = position === "left" ? this.leftSidebar : this.rightSidebar;

    if (!sidebar || !sidebar.classList.contains("open")) {
      return 0;
    }

    return sidebar.offsetWidth || this.width;
  }

  syncEditorLayout() {
    const leftWidth = this.getOpenSidebarWidth("left");
    const rightWidth = this.getOpenSidebarWidth("right");
    const leftOffset = this.selectorWidth + leftWidth;

    if (this.editor.fileManagerOBJ) {
      this.editor.fileManagerOBJ.style.left = `${leftOffset}px`;
    }

    if (this.editor.editorOBJ) {
      this.editor.editorOBJ.style.left = `${leftOffset}px`;
      this.editor.editorOBJ.style.right = `${rightWidth}px`;
      this.editor.editorOBJ.style.width = "";
    }

    if (this.editor.domManager) {
      this.editor.domManager.measureElements();
      this.editor.domManager.calculate();
      this.editor.domManager.apply();
    }

    if (this.editor.cursorController) {
      this.editor.cursorController.updateCaretPosition();
    }
  }

  openSidebar(position) {
    if (position === "left" && this.leftSidebar) {
      this.leftSidebar.classList.add("open");
      this.editor.domManager
        .getElement(".main-section")
        .classList.add("sidebar-left-open");
    } else if (position === "right" && this.rightSidebar) {
      this.rightSidebar.classList.add("open");
    }

    this.syncEditorLayout();

    if (this.editor.sidebarResizer) {
      this.editor.sidebarResizer.updateResizerVisibility();
    }

    requestAnimationFrame(() => {
      this.editor.lineController.resizeWidth();
      if (this.leftScroller) this.leftScroller.refresh();
      if (this.rightScroller) this.rightScroller.refresh();
    });
  }

  closeSidebar(position) {
    if (position === "left" && this.leftSidebar) {
      this.leftSidebar.classList.remove("open");
      this.editor.domManager
        .getElement(".main-section")
        .classList.remove("sidebar-left-open");
    } else if (position === "right" && this.rightSidebar) {
      this.rightSidebar.classList.remove("open");
    }

    this.syncEditorLayout();

    if (this.editor.sidebarResizer) {
      this.editor.sidebarResizer.updateResizerVisibility();
    }

    requestAnimationFrame(() => {
      this.editor.lineController.resizeWidth();
      if (this.leftScroller) this.leftScroller.refresh();
      if (this.rightScroller) this.rightScroller.refresh();
    });
  }

  renderMenuContent(menu) {
    const container =
      menu.position === "left"
        ? this.leftMenuContainer
        : this.rightMenuContainer;
    if (container) {
      const content = menu.render();

      if (content instanceof Node) {
        container.replaceChildren(content);
      } else {
        container.innerHTML = content;
      }
    }
  }

  refreshAll() {
    this.renderTabSelector();

    if (this.activeMenu) this.renderMenuContent(this.activeMenu);
  }

  handleKeybinding(keybinding) {
    for (const menuConfig of USERCONFIG_SIDEBAR_MENUS) {
      if (menuConfig.keybinding === keybinding) {
        this.toggleMenu(menuConfig.id);
        return true;
      }
    }
    return false;
  }
}
