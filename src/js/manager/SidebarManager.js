class SidebarManager {
  constructor(editor) {
    this.editor = editor;
    this.menus = new Map();
    this.activeMenu = null;
    this.leftSidebar = null;
    this.rightSidebar = null;
    this.tabSelector = null;
    this.leftMenuContainer = null;
    this.rightMenuContainer = null;

    this.width = 250;
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
    this.renderTabSelector();
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

  toggleMenu(menuId) {
    const menu = this.menus.get(menuId);
    if (!menu) return;

    if (this.activeMenu && this.activeMenu.id !== menuId) {
      this.activeMenu.close();
    }

    menu.toggle();

    if (menu.isOpen) {
      this.activeMenu = menu;
      this.openSidebar(menu.position);
      this.renderMenuContent(menu);
    } else {
      this.activeMenu = null;
      this.closeSidebar(menu.position);
    }

    this.renderTabSelector();
  }

  openMenu(menuId) {
    const menu = this.menus.get(menuId);
    if (!menu) return;

    if (this.activeMenu && this.activeMenu.id !== menuId) {
      this.activeMenu.close();
    }

    menu.open();
    this.activeMenu = menu;
    this.openSidebar(menu.position);
    this.renderMenuContent(menu);
    this.renderTabSelector();
  }

  closeMenu(menuId) {
    const menu = this.menus.get(menuId);
    if (!menu) return;

    menu.close();
    if (this.activeMenu && this.activeMenu.id === menuId) {
      this.activeMenu = null;
      this.closeSidebar(menu.position);
    }
    this.renderTabSelector();
  }

  openSidebar(position) {
    if (position === "left" && this.leftSidebar) {
      this.leftSidebar.classList.add("open");
      this.editor.domManager
        .getElement(".main-section")
        .classList.add("sidebar-left-open");

      this.editor.fileManagerOBJ.style.left =
        this.width + this.selectorWidth + "px";
      this.editor.editorOBJ.style.left = this.width + this.selectorWidth + "px";
      this.editor.editorOBJ.style.width = "";
      this.editor.editorOBJ.style.right = "0px";
    } else if (position === "right" && this.rightSidebar) {
      this.rightSidebar.classList.add("open");
      this.editor.editorOBJ.style.right = this.width + "px";
      this.editor.editorOBJ.style.width = "";
    }

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

      this.editor.fileManagerOBJ.style.left = this.selectorWidth + "px";
      this.editor.editorOBJ.style.left = this.selectorWidth + "px";
      this.editor.editorOBJ.style.width = "";
      this.editor.editorOBJ.style.right = "0px";
    } else if (position === "right" && this.rightSidebar) {
      this.rightSidebar.classList.remove("open");
      this.editor.editorOBJ.style.right = "0px";
      this.editor.editorOBJ.style.width = "";
    }

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
