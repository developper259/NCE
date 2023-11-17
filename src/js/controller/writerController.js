class WriterController {
  constructor(e) {
    this.editor = e;
    this.separator = [" ", "=", "\\+", "-", "/", "\\*"];

    this.splitWord = (txt) => {
      let oldChar = "";
      let tableSplit = [];
      for (let char of txt) {
        if (char === '"' && oldChar !== "\\") {
          tableSplit.push(char);
          tableSplit.push("");
        } else {
          if (this.separator.includes(char)) {
            tableSplit.push(char);
            tableSplit.push("");
          } else {
            if (
              !tableSplit.length ||
              typeof tableSplit[tableSplit.length - 1] !== "string"
            ) {
              tableSplit.push(char);
            } else {
              tableSplit[tableSplit.length - 1] += char;
            }
          }
        }
        oldChar = char;
      }

      return tableSplit;
    };

    this.toHTML = (txt) => {
      let result =
        '<div class="line editor-select">' +
        '<span class="editor-el">$value</span>' +
        "</div>";

      let resultWords = "";

      let words = this.splitWord(txt);

      for (let word of words) {
        if (word == " ") resultWords += " ";
        else {
          if (word != "") resultWords += `<span class="line-word editor-select">${word}</span>`;
        }
      }

      return result.replace("$value", resultWords);
    };
  }
}
