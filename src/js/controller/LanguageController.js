class LanguageController {
  constructor(e) {
    this.editor = e;

    this.name = "";
    this.extension = "";
    this.icon = "";
    this.data = {};

    this.colors = {
      variable: "#9CDCFE", // Bleu clair pour les variables
      function: "#DCDCAA", // Jaune pour les fonctions
      string: "#CE9178", // Marron clair pour les chaînes de caractères
      keyword: "#C586C0", // Violet pour les mots-clés
      specialKeyword: "#569CD6", // Bleu vif pour les caractères spéciaux
      specialLetter: "#C586C0", // Jaune vif pour les caractères spéciaux
      separator: "#D4D4D4", // Gris clair pour les séparateurs
      comment: "#6A9955", // Vert pour les commentaires
      number: "#B5CEA8", // Vert clair pour les nombres
      error: "#F44747", // Rouge pour les erreurs
      all: "#9CDCFE",
      none: "", // Aucune couleur définie
    };

    addEvent("onChange", this.onChange.bind(this), this.editor.output);
  }

  detectVariables(words, index) {}
  detectFunctions(words, index) {}
  detectStrings(words, index) {}
  detectComments(words, index) {}
  detectError(words, index) {}

  onChange(event) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.language.refreshAll();
  }

  getLanaguage(file) {
    const ext = file.name.split(".").pop();
    const languages = this.editor.languages;

    for (let i = 0; i < languages.length; i++) {
      if (languages[i].extension == ext) {
        return languages[i];
      }
    }
    return new Javascript(this.editor);
  }

  getType(words, index, params) {
    let txt = words[index];
    for (let type in this.data) {
      if (this.data[type]) {
        if (Array.isArray(this.data[type])) {
          for (let j = 0; j < this.data[type].length; j++) {
            const t = this.data[type][j].toLowerCase();
            if (txt.toLowerCase() === t) {
              return { type: type, params: {} };
            }
          }
        } else if (typeof this.data[type] == "function") {
          const r = this.data[type](words, index, params);
          if (r && r.value) {
            return { type: type, params: r.params };
          }
        }
      }
    }
    return null;
  }

  getColor(type) {
    const color = this.colors[type] || this.colors.all;

    return color;
  }

  refreshLine(row, p) {
    const line = this.editor.lineController.lines[row - 1];
    if (line == null) return;

    const words = [];
    const wordsStr = [];
    const ws = this.editor.lineController.getWordsOBJ(row);
    const wsStr = this.editor.writerController.splitWord(line);

    if (!ws || !wsStr) return;

    for (let i = 0; i < wsStr.length; i++) {
      if (
        wsStr[i] &&
        wsStr[i] != " " &&
        wsStr[i] != "\t" &&
        wsStr[i].length > 0
      ) {
        words.push(ws[i]);
        wordsStr.push(wsStr[i]);
      }
    }
    if (!words || words.length == 0) return {};

    let params = p;

    for (let i = 0; i < words.length; i++) {
      const type = this.getType(wordsStr, i, params);
      if (type && words[i]) {
        const color = this.getColor(type.type);
        words[i].style.color = color;
        params = type.params;
      } else {
        if (words[i]) words[i].style.color = this.colors.none;
        params = {};
      }
    }
    return params;
  }

  refreshAll() {
    let r = { value: undefined, params: {} };
    for (let i = 1; i <= this.editor.lineController.maxIndex; i++) {
      r = this.refreshLine(i, r);

      if (r) r.inLine = false;
    }
  }
}
