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
    this.rightScroller = new SidebarScroller(
      this.editor,
      this.rightSidebar,
      this.rightMenuContainer,
    );
    this.leftScroller.init();
    this.rightScroller.init();
  }

  registerMenu(menu) {
    this.menus.set(menu.id, menu);
    menu.setElement(
      menu.position === "left"
        ? this.leftMenuContainer
        : this.rightMenuContainer,
    );
  }

  renderTabSelector() {
    if (!this.tabSelector) return;

    const fragment = document.createDocumentFragment();

    for (const menuConfig of USERCONFIG_SIDEBAR_MENUS) {
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
    this.tabSelector.replaceChildren(fragment);
  }

  setupEventListeners() {
    if (this.tabSelector) {
      this.tabSelector.addEventListener("click", (e) => {
        const icon = e.target.closest(".sidebar-tab-icon");
        if (icon) {
          const menuId = icon.dataset.menuId;
          this.toggleMenu(menuId);
        }
      });
    }
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
