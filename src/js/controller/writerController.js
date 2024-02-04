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
  }
}
