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
      for (const [container, position] of [
        [this.leftMenuContainer, "left"],
        [this.rightMenuContainer, "right"],
      ]) {
        container?.addEventListener("contextmenu", (event) => {
          const title = event.target.closest?.(".sidebar-main-title");
          if (!title || !container.contains(title)) return;
          const menu = this.getActiveMenuForPosition(position);
          if (!menu) return;
          event.preventDefault();
          event.stopPropagation();
          this.editor.contextMenuManager?.openContextMenu(
            "sidebar-title",
            { menuId: menu.id },
          );
        });
      }
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
    this.leftScroller?.destroy();
    this.leftScroller = null;
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

  openMenu(menuId, { restoring = false } = {}) {
    const menu = this.menus.get(menuId);
    if (!menu) return;

    const currentActive = this.getActiveMenuForPosition(menu.position);
    if (currentActive && currentActive.id !== menuId) {
      currentActive.close();
    }

    menu.open({ restoring });
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

    return this.editor.domManager.getSidebarWidth(position) || this.width;
  }

  getMainSectionWidth() {
    const section = this.editor.domManager.getElement(".main-section");
    const measuredWidth = section?.clientWidth ||
      section?.getBoundingClientRect?.().width ||
      this.editor.domManager.window?.width ||
      0;
    return Math.max(0, measuredWidth);
  }

  getSidebarWidthBudget() {
    return Math.max(
      0,
      this.getMainSectionWidth() -
        this.selectorWidth -
        SidebarManager.MIN_EDITOR_CONTENT_WIDTH,
    );
  }

  getMaxSidebarWidth(position) {
    if (position !== "left" && position !== "right") return 0;
    const oppositePosition = position === "left" ? "right" : "left";
    const oppositeWidth = this.getOpenSidebarWidth(oppositePosition);
    const configuredMaximum = this.editor.sidebarResizer?.maxWidth ?? Infinity;
    return Math.max(
      0,
      Math.min(
        configuredMaximum,
        this.getSidebarWidthBudget() - oppositeWidth,
      ),
    );
  }

  clampSidebarWidth(width, position) {
    const resizer = this.editor.sidebarResizer;
    const configuredMinimum = resizer?.minWidth ?? 0;
    const maximum = this.getMaxSidebarWidth(position);
    const minimum = Math.min(configuredMinimum, maximum);
    const requested = Number.isFinite(Number(width)) ? Number(width) : minimum;
    return Math.max(minimum, Math.min(maximum, requested));
  }

  getEffectiveSidebarWidths(resizedPosition = null) {
    const leftOpen = this.leftSidebar?.classList.contains("open") === true;
    const rightOpen = this.rightSidebar?.classList.contains("open") === true;
    const resizer = this.editor.sidebarResizer;
    const leftRequested = resizer?.getRequestedWidth("left") ?? this.width;
    const rightRequested = resizer?.getRequestedWidth("right") ?? this.width;

    if (resizedPosition === "left" && leftOpen) {
      return {
        left: this.clampSidebarWidth(leftRequested, "left"),
        right: rightOpen ? this.getOpenSidebarWidth("right") : 0,
      };
    }
    if (resizedPosition === "right" && rightOpen) {
      return {
        left: leftOpen ? this.getOpenSidebarWidth("left") : 0,
        right: this.clampSidebarWidth(rightRequested, "right"),
      };
    }

    if (!leftOpen && !rightOpen) return { left: 0, right: 0 };

    const budget = this.getSidebarWidthBudget();
    const minimum = resizer?.minWidth ?? 0;
    const maximum = resizer?.maxWidth ?? Infinity;
    const requestedLeft = leftOpen
      ? Math.max(minimum, Math.min(maximum, leftRequested))
      : 0;
    const requestedRight = rightOpen
      ? Math.max(minimum, Math.min(maximum, rightRequested))
      : 0;

    if (!leftOpen) {
      return {
        left: 0,
        right: this.clampSidebarWidth(requestedRight, "right"),
      };
    }
    if (!rightOpen) {
      return {
        left: this.clampSidebarWidth(requestedLeft, "left"),
        right: 0,
      };
    }

    if (requestedLeft + requestedRight <= budget) {
      return { left: requestedLeft, right: requestedRight };
    }

    if (budget < minimum * 2) {
      const requestedTotal = requestedLeft + requestedRight;
      return {
        left: requestedTotal > 0 ? (budget * requestedLeft) / requestedTotal : 0,
        right: requestedTotal > 0 ? (budget * requestedRight) / requestedTotal : 0,
      };
    }

    const extraBudget = budget - minimum * 2;
    const leftExtra = requestedLeft - minimum;
    const rightExtra = requestedRight - minimum;
    const requestedExtra = leftExtra + rightExtra;
    if (requestedExtra <= 0) return { left: minimum, right: minimum };

    return {
      left: minimum + (extraBudget * leftExtra) / requestedExtra,
      right: minimum + (extraBudget * rightExtra) / requestedExtra,
    };
  }

  syncEditorLayout(resizedPosition = null) {
    const effectiveWidths = this.getEffectiveSidebarWidths(resizedPosition);
    let widthsChanged = false;
    for (const [position, width] of Object.entries(effectiveWidths)) {
      if (!this.editor.sidebarResizer) continue;
      const sidebar = position === "left" ? this.leftSidebar : this.rightSidebar;
      if (!sidebar?.classList.contains("open")) continue;
      widthsChanged = this.editor.sidebarResizer.setEffectiveWidth(
        position,
        width,
      ) || widthsChanged;
    }
    if (widthsChanged) {
      this.editor.sidebarResizer?.updateResizerPositions?.();
    }

    const leftWidth = this.getOpenSidebarWidth("left");
    const rightWidth = this.getOpenSidebarWidth("right");
    const leftOffset = this.selectorWidth + leftWidth;

    if (this.editor.fileManagerOBJ) {
      this.editor.fileManagerOBJ.style.left = `${leftOffset}px`;
      this.editor.fileManagerOBJ.style.right = `${rightWidth}px`;
      this.editor.fileManagerOBJ.style.width = "";
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

    return widthsChanged;
  }

  scheduleSidebarRefresh(position = null) {
    requestAnimationFrame(() => {
      this.editor.lineController.resizeWidth();
      this.editor.tabManager?.tabScroller?.refresh();
      if (position === "left" || position === "right") {
        const scroller = position === "left"
          ? this.leftScroller
          : this.rightScroller;
        scroller?.refresh();
      } else {
        this.leftScroller?.refresh();
        this.rightScroller?.refresh();
      }
    });
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

    this.editor.domManager.invalidateSidebarMetrics(position);
    this.syncEditorLayout();

    if (this.editor.sidebarResizer) {
      this.editor.sidebarResizer.updateResizerVisibility();
    }

    this.scheduleSidebarRefresh(position);
  }

  closeSidebar(position) {
    if (position === "left" && this.leftSidebar) {
      this.editor.fileExplorer?.virtualScroller?.suspend();
      this.leftSidebar.classList.remove("open");
      this.editor.domManager
        .getElement(".main-section")
        .classList.remove("sidebar-left-open");
    } else if (position === "right" && this.rightSidebar) {
      this.rightSidebar.classList.remove("open");
    }

    this.editor.domManager.invalidateSidebarMetrics(position);
    this.syncEditorLayout();

    if (this.editor.sidebarResizer) {
      this.editor.sidebarResizer.updateResizerVisibility();
    }

    this.scheduleSidebarRefresh(position);
  }

  renderMenuContent(menu) {
    const container =
      menu.position === "left"
        ? this.leftMenuContainer
        : this.rightMenuContainer;
    if (container) {
      if (menu.position === "left") {
        const explorerActive = menu.id === "file-explorer";
        container.classList.toggle("file-explorer-mode", explorerActive);
        if (explorerActive) {
          container.scrollTop = 0;
          this.leftScroller?.suspend();
        } else {
          this.editor.fileExplorer?.virtualScroller?.suspend();
          this.leftScroller?.resume();
        }
      }
      const content = menu.render();

      if (content instanceof Node) {
        if (
          content.parentNode !== container ||
          container.childNodes?.length !== 1 ||
          container.firstChild !== content
        ) {
          container.replaceChildren(content);
        }
      } else {
        container.innerHTML = content;
      }
      if (menu.position === "left" && menu.id === "file-explorer") {
        this.editor.fileExplorer?.virtualScroller?.attach(
          this.editor.fileExplorer.treeViewport,
          this.editor.fileExplorer.treeLayer,
        );
        this.editor.fileExplorer?.virtualScroller?.resume();
      }
    }
  }

  refreshAll({ renderActiveMenu = true } = {}) {
    this.renderTabSelector();

    if (renderActiveMenu && this.activeMenu)
      this.renderMenuContent(this.activeMenu);
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

SidebarManager.MIN_EDITOR_CONTENT_WIDTH = 300;
