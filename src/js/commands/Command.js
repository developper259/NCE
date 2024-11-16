class Command {
  constructor(e) {
    this.editor = e;
    this.isActive = false;
    this.instance = getElement(".command");

    this.top = getElement(".command-els-top");
    this.all = getElement(".command-els");

    this.init = (trees) => {
      let tree = { top: [], all: [] };
      for (let el of trees.top) {
        let elTree = this.createTree(el);
        tree.top.push(elTree);
      }
      for (let el of trees.all) {
        let elTree = this.createTree(el);
        tree.all.push(elTree);
      }
      this.load(tree);
    };
    this.createTree = (dic) => {
      // {"title": "HTML", "author": ["recently used"]}
      let author = "";
      for (let el of dic.author) {
        author += `<span class="command-info-txt">${el}</span>\n`;
      }

      return `<div class="command-el">
                  <span class="command-el-title">${dic.title}</span>
                  <div class="command-el-author">
                    ${author}
                  </div>
                </div>`;
    };
    this.load = (dic) => {
      // {"top": [tree, tree], "all": [tree]}
      this.top.innerHTML = "";
      this.all.innerHTML = "";
      for (let el of dic.top) {
        this.top.innerHTML += el;
      }
      for (let el of dic.all) {
        this.all.innerHTML += el;
      }
      for (let el of getElements(".command-el")) {
        el.addEventListener("click", () => {
          let title = el.childNodes[1].innerText;
          this.onSelect(title);
        });
      }
    };
    this.generateDicAll = (table) => {
      let dic = [];
      for (let el of table) {
        dic.push({ title: el, author: [] });
      }
      return dic;
    };
    this.mouseClick = (event) => {
      let objSelectedC = event.srcElement.classList;
      for (let c of objSelectedC) {
        //on vérifi si une des classes contiens le mot command
        let t = c.split("-");
        if (
          !t.includes("command") &&
          !t.includes("scroller") &&
          !t.includes("bottomBar")
        ) {
          if (this.isActive) this.close();
        }
      }
    };
    this.open = () => {
      this.instance.style.display = "flex";
      this.isActive = true;
      this.editor.panel = this;
    };
    this.close = () => {
      this.instance.style.display = "none";
      this.isActive = false;
      this.editor.panel = undefined;
    };
    this.active = () => {
      if (this.isActive) this.close();
      else this.open();
    };

    this.onSelect = (title) => {};
    addEvent("click", this.mouseClick);
  }
}
