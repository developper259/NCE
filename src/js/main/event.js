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
        console.log(Events.ON_CHANGE);
        console.error("Event " + e + " not found !");
        return;
    }
    this.onEvent(arg);
  }

  cursorMove(arg) {

  }
  cursorChange(arg) {

  }
  cursorDisabled(arg) {
    // ------- SelectController.js ------
    this.editor.selectController.cursorDisabled();
    this.editor.selectController.cursorEnabled();
  }
  cursorEnabled(arg) {

  }
  onSelect(arg) {
    // ------- SelectController.js ------
    this.editor.selectController.refreshStartEndSelect();
  }
  onChange(arg) {
    // ------- File.js ------
    if (this.editor.fileManager.activeFile) this.editor.fileManager.activeFile.onChange();

    // ------- LanguageController.js ------
    this.editor.languageController.onChange();

    // ------- KeyBinding.js ------
    this.editor.keyBinding.onChange();
  }
  onWrite(arg) {
  }

  onEvent(arg) {
    // ------- BottomBar.js ------
    this.editor.bottomBar.refresh();
  }
}