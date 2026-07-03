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
  static CURSOR_MOVE = 'cursormove';
  static CURSOR_CHANGE = 'cursorChange';
  static CURSOR_DISABLED = 'cursorDisabled';
  static CURSOR_ENABLED = 'cursorEnabled';
  static ON_SELECT = 'onSelect';
  static ON_CHANGE = 'onChange';
  static ON_WRITE = 'onWrite';

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
      case Events.ON_WRITE:
        this.onWrite(arg);
        break;
      default:
        console.error("Event " + e + " not found !");
        return;
    }
    this.onEvent(arg);
  }
  // Custom Event
  cursorMove(arg) {

  }
  cursorChange(arg) {

  }
  cursorDisabled(arg) {
    // ------- SelectController.js ------
    this.editor.selectController.refreshSelectionDOM();
  }
  cursorEnabled(arg) {
    // ------- SelectController.js ------
    this.editor.selectController.refreshSelectionDOM();
  }
  onSelect(arg) {
  }
  onChange(arg) {
    // ------- File.js ------
    if (this.editor.tabManager.activeFile) this.editor.tabManager.activeFile.onChange();

    // ------- LanguageController.js ------
    //this.editor.languageController.onChange();

    // ------- KeyBinding.js ------
    this.editor.keyBinding.onChange();
  }
  onWrite(arg) {

  }
  onEvent(arg) {
    // ------- BottomBar.js ------
    this.editor.bottomBar.refresh();
  }

  // DOM Event
  onClick(e) {
    const el = e.target;
    const cl = e.target.classList;

    // ------- editor.js ------
    this.editor.onClick(e);

    // ------- Command.js ------
    if (this.editor.panel) this.editor.panel.mouseClick(e);

    if (cl.contains('command-el')) {
      this.editor.command.onClickEl(e);
      return;
    }

    // ------- LineController.js ------
    if (cl.contains('line-el')) {
      this.editor.lineController.onClickNumberLine(e);
      return;
    }
    
    // ------- tabManager.js ------
    if (cl.contains('file-el') || cl.contains('file-el-title')) {
      this.editor.tabManager.onClick(e);
      return;
    }
    if (cl.contains('file-el-btn') || cl.contains('file-el-btn-img')) {
      this.editor.tabManager.onClickClose(e);
      return;
    }

    // ------- BottomBar.js ------

    if (cl.contains('scroller-open') || cl.contains('scroller-title')) {
      let id = el.id;
      if (!id) id = el.parentElement.id;
      this.editor.bottomBar.scrollersValue[id].instance.active();
      return;
    }
    
  }
  onResize(e) {
    this.editor.scrollerManager.refreshAll();
    this.editor.lineController.refresh();
  }
}