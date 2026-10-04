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
  }

  init() {
    if (this.isInitialized) return;

    addEvent("click", this.onClick);
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

    const activeFile = this.editor.tabManager.activeFile;
    if (activeFile) this.editor.highlightController?.openFile(activeFile);

    if (this.editor.tabManager.files.length === 0) this.editor.reset();
    this.editor.refreshAll();
    this.editor.titleBar?.refresh();
  }

  // DOM Event
  onClick(e) {
    const el = e.target;
    const cl = e.target.classList;

    // ------- Editor.js ------
    this.editor.onClick(e);

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

  onContextMenu(event) {
    const target = event.target;
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

      if (this.editor.lineController) {
        this.editor.lineController.resize();
      }

      if (this.editor.scrollerManager) {
        this.editor.scrollerManager.refreshAll();
      }
    });
  }

  onWindowFocus() {
    this.editor.tabManager.scheduleFocusResync();
  }

  onVisibilityChange() {
    if (document.visibilityState === "visible")
      this.editor.tabManager.scheduleFocusResync();
  }
}
