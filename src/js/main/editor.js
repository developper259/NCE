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
  return document.querySelectorAll(str);
};

class Editor {
  constructor() {
    this.output = document.querySelector(".editor-output");
    this.lineController = new lineController(this);
    this.writerController = new WriterController(this);
    this.selectController = new SelectController(this);
    this.cursor = new Cursor(this);
    this.command = new Command(this);
    this.Clangague = new Langague(this);
    this.bottomBar = new BottomBar(this);
    this.selected = false;

    this.cursor.setCursorPosition(1, 0);

    addEvent("click", this.onClick.bind(this), document);
  }
  onClick(e) {
    const t = e.target;
    const c = t.classList;
    if (c.contains("editor-select") || c.contains("editor-el")) {
      this.selected = true;
      document.dispatchEvent(new CustomEvent("cursorenabled"));
    } else {
      this.selected = false;
      this.lineController.setFocusLine(0);
      document.dispatchEvent(new CustomEvent("cursordisabled"));
    }
  }
}

var editor = null;

window.addEventListener("load", (event) => {
  editor = new Editor();
});
