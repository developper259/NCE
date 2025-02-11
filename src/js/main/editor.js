roundY = (nb) => {
  var r = nb;
  while (nb > 1) {
    nb--;
  }
  r -= nb;
  if (nb >= 0.65) nb = 1;
  else nb = 0;

  return r + nb;
};

roundX = (nb) => {
  if (nb < 0) return -1;
  if (nb < 1) return 0;
  var r = nb;
  while (nb > 1) {
    nb--;
  }
  r -= nb;
  if (nb >= 0.65) nb = 1;
  else nb = 0;

  return r + nb;
};

getElement = (str) => {
  return document.querySelector(str);
};

getElements = (str) => {
  return nodeToArray(document.querySelectorAll(str));
};

nodeToArray = (node) => {
  let r = [];

  for (let n of node) {
    r.push(n);
  }

  return r;
};

getOccurrence = (c, str) => {
  return str.split(c).length - 1;
};

createElement = (html) => {
  const parser = new DOMParser();
  let doc = parser.parseFromString(html, "text/html");
  return doc.createRange().createContextualFragment(doc.body.innerHTML)
    .firstElementChild;
};

class Editor {
  constructor() {
    this.output = getElement(".editor-output");

    this.selected = false;
    this.panel = undefined;

    const lineN = getElement(".line-numbers");

    this.baseX = 50; // left margin (2 represents the difference left margin)
    this.baseY = 2; // top margin
    this.posY = 23; // size of a line
    this.letterSize = 10.8; // size of leter     (fs : 20 -> 12, fs : 18 -> 10.8)

    this.languages = [new PlainText(this), new Javascript(this)];

    this.api = window.api;

    this.fileManager = new FileManager(this);
    this.scrollerManager = new ScrollerManager(this);

    this.writerController = new WriterController(this);
    this.lineController = new LineController(this);
    this.selectController = new SelectController(this);
    this.keyBindingController = new keyBindingController(this);
    this.languageController = new LanguageController(this);

    this.keyBinding = new KeyBinding(this);
    this.cursor = new Cursor(this);

    this.command = new Command(this);
    this.Ccmd = new CMD(this);
    this.Clangague = new Langague(this);
    this.Cconfig_space = new Config_space(this);
    this.bottomBar = new BottomBar(this);

    this.writerController.insertMode = true;

    addEvent("click", this.onClick.bind(this), document);
  }

  refreshAll() {
    this.scrollerManager.refreshAll();
    this.bottomBar.refresh();
    this.lineController.refresh();
    this.selectController.refreshStartEndSelect();
    this.fileManager.refresh();
    if (this.fileManager.activeFile)
      this.fileManager.activeFile.language.refreshAll();
  }

  onClick(e) {
    const t = e.target;
    const c = t.classList;
    if (
      c.contains("editor-select") ||
      c.contains("editor-el") ||
      c.contains("editor")
    ) {
      this.setSelected(true);
    } else {
      if (c.contains("command-el") || c.contains("command-el-title")) return;
      this.setSelected(false);
    }
  }

  setSelected(selected) {
    if (this.selected == selected) return;

    if (selected) CALLEVENT("cursorenabled");
    else CALLEVENT("cursordisabled");
    this.selected = selected;
  }
}

var editor = null;

window.addEventListener("load", (event) => {
  editor = new Editor();
});
