class KeyBinding {
  constructor(e) {
    this.editor = e;
    this.recentCommandIds = this.loadRecentCommandIds();
    this.fileActions = new Set([
      "save",
      "save_as",
      "go_to_line",
      "copy",
      "paste",
      "cut",
      "undo",
      "redo",
      "find",
      "delete_line",
      "select_all",
      "unselect_all",
    ]);

    this.func = {
      save: this.control_save,
      save_as: this.control_save_as,
      open_file: this.control_open_file,
      quick_open: this.control_quick_open,
      go_to_line: this.control_go_to_line,
      open_folder: this.control_open_folder,
      new_file: this.control_new_file,
      new_window: this.control_new_window,
      open_folder_in_new_window: this.control_open_folder_in_new_window,
      close_window: this.control_close_window,
      new_terminal: this.control_new_terminal,
      kill_terminal: this.control_kill_terminal,
      kill_all_terminals: this.control_kill_all_terminals,
      close_file: this.control_close_file,
      close_all_file: this.control_close_all_file,
      next_tab: this.control_next_tab,
      previous_tab: this.control_previous_tab,
      copy: this.control_copy,
      paste: this.control_paste,
      cut: this.control_cut,
      undo: this.control_undo,
      redo: this.control_redo,
      find: this.control_find,
      open_command: this.control_open_command,
      open_settings: this.control_open_settings,
      quit_app: this.control_quit_app,
      reload_window: this.control_reload_window,
      delete_line: this.control_delete_line,
      select_all: this.control_select_all,

      toggle_file_explorer: this.control_toggle_file_explorer,
      toggle_search: this.control_toggle_search,
      toggle_agent: this.control_toggle_agent,
      toggle_terminal: this.control_toggle_terminal,

      Escape: this.key_escape,
      Tab: this.key_tab,
      Delete: this.key_delete,
      Backspace: this.key_backspace,
      Enter: this.key_enter,
      ArrowUp: this.key_arrow_up,
      ArrowDown: this.key_arrow_down,
      ArrowLeft: this.key_arrow_left,
      ArrowRight: this.key_arrow_right,
      Home: this.key_home,
      End: this.key_end,
      Insert: this.key_insert,
    };
  }

  isActionEnabled(action) {
    const tabManager = this.editor.tabManager || {};
    const tabs = Array.isArray(tabManager.tabs) ? tabManager.tabs : [];

    if (action === "close_file") {
      return Boolean(
        tabManager.activeTab && tabs.includes(tabManager.activeTab),
      );
    }
    if (action === "close_all_file") return tabs.length > 0;
    if (action === "next_tab" || action === "previous_tab")
      return tabManager.canCycleTabs === true;
    if (this.fileActions.has(action)) return Boolean(tabManager.activeFile);
    return true;
  }

  exec(key, e) {
    if (!this.isActionEnabled(key?.action)) return;

    let s = false;
    let c = false;
    let m = false;
    let a = false;

    if (e != undefined) {
      s = e.shiftKey;
      c = e.ctrlKey;
      m = e.metaKey;
      a = e.altKey;
    }
    if (this.func[key.action]) {
      this.func[key.action].call(this, s, c, m, a);
    } else if (this.func[key.key]) {
      this.func[key.key].call(this, s, c, m, a);
    }
  }

  // --- Control functions ---

  async control_save(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    await this.editor.tabManager.activeFile.save();
  }

  async control_save_as() {
    if (!this.editor.tabManager.activeFile) return;
    await this.editor.tabManager.activeFile.saveAs();
  }

  async control_open_file(s, c, m, a) {
    const file = await this.editor.tabManager.selectFiles();
    this.editor.tabManager.openFiles(file);
  }

  control_quick_open() {
    return this.editor.quickOpen?.open();
  }

  control_go_to_line() {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.goToLine?.open();
  }

  async control_open_folder(s, c, m, a) {
    await this.editor.fileExplorer.selectFolder();
    this.editor.sidebarManager.openMenu("file-explorer");
  }

  control_new_file(s, c, m, a) {
    this.editor.tabManager.createEmptyFile();
  }

  control_new_window() {
    return this.editor.api.appCommand("window.new");
  }

  control_open_folder_in_new_window() {
    return this.editor.api.appCommand("window.openFolderInNew");
  }

  control_close_window() {
    return this.editor.api.closeWindow?.();
  }

  async control_new_terminal() {
    const manager = this.editor.bottomPanelManager;
    if (!manager) return false;
    const savedTabs = this.editor.terminalPanel?.getPersistedState?.(
      manager.workspaceKey,
    )?.tabs || manager.getPanelState?.().terminal?.tabs || [];
    const hadTerminalTabs = savedTabs.length > 0;
    if (!(await manager.openPanel("terminal"))) return false;

    const terminalPanel = this.editor.terminalPanel;
    if (!terminalPanel) return false;
    if (hadTerminalTabs || !terminalPanel.getActiveSession?.())
      return terminalPanel.createTerminal?.() || false;
    return true;
  }

  control_kill_terminal() {
    const terminalPanel = this.editor.terminalPanel;
    const session = terminalPanel?.getActiveSession?.();
    if (!session) return false;
    return terminalPanel.closeSession?.(session.id) || false;
  }

  control_kill_all_terminals() {
    const terminalPanel = this.editor.terminalPanel;
    if (!terminalPanel?.getActiveSession?.()) return false;
    return terminalPanel.closeAllSessions?.() || false;
  }

  async control_close_file(s, c, m, a) {
    if (!this.isActionEnabled("close_file")) return false;
    return this.editor.tabManager.closeActiveFile();
  }

  async control_close_all_file(s, c, m, a) {
    if (!this.isActionEnabled("close_all_file")) return false;
    return this.editor.tabManager.closeFiles();
  }

  control_next_tab() {
    return this.editor.tabManager.cycleTab(1);
  }

  control_previous_tab() {
    return this.editor.tabManager.cycleTab(-1);
  }

  async control_copy(s, c, m, a) {
    if (!document.hasFocus()) return;
    if (!this.editor.tabManager.activeFile) return;

    let txt = this.editor.selectController.getSelectedText?.() || "";

    if (!txt) {
      const lineNode =
        this.editor.lineController.lines[this.editor.cursorController.row - 1];
      txt = lineNode ? lineNode.getText() : "";
    }
    try {
      await navigator.clipboard.writeText(txt);
    } catch (err) {
      console.error("Erreur lors de la copie : ", err);
    }
  }

  async control_paste(s, c, m, a) {
    if (!document.hasFocus()) return;
    if (!this.editor.tabManager.activeFile) return;
    try {
      const text = await navigator.clipboard.readText();
      const handled = this.editor.smartTypingController?.handlePaste(text);
      if (!handled) this.editor.writerController.write(text);
    } catch (err) {
      console.error("Erreur lors du collage : ", err);
    }
  }

  async control_cut(s, c, m, a) {
    if (!document.hasFocus()) return;
    if (!this.editor.tabManager.activeFile) return;

    let hasSelection = this.editor.selectController.hasActiveSelection?.();
    await this.control_copy();

    if (hasSelection) {
      this.key_backspace();
    } else {
      const row = this.editor.cursorController.row;
      const lines = this.editor.lineController.lines;
      const end =
        row < lines.length
          ? { row: row + 1, column: 0 }
          : { row, column: lines[row - 1].getText().length };
      this.editor.writerController.deleteRange({ row, column: 0 }, end);
    }
  }

  control_undo(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.historyController?.undo();
  }

  control_redo(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.historyController?.redo();
  }

  control_find(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    this.editor.searchController.toggle({ useSelection: true });
  }
  control_replace(s, c, m, a) {}

  control_open_command(s, c, m, a) {
    const quickPanel = this.editor.quickPanel;
    if (!quickPanel) return;
    if (quickPanel.isOpen("command-palette")) {
      quickPanel.close();
      return;
    }

    const settings = typeof SettingsView === "undefined"
      ? this.editor.settingsView?.getSettings?.() || []
      : SettingsView.getSettings();
    const settingCategories = [...new Set(settings.map(
      (setting) => setting.category,
    ))].map((category) => ({
      id: `open-settings-${category.toLowerCase()}`,
      label: `Open ${category} Settings (UI)`,
      keywords: ["settings", category],
      data: { settingsCategory: category },
    }));
    settingCategories.unshift({
      id: "open-settings-json",
      label: "Open Settings (JSON)",
      keywords: ["settings", "json", "configuration"],
      data: { settingsJson: true },
    });
    settingCategories.unshift({
      id: "select-color-theme",
      label: "Select Color Theme",
      keywords: ["theme", "appearance", "color"],
      data: { themePicker: true },
    });
    const developerItems = [{
      id: "developer-performance",
      label: "Developer: Performance",
      keywords: ["developer", "performance", "metrics", "dashboard"],
      data: { performanceDashboard: true },
    }];

    const activeTab = this.editor.tabManager.activeTab;
    const viewTypeActions = Boolean(
      (typeof PictureView !== "undefined"
        ? PictureView.isPreviewablePath(activeTab?.path || "")
        : this.editor._pictureView?.isPreviewablePath?.(activeTab?.path || "")) ||
      (typeof FileType !== "undefined" &&
        FileType.isMarkdownPath(activeTab?.path || "")),
    )
      ? [{
          id: "change-view-type",
          label: "Change View Type",
          keywords: ["image", "markdown", "preview", "text", "editor", "view"],
          data: { viewTypePicker: true },
        }]
      : [];

    const shortcutItems = USERCONFIG_KEYBINDING.filter(
      (item) =>
        item.action !== "open_command" &&
        item.action !== "escape" &&
        item.in_editor === false &&
        this.isActionEnabled(item.action),
    ).map((item) => ({
      id: item.action,
      label: this.getActionLabel(item.action),
      shortcut: CONFIG_KEYBINDING_DISPLAY(item.key),
      data: item,
    }));
    const allActions = settingCategories.concat(developerItems, viewTypeActions, shortcutItems);
    const recentlyUsedItems = this.recentCommandIds
      .map((id) => allActions.find((item) => item.id === id))
      .filter(Boolean)
      .map((item) => ({
        ...item,
        id: `recent:${item.id}`,
        recentCommandId: item.id,
        section: "Recently Used",
      }));
    const items = recentlyUsedItems.concat(
      allActions.map((item, index) => ({
        ...item,
        separatorBefore: index === 0 && recentlyUsedItems.length > 0,
      })),
    );

    quickPanel.open({
      id: "command-palette",
      mode: "pick",
      title: "Command Palette",
      placeholder: "Type a command",
      deferAcceptUntilClose: true,
      transitionDuration: 100,
      items,
      emptyItem: (query) => {
        const value = String(query || "").trim();
        return value
          ? {
              id: "ask-agent",
              label: `Ask to Agent: "${value}"`,
              data: { askAgent: value },
            }
          : null;
      },
      onAccept: (item) => this.executeCommandItem(item),
    });
  }

  control_open_settings() {
    return this.editor.openSettings();
  }

  control_quit_app() {
    return this.editor.api.quit();
  }

  async control_reload_window() {
    if (this.editor.isOnInit !== false) return false;
    if (!(await this.editor.tabManager.prepareForQuit())) return false;
    const saved = await this.editor.statesManager.save();
    if (saved === false) return false;
    const recoveryCleared = await this.editor.statesManager
      .clearRecoverySnapshotsOnQuit?.();
    if (recoveryCleared === false) return false;
    return this.editor.api.appCommand("view.reload");
  }

  executeCommandItem(item) {
    if (item?.id && !item?.data?.askAgent)
      this.rememberCommand(item.recentCommandId || item.id);
    if (item?.data?.askAgent) {
      this.editor.sidebarManager?.openMenu?.("agent");
      return this.editor.agentSidebar?.sendMessage?.(item.data.askAgent);
    }
    if (item?.data?.themePicker) {
      return this.editor.themeManager?.openThemePicker();
    }
    if (item?.data?.viewTypePicker) {
      return this.editor.bottomBar?.openViewTypePicker();
    }
    if (item?.data?.settingsJson) {
      return this.editor.openSettingsJson?.();
    }
    if (item?.data?.performanceDashboard) {
      return this.editor.openPerformanceDashboard?.();
    }
    if (item?.data?.settingsCategory) {
      return this.editor.openSettings(item.data.settingsCategory);
    }
    const keybinding = item?.data || item;
    if (!keybinding?.action) return;
    this.editor.keyBinding.exec(keybinding);
  }

  loadRecentCommandIds() {
    try {
      const stored = JSON.parse(localStorage.getItem("nce.quickPanel.recentCommands") || "[]");
      return Array.isArray(stored) ? stored.filter((id) => typeof id === "string").slice(0, 3) : [];
    } catch {
      return [];
    }
  }

  rememberCommand(id) {
    this.recentCommandIds = [id, ...this.recentCommandIds.filter((recentId) => recentId !== id)].slice(0, 3);
    try {
      localStorage.setItem("nce.quickPanel.recentCommands", JSON.stringify(this.recentCommandIds));
    } catch {}
  }

  getActionLabel(action) {
    if (action === "open_settings") return "Open Settings (UI)";
    return action
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  control_delete_line(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;

    const row = this.editor.cursorController.row;
    const endRow = Math.min(row + 1, this.editor.lineController.lines.length);
    this.editor.writerController.deleteRange(
      { row, column: 0 },
      { row: endRow, column: 0 },
    );
  }

  control_select_all(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;

    this.editor.selectController.selectAll(true);
  }

  control_toggle_file_explorer(s, c, m, a) {
    if (this.editor.sidebarManager) {
      this.editor.sidebarManager.toggleMenu("file-explorer");
    }
  }

  control_toggle_search(s, c, m, a) {
    if (this.editor.sidebarManager) {
      this.editor.sidebarManager.toggleMenu("search");
    }
  }

  control_toggle_agent(s, c, m, a) {
    if (this.editor.sidebarManager) {
      this.editor.sidebarManager.toggleMenu("agent");
    }
  }

  control_toggle_terminal(s, c, m, a) {
    void this.editor.bottomPanelManager?.togglePanel("terminal");
  }

  // --- Key functions ---

  key_escape(s, c, m, a) {
    const openAgentSelectors = document.querySelectorAll(
      ".agent-sidebar-model-menu:not(.hidden)",
    );
    if (openAgentSelectors.length > 0) {
      openAgentSelectors.forEach((menu) => menu.classList.add("hidden"));
      return;
    }

    if (this.editor.searchController.isOpen) {
      this.editor.searchController.close();
      return;
    }

    if (this.editor.quickPanel?.isOpen()) {
      this.editor.quickPanel.close();
      return;
    }

    this.editor.selectController.unSelectAll();
  }

  key_tab(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (
      this.editor.smartTypingController?.handleTab(s, {
        ctrlKey: c,
        metaKey: m,
        altKey: a,
      })
    ) {
      return;
    }

    this.editor.writerController.write(
      " ".repeat(SETTINGS_GET("editor.tabWidth")),
    );
  }

  realToView(lineNode, column) {
    const text = lineNode?.getText?.() || "";
    const index = lineNode?.getPositionIndex?.();
    return index ? index.realToVisual(column) : realColumnToViewColumn(text, column);
  }

  viewToReal(lineNode, column) {
    const text = lineNode?.getText?.() || "";
    const index = lineNode?.getPositionIndex?.();
    return index ? index.visualToReal(column) : viewColumnToRealColumn(text, column);
  }

  key_delete(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;

    this.editor.tabManager.activeFile.historyX = undefined;
    const lc = this.editor.lineController;
    let x = this.editor.cursorController.column;
    let y = this.editor.cursorController.row;

    let cursor;

    if (this.editor.selectController.hasActiveSelection?.()) {
      cursor = this.editor.writerController.deleteSelection();
    } else if (!m && !a) {
      const lineNode = lc.lines[y - 1];
      const l = lineNode ? lineNode.getText() : "";

      let start, end;
      if (x < l.length) {
        start = { row: y, column: x };
        end = {
          row: y,
          column:
            typeof nextGraphemeBoundary === "function"
              ? (lineNode?.getPositionIndex?.()?.next(x) ?? nextGraphemeBoundary(l, x))
              : x + 1,
        };
      } else if (y < lc.lines.length) {
        start = { row: y, column: x };
        end = { row: y + 1, column: 0 };
      } else {
        return;
      }

      cursor = this.editor.writerController.deleteRange(start, end);
    } else {
      return;
    }

    if (cursor) {
      lc.refresh();
      this.editor.cursorController.setCursorPosition(cursor.row, cursor.column);
    }
  }

  key_backspace(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;

    this.editor.tabManager.activeFile.historyX = undefined;
    const lc = this.editor.lineController;
    let x = this.editor.cursorController.column;
    let y = this.editor.cursorController.row;

    let cursor;

    if (this.editor.selectController.hasActiveSelection?.()) {
      cursor = this.editor.writerController.deleteSelection();
    } else if (!m && !a) {
      if (
        !c &&
        this.editor.smartTypingController?.handleBackspace({
          ctrlKey: c,
          metaKey: m,
          altKey: a,
        })
      ) {
        return;
      }

      if (c) {
        if (x == 0 && y == 1) return;
        cursor = this.editor.writerController.deleteWord
          ? this.editor.writerController.deleteWord(x, y)
          : null;
      } else {
        if (x == 0 && y == 1) return;

        let start, end;
        if (x > 0) {
          const line = lc.lines[y - 1]?.getText() || "";
          start = {
            row: y,
            column:
              typeof previousGraphemeBoundary === "function"
                ? (lc.lines[y - 1]?.getPositionIndex?.()?.previous(x) ?? previousGraphemeBoundary(line, x))
                : x - 1,
          };
          end = { row: y, column: x };
        } else {
          const prevLineNode = lc.lines[y - 2];
          const prevLen = prevLineNode ? prevLineNode.getText().length : 0;
          start = { row: y - 1, column: prevLen };
          end = { row: y, column: 0 };
        }

        cursor = this.editor.writerController.deleteRange(start, end);
      }
    } else {
      return;
    }

    if (cursor) {
      lc.refresh();
      const screenRow = lc.getDisplayIndexForCursor(cursor.row) - lc.startIndex;
      if (screenRow <= lc.marginLines) {
        const targetRow = Math.max(0, lc.startIndex - 1);
        lc.scrollTo(targetRow);
      }
      this.editor.cursorController.setCursorPosition(cursor.row, cursor.column);
    }
  }

  key_enter(s, c, m, a) {
    if (
      this.editor.smartTypingController?.handleEnter({
        ctrlKey: c,
        metaKey: m,
        altKey: a,
      })
    ) {
      return;
    }

    this.editor.writerController.write("\n");
  }

  key_arrow_up(s, c, m, a) {
    if (this.editor.tabManager.activeFile) {
      if (this.editor.lineController.lines.length == 0) return;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.hasActiveSelection?.()) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.hasActiveSelection?.()) {
        this.editor.selectController.unSelectAll();
      }

      if (this.editor.tabManager.activeFile.historyX == undefined)
        this.editor.tabManager.activeFile.historyX = this.realToView(
          this.editor.lineController.lines[y - 1], x,
        );

      if (y == 1) {
        if (this.editor.tabManager.activeFile.historyX != 0)
          this.editor.tabManager.activeFile.historyX = 0;
        else {
          this.editor.selectController.isMouseDown = false;
          return;
        }
      } else y -= 1;

      this.editor.cursorController.setCursorPosition(
        y,
        this.viewToReal(this.editor.lineController.lines[y - 1], this.editor.tabManager.activeFile.historyX),
      );

      const lc = this.editor.lineController;
      const screenRow = lc.getDisplayIndexForCursor(y) - lc.startIndex;
      if (screenRow <= lc.marginLines) {
        const targetRow = Math.max(0, lc.startIndex - 1);
        lc.scrollTo(targetRow);
      }

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_arrow_down(s, c, m, a) {
    if (this.editor.tabManager.activeFile) {
      if (this.editor.lineController.lines.length == 0) return;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.hasActiveSelection?.()) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.hasActiveSelection?.()) {
        this.editor.selectController.unSelectAll();
      }

      if (this.editor.tabManager.activeFile.historyX == undefined)
        this.editor.tabManager.activeFile.historyX = this.realToView(
          this.editor.lineController.lines[y - 1], x,
        );

      if (y == this.editor.lineController.lines.length) {
        const lineNode = this.editor.lineController.lines[y - 1];
        const lineLength = lineNode ? lineNode.getText().length : 0;
        const visualLength = this.realToView(lineNode, lineLength);
        if (this.editor.tabManager.activeFile.historyX != visualLength)
          this.editor.tabManager.activeFile.historyX = visualLength;
        else {
          this.editor.selectController.isMouseDown = false;
          return;
        }
      } else y += 1;

      this.editor.cursorController.setCursorPosition(
        y,
        this.viewToReal(this.editor.lineController.lines[y - 1], this.editor.tabManager.activeFile.historyX),
      );

      const lc = this.editor.lineController;
      const screenRow = lc.getDisplayIndexForCursor(y) - lc.startIndex;
      if (screenRow >= lc.maxLines - lc.marginLines) {
        const targetRow = lc.startIndex + 1;
        lc.scrollTo(targetRow);
      }

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_arrow_left(s, c, m, a) {
    const lc = this.editor.lineController;
    if (this.editor.tabManager.activeFile) {
      if (lc.lines.length == 0) return;
      this.editor.tabManager.activeFile.historyX = undefined;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.hasActiveSelection?.()) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.hasActiveSelection?.()) {
        this.editor.selectController.unSelectAll();
      }

      if (y == 1 && x == 0) return;

      const lineNode = lc.lines[y - 1];

      if (a) {
        const l = lineNode ? lineNode.getText() : "";
        x = this.editor.writerController.getPreviousWordBoundary(lineNode || l, x);
      } else if (m) {
        this.key_home(s, c, m, a);
        return;
      } else {
        if (x == 0) {
          y -= 1;
          const prevLineNode = lc.lines[y - 1];
          x = prevLineNode ? prevLineNode.getText().length : 0;
        } else {
          const currentLine = lc.lines[y - 1];
          x = currentLine?.getPositionIndex?.()?.previous(x) ?? previousGraphemeBoundary(currentLine ? currentLine.getText() : "", x);
        }
      }

      this.editor.cursorController.setCursorPosition(y, x);

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_arrow_right(s, c, m, a) {
    const lc = this.editor.lineController;
    if (this.editor.tabManager.activeFile) {
      if (lc.lines.length == 0) return;
      this.editor.tabManager.activeFile.historyX = undefined;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.hasActiveSelection?.()) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.hasActiveSelection?.()) {
        this.editor.selectController.unSelectAll();
      }

      const lineNode = lc.lines[y - 1];
      const lineLength = lineNode ? lineNode.getText().length : 0;

      if (y == lc.lines.length && x == lineLength) return;

      if (c || a) {
        x = this.editor.writerController.getNextWordBoundary(lineNode || "", x);
        if (x === lineLength && y < lc.lines.length) {
          y += 1;
          x = 0;
        }
      } else {
        if (x == lineLength) {
          y += 1;
          x = 0;
        } else {
          x = lineNode?.getPositionIndex?.()?.next(x) ?? nextGraphemeBoundary(lineNode ? lineNode.getText() : "", x);
        }
      }

      this.editor.cursorController.setCursorPosition(y, x);

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_home(s, c, m, a) {
    if (this.editor.lineController.lines.length == 0) return;
    if (
      this.editor.smartTypingController?.handleHome(s, {
        ctrlKey: c,
        metaKey: m,
        altKey: a,
      })
    ) {
      return;
    }
    let y = this.editor.cursorController.row;
    this.editor.cursorController.setCursorPosition(y, 0);
  }

  key_end(s, c, m, a) {
    if (this.editor.lineController.lines.length == 0) return;
    let y = this.editor.cursorController.row;
    const lineNode =
      this.editor.lineController.lines[this.editor.cursorController.row - 1];
    let x = lineNode ? lineNode.getText().length : 0;
    this.editor.cursorController.setCursorPosition(y, x);
  }

  key_insert(s, c, m, a) {
    let wc = this.editor.writerController;
    wc.insertMode = !wc.insertMode;
  }
}
