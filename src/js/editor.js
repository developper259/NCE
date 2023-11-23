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

class Editor {
  constructor() {
    this.output = document.querySelector(".editor-output");
    this.lineController = new lineController(this);
    this.writerController = new WriterController(this);
    this.selectController = new SelectController(this);
    this.cursor = new Cursor(this);
    this.selected = false;

    addEvent("click", this.onClick.bind(this), document);
  }
  onClick(e) {
    const t = e.target;
    const c = t.classList;
    if (c.contains("editor-select") || c.contains("editor-el"))
      this.selected = true;
    else {
      this.selected = false;
      this.lineController.setFocusLine(0);
    }
  }
}

var editor = null;

window.addEventListener("load", (event) => {
  editor = new Editor();
});
