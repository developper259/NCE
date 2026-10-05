addEvent = (event, f, obj) => {
  if (obj == null || obj == undefined) obj = document;
  if (Array.isArray(obj)) {
    for (let o of obj) {
      o.addEventListener(event, f);
    }
  } else obj.addEventListener(event, f);
};

addInterval = (f, time) => {
  return setInterval(f, time);
};

class Events {
  static CURSOR_MOVE = "cursormove";
  static CURSOR_CHANGE = "cursorChange";
  static CURSOR_DISABLED = "cursorDisabled";
  static CURSOR_ENABLED = "cursorEnabled";
  static ON_SELECT = "onSelect";
  static ON_CHANGE = "onChange";
  static ON_SAVE = "onSave";
  static ON_OPEN_FILE = "onOpen";
  static ON_CLOSE_FILE = "onClose";
  static ON_OPEN_PROJECT = "onOpenProject";
  static ON_CLOSE_PROJECT = "onCloseProject";
  static ON_LOADED = "onLoaded";

  constructor(editor) {
    this.editor = editor;

    this.isInitialized = false;
    this.onClick = this.onClick.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onWindowFocus = this.onWindowFocus.bind(this);
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
    this.onInput = this.onInput.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onPointerOver = this.onPointerOver.bind(this);
    this.onPointerOut = this.onPointerOut.bind(this);
    this.onCompositionStart = this.onCompositionStart.bind(this);
    this.onCompositionEnd = this.onCompositionEnd.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
  }

  init() {
    if (this.isInitialized) return;

    addEvent("click", this.onClick);
    addEvent("input", this.onInput);
    addEvent("pointerover", this.onPointerOver);
    addEvent("pointerout", this.onPointerOut);
    document.addEventListener("keydown", this.onKeyDown, true);
    addEvent("compositionstart", this.onCompositionStart);
    addEvent("compositionend", this.onCompositionEnd);
    document.addEventListener("contextmenu", this.onContextMenu, true);
    addEvent("resize", this.onResize, window);
    addEvent("focus", this.onWindowFocus, window);
    addEvent("visibilitychange", this.onVisibilityChange);
    this.isInitialized = true;
  }

  callEvent(e, arg) {
    if (this.editor.isOnInit && e !== Events.ON_LOADED) return;
    switch (e) {
      case Events.CURSOR_MOVE:
        this.cursorMove(arg);
        break;
      case Events.CURSOR_CHANGE:
        this.cursorChange(arg);
        break;
      case Events.CURSOR_DISABLED:
        this.cursorDisabled(arg);
        break;
      case Events.CURSOR_ENABLED:
        this.cursorEnabled(arg);
        break;
      case Events.ON_SELECT:
        this.onSelect(arg);
        break;
      case Events.ON_CHANGE:
        this.onChange(arg);
        break;
      case Events.ON_SAVE:
        this.onSave(arg);
        break;
      case Events.ON_OPEN_FILE:
        this.onOpenFile(arg);
        break;
      case Events.ON_CLOSE_FILE:
        this.onCloseFile(arg);
        break;
      case Events.ON_OPEN_PROJECT:
        this.onOpenProject(arg);
        break;
      case Events.ON_CLOSE_PROJECT:
        this.onCloseProject(arg);
        break;
      case Events.ON_LOADED:
        this.onLoaded(arg);
        break;
      default:
        console.error("Event " + e + " not found !");
        return;
    }
    this.onEvent(arg);
  }
  // Custom Event
  cursorMove(arg) {}
  cursorChange(arg) {}
  cursorDisabled(arg) {}
  cursorEnabled(arg) {}
  onSelect(arg) {}
  onChange(arg) {
    this.editor.highlightController?.handleChange(arg);
    // ------- LineController  ------
    this.editor.lineController.recalculatePersistentDiff();
    // ------- SearchController.js ------
    this.editor.searchController.refresh();
    // ------- File.js ------
    if (this.editor.tabManager.activeFile)
      this.editor.tabManager.activeFile.onChange();
    this.editor.titleBar?.refresh();
  }
  onEvent(arg) {
    // ------- BottomBar.js ------
    this.editor.bottomBar.refresh();
  }
  onSave(arg) {
    this.editor.statesManager.save();
    this.editor.titleBar?.refresh();
  }
  onOpenFile(arg) {
    const file = arg?.activeFile || this.editor.tabManager.activeFile;
    if (file) this.editor.highlightController?.openFile(file);
    this.editor.statesManager.save();
    this.editor.titleBar?.refresh();
  }
  onCloseFile(arg) {
    if (arg?.file) this.editor.highlightController?.closeFile(arg.file);
    else this.editor.highlightController?.closeAllFiles();
    this.editor.statesManager.save();
    this.editor.titleBar?.refresh();
  }
  onOpenProject(arg) {
    this.editor.titleBar?.refresh();
  }
  onCloseProject(arg) {
    this.editor.titleBar?.refresh();
  }
  onLoaded(arg) {
    this.editor.isOnInit = false;
    this.editor.commitStartupState();
  }

  // DOM Event
  onClick(e) {
    if (this.editor.quickPanel?.handleItemClick?.(e)) return;

    const el = e.target;
    const cl = e.target.classList;

    const searchControl = el.closest?.(
      ".search-bar-previous, .search-bar-next, .search-bar-close, .search-bar-expand, .search-bar-replace-next, .search-bar-replace-all",
    );
    if (searchControl) {
      const search = this.editor.searchController;
      const searchClasses = searchControl.classList;
      if (searchClasses.contains("search-bar-previous")) search.onPreviousClick();
      else if (searchClasses.contains("search-bar-next")) search.onNextClick();
      else if (searchClasses.contains("search-bar-close")) search.onCloseClick();
      else if (searchClasses.contains("search-bar-expand")) search.toggleReplace();
      else if (searchClasses.contains("search-bar-replace-next")) search.replaceNext();
      else if (searchClasses.contains("search-bar-replace-all")) search.replaceAll();
    }

    // ------- Editor.js ------
    this.editor.onClick(e);
    this.editor.quickPanel?.handleBackdropClick?.(e);

    // ------- LineController.js ------
    if (cl.contains("line-el")) {
      this.editor.lineController.onClickNumberLine(e);
      return;
    }

    // ------- TabManager.js ------
    if (cl.contains("file-el") || cl.contains("file-el-title")) {
      this.editor.tabManager.onClick(e);
      return;
    }
    if (cl.contains("file-el-btn") || cl.contains("file-el-btn-img")) {
      this.editor.tabManager.onClickClose(e);
      return;
    }

    // ------- BottomBar.js ------

    const scroller = el.closest?.(".scroller-open, .scroller-title");
    if (scroller) {
      const id = scroller.id || scroller.parentElement?.id;
      if (id === "config-space") this.editor.bottomBar.openConfigSpace();
      if (id === "language") this.editor.bottomBar.openLanguage();
      if (id === "view-type") this.editor.bottomBar.openViewTypePicker();
      return;
    }
  }

  onInput(event) {
    if (this.editor.quickPanel?.handleInputEvent?.(event)) return;

    const search = this.editor.searchController;
    if (event.target === search.input) {
      search.onInput();
    } else if (event.target === search.replaceInput) {
      search.saveActiveTabState();
    }
  }

  onPointerOver(event) {
    this.editor.quickPanel?.handleItemPointerOverEvent?.(event);
  }

  onPointerOut(event) {
    this.editor.quickPanel?.handleItemPointerOutEvent?.(event);
  }

  onContextMenu(event) {
    const target = event.target;
    if (this.editor.quickPanel?.handleContextMenu?.(event)) return;

    const input = target.closest?.(
      "input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color']):not([type='file']), textarea, select, [contenteditable='true'], [contenteditable='']",
    );
    if (input) {
      event.preventDefault();
      event.stopPropagation();
      this.editor.contextMenuManager?.openContextMenu("input", input);
      return;
    }

    const tabElement = target.closest?.(".file-manager .file-el");
    if (tabElement) {
      if (this.editor.tabManager.onContextMenu(tabElement)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (!target.closest?.(".editor-output")) return;

    event.preventDefault();
    event.stopPropagation();
    const file = this.editor.tabManager.activeFile;
    const hasSelection =
      this.editor.selectController.hasActiveSelection?.() === true;
    this.editor.contextMenuManager?.openContextMenu("output", {
      isFile: Boolean(file),
      file,
      filePath: file?.hasPath?.() ? file.path : "",
      rootPath: this.editor.fileExplorer?.rootPath || "",
      selectedText: hasSelection
        ? String(
            this.editor.selectController.getSelectedText?.() ||
              this.editor.selectController.containsSelected ||
              "",
          )
        : "",
    });
  }

  onResize(e) {
    requestAnimationFrame(() => {
      if (this.editor.domManager) {
        this.editor.domManager.resize();
      }

      if (this.editor.sidebarManager?.syncEditorLayout()) {
        this.editor.sidebarManager.scheduleSidebarRefresh();
      }

      if (this.editor.lineController) {
        this.editor.lineController.resize();
      }

      if (this.editor.scrollerManager) {
        this.editor.scrollerManager.refreshAll();
      }
      this.editor.quickPanel?.resultsScroller?.refresh();
    });
  }

  onWindowFocus() {
    this.editor.tabManager.scheduleFocusResync();
  }

  onKeyDown(event) {
    if (this.editor.quickPanel?.handleKeyDownEvent?.(event)) return;
    this.editor.keyBindingManager?.onKey(event);
  }

  onCompositionStart(event) {
    this.editor.keyBindingManager?.onCompositionStart(event);
  }

  onCompositionEnd(event) {
    this.editor.keyBindingManager?.onCompositionEnd(event);
  }

  onVisibilityChange() {
    if (document.visibilityState === "visible")
      this.editor.tabManager.scheduleFocusResync();
  }
}
