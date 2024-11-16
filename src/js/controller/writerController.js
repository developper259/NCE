class WriterController {
  constructor(e) {
    this.editor = e;
    this.separator = [
      " ",
      "!",
      '"',
      "#",
      "$",
      "%",
      "&",
      "'",
      "(",
      ")",
      "*",
      "+",
      ",",
      "-",
      ".",
      "/",
      ":",
      ";",
      "<",
      "=",
      ">",
      "?",
      "@",
      "[",
      "]",
      "^",
      "_",
      "`",
      "{",
      "|",
      "}",
      "~",
    ];

    this.splitWord = (txt) => {
      let oldChar = "";
      let tableSplit = [];
      for (let char of txt) {
        if (this.separator.includes(char)) {
          if (this.separator.includes(oldChar)) {
            tableSplit[tableSplit.length - 1] += char;
          } else {
            tableSplit.push("");
            tableSplit.push(char);
          }
        } else {
          if (
            !tableSplit.length ||
            typeof tableSplit[tableSplit.length - 1] !== "string"
          ) {
            tableSplit.push(char);
          } else {
            if (this.separator.includes(oldChar)) tableSplit.push("");
            tableSplit[tableSplit.length - 1] += char;
          }
        }
        oldChar = char;
      }

      tableSplit = tableSplit.filter(function (chaine) {
        return chaine.length !== 0;
      });

      return tableSplit;
    };

    this.toHTML = (txt) => {
      let result = '<div class="line editor-select">$value</div>';

      let resultWords = "";

      let words = this.splitWord(txt);

      for (let word of words) {
        if (word != "") {
          let classes = "line-word editor-select";
          resultWords += `<span class="${classes}">${word}</span>`;
        }
      }

      return result.replace("$value", resultWords);
    };

    this.write = (txt) => {
      let x = this.editor.cursor.column;
      let y = this.editor.cursor.row - 1;
      
      let line = this.editor.lineController.lines[y];

      txt = txt.replace('\t', ' '.repeat(CONFIG_GET('tab_width')));


      if (!txt.includes("\n")) {
        let newLine = line.slice(0, x) + txt + line.slice(x);
        this.editor.lineController.changeLine(newLine, y);
        this.editor.cursor.setCursorPosition(y + 1, x + txt.length);
      }else{
        let newLines = txt.split("\n");

        for (let i = 0; i < newLines.length; i++) {
          let newLine = newLines[i];
          if (i == 0) {
            newLine = line.slice(0, x) + newLine;
            this.editor.lineController.changeLine(newLine, y);
          }else if (i == newLines.length - 1) {
            newLine = newLine + line.slice(x, line.length);
            this.editor.lineController.addLine(newLine, y + i);
          }else{
            this.editor.lineController.addLine(newLine, y + i);
          }
        }
        this.editor.cursor.setCursorPosition(y + newLines.length, 0);
      }
    };
  }
}


