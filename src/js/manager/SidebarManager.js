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

    this.init();
  }

  init() {
    this.tabSelector = getElement(".sidebar-tab-selector");
    this.leftSidebar = getElement(".sidebar-left");
    this.rightSidebar = getElement(".sidebar-right");
    this.leftMenuContainer = getElement(".sidebar-left .sidebar-menu");
    this.rightMenuContainer = getElement(".sidebar-right .sidebar-menu");

    this.renderTabSelector();
    this.setupEventListeners();
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

    this.tabSelector.innerHTML = "";
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

      this.tabSelector.appendChild(iconDiv);
    }
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
      document
        .querySelector(".main-section")
        .classList.add("sidebar-left-open");

      this.editor.fileManagerOBJ.style.left = (this.width + this.selectorWidth) + "px";
      this.editor.editorOBJ.style.left = (this.width + this.selectorWidth) + "px";
      this.editor.editorOBJ.style.width = "calc(100% - " + (this.width + this.selectorWidth) + "px)";
    } else if (position === "right" && this.rightSidebar) {
      this.rightSidebar.classList.add("open");
    }

    if (this.editor.sidebarResizer) {
      this.editor.sidebarResizer.updateResizerVisibility();
    }

    this.editor.lineController.resizeWidth();
  }

  closeSidebar(position) {
    if (position === "left" && this.leftSidebar) {
      this.leftSidebar.classList.remove("open");
      document
        .querySelector(".main-section")
        .classList.remove("sidebar-left-open");

      this.editor.fileManagerOBJ.style.left = this.selectorWidth + "px";
      this.editor.editorOBJ.style.left = this.selectorWidth + "px";
      this.editor.editorOBJ.style.width = "calc(100% - " + this.selectorWidth + "px)";
    } else if (position === "right" && this.rightSidebar) {
      this.rightSidebar.classList.remove("open");
    }

    if (this.editor.sidebarResizer) {
      this.editor.sidebarResizer.updateResizerVisibility();
    }
    
    this.editor.lineController.resizeWidth();
  }

  renderMenuContent(menu) {
    const container =
      menu.position === "left"
        ? this.leftMenuContainer
        : this.rightMenuContainer;
    if (container) {
      container.innerHTML = "";
      const content = menu.render();
      container.appendChild(content);
    }
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
