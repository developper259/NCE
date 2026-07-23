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

  constructor(editor) {
    this.editor = editor;

    addEvent("click", this.onClick.bind(this));
    addEvent("resize", this.onResize.bind(this), window);
  }

  callEvent(e, arg) {
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
      default:
        console.error("Event " + e + " not found !");
        return;
    }
    this.onEvent(arg);
  }
  // Custom Event
  cursorMove(arg) {}
  cursorChange(arg) {}
  cursorDisabled(arg) {
    // ------- SelectController.js ------
    this.editor.selectController.refreshSelectionDOM();
  }
  cursorEnabled(arg) {
    // ------- SelectController.js ------
    this.editor.selectController.refreshSelectionDOM();
  }
  onSelect(arg) {}
  onChange(arg) {
    // ------- File.js ------
    if (this.editor.tabManager.activeFile)
      this.editor.tabManager.activeFile.onChange();
  }
  onEvent(arg) {
    // ------- BottomBar.js ------
    this.editor.bottomBar.refresh();
  }
  onSave(arg) {
    this.editor.statesManager.save();
  }
  onOpenFile(arg) {
    this.editor.statesManager.save();
  }
  onCloseFile(arg) {
    this.editor.statesManager.save();
  }
  onOpenProject(arg) {
    this.editor.statesManager.save();
  }
  onCloseProject(arg) {
    this.editor.statesManager.save();
  }

  // DOM Event
  onClick(e) {
    const el = e.target;
    const cl = e.target.classList;

    // ------- Editor.js ------
    this.editor.onClick(e);

    // ------- Command.js ------
    if (this.editor.panel) this.editor.panel.mouseClick(e);

    if (cl.contains("command-el")) {
      this.editor.command.onClickEl(e);
      return;
    }

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

    if (cl.contains("scroller-open") || cl.contains("scroller-title")) {
      let id = el.id;
      if (!id) id = el.parentElement.id;
      this.editor.bottomBar.scrollersValue[id].instance.active();
      return;
    }
  }
  onResize(e) {
    requestAnimationFrame(() => {
      this.editor.lineController.resize();

      this.editor.scrollerManager.refreshAll();
    });
  }
}
