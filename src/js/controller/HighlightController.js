class HighlightController {
  constructor(editor) {
    this.editor = editor;
    this.workerPath = "../js/worker/highlight.worker.js";

    this.pendingRequests = new Map();

    this.lineNodes = new Map();
    this.dirtyLines = new Set();
    this.isProcessingDirty = false;

    this.maxLength = 1000;
    this.marginHighlight = 100;

    this.classValue = [
      "nsh-keyword",
      "nsh-string",
      "nsh-number",
      "nsh-comment",
      "nsh-function",
      "nsh-variable",
      "nsh-operator",
      "nsh-bracket",
    ];

    this.supportedLanguage = null;
  }

  getId() {
    return Date.now().toString() + Math.random().toString(36).substring(2, 9);
  }

  async highlight(text, language, includeClasses = true) {
    try {
      const response = await this.editor.threadManager.executeTask(
        this.workerPath,
        "highlight",
        {
          requestType: "highlight",
          code: text,
          language: language,
          responseType: "tokens",
          options: {
            theme: "dark",
            lineNumbers: false,
            language: language,
            includeClasses: includeClasses,
          },
        },
      );

      if (response && response.tokens) {
        return response.tokens;
      }
      return [];
    } catch (error) {
      console.error("Erreur lors de la coloration syntaxique :", error);
      return [];
    }
  }

  async getSupportedLanguage() {
    if (this.supportedLanguage) return this.supportedLanguage;

    try {
      const response = await this.editor.threadManager.executeTask(
        this.workerPath,
        "supportedLanguages",
        {
          id: this.getId(),
          requestType: "supportedLanguages",
        },
      );

      if (response && response.languages) {
        this.supportedLanguage = response.languages;
        return this.supportedLanguage;
      }
      return [];
    } catch (error) {
      console.error(
        "Erreur lors de la récupération des langages supportés :",
        error,
      );
      return [];
    }
  }

  async detectLanguage(fileName) {
    try {
      const response = await this.editor.threadManager.executeTask(
        this.workerPath,
        "detectLanguage",
        { fileName: fileName },
      );

      return response?.language || "plaintext";
    } catch (error) {
      console.error("Erreur lors de la détection du langage :", error);
      return "plaintext";
    }
  }

  splitValidWord(tokenValue) {
    return this.editor.writerController
      .splitWord(tokenValue || "")
      .filter((w) => w && w !== " ");
  }

  getStartTokenDetails(tokens, offsetX) {
    if (!tokens || tokens.length === 0) {
      return { i: 0, a: 0, maxA: 0 };
    }

    let i = 0;
    for (const token of tokens) {
      if (
        offsetX === token.column - 1 ||
        (tokens.length - 1 > i && offsetX < tokens[i + 1].column - 1)
      ) {
        break;
      }
      i++;
    }

    if (i >= tokens.length) {
      i = tokens.length - 1;
    }

    const validWords = this.splitValidWord(tokens[i].value || "");
    let maxA = validWords.length;

    let b = tokens[i].column - 1;
    let a = 0;

    for (const el of validWords) {
      const isSpace = !el || el === " ";

      if (offsetX < b + el.length) {
        break;
      }

      b += el.length;

      if (!isSpace) {
        a++;
      }
    }

    if (a >= maxA && i < tokens.length - 1) {
      i++;
      a = 0;
      maxA = validWords.length;
    }

    return { i, a, maxA };
  }

  refreshLineNode() {
    this.editor.output.childNodes.forEach((node) => {
      const lineNumber = parseInt(node.dataset.line, 10);
      const screenRow = lineNumber - this.editor.lineController.startIndex;
      this.lineNodes.set(screenRow, node);
    });
  }

  setLineNode(lineNumber, node) {
    const screenRow = lineNumber - this.editor.lineController.startIndex;
    this.lineNodes.set(screenRow, node);
  }

  getLineNode(lineNumber) {
    const screenRow = lineNumber - this.editor.lineController.startIndex;
    return this.lineNodes.get(screenRow);
  }

  markDirty(lineNumber) {
    if (
      lineNumber > this.editor.lineController.lines.length ||
      this.dirtyLines.has(lineNumber)
    )
      return;
    this.dirtyLines.add(lineNumber);
  }

  markDirtyAll(onlyUnHighlight = false) {
    if (
      !this.editor.lineController.lines ||
      this.editor.lineController.lines.length === 0
    )
      return;
    if (onlyUnHighlight) {
      let l = 0;
      for (const node of this.lineNodes.values()) {
        l = parseInt(node.dataset.line, 10);
        const lineNode = this.editor.lineController.lines[l];
        if (!lineNode || !lineNode.isHighlight) this.markDirty(l);
      }
      for (let i = 1; i < this.marginHighlight + 1; i++) {
        const lineNode = this.editor.lineController.lines[l + i];
        if (
          !lineNode ||
          (!lineNode.getTokens() &&
            this.editor.lineController.getLineLength(l + 1) > 0)
        )
          this.markDirty(l + i);
      }
    } else {
      this.markDirtyFrom(0);
    }
  }

  markDirtyFrom(dataIndex) {
    if (
      !this.editor.lineController.lines ||
      this.editor.lineController.lines.length === 0
    )
      return;

    const start = Math.max(dataIndex, this.editor.lineController.startIndex);
    let end = Math.min(
      this.editor.lineController.lines.length,
      this.editor.lineController.startIndex +
        this.editor.lineController.maxViewLines,
    );

    end = Math.min(
      this.editor.lineController.lines.length,
      end + this.marginHighlight,
    );

    for (let i = 0; i < this.marginHighlight; i++) {
      const lineNode = this.editor.lineController.lines[end + i];
      if (
        !lineNode ||
        (!lineNode.getTokens() &&
          this.editor.lineController.getLineLength(end + i + 1) > 0)
      )
        this.dirtyLines.add(end + i);
    }
  }

  async refresh() {
    if (this.isProcessingDirty || this.dirtyLines.size === 0) return;

    const language = this.editor.tabManager.activeFile?.language || "plaintext";
    if (language === "plaintext") {
      return;
    }

    this.isProcessingDirty = true;

    try {
      const linesToProcess = [...this.dirtyLines];
      this.dirtyLines.clear();
      const promises = linesToProcess.map(async (lineNumber) => {
        const lineNode = this.editor.lineController.lines[lineNumber];
        const lineText = lineNode ? lineNode.getText() : "";
        if (
          !language ||
          language === "plaintext" ||
          lineText === undefined ||
          lineText === null ||
          lineText.trim() === ""
        ) {
          return null;
        }

        if (lineText.length >= this.maxLength) return null;

        const result = await this.editor.threadManager.executeTask(
          this.workerPath,
          "highlight",
          {
            requestType: "highlight",
            code: lineText,
            language: language,
            responseType: "tokens",
            options: {
              theme: "dark",
              lineNumbers: false,
              language: language,
              includeClasses: true,
            },
          },
        );

        if (result && result.tokens) {
          lineNode.setTokens(result.tokens);
          lineNode.setHighlighted(true);
          this.applyHighlightToLine(lineNumber, result.tokens);
        }
      });

      await Promise.all(promises);
    } catch (error) {
      console.error("Erreur lors du refresh :", error);
    } finally {
      this.isProcessingDirty = false;
      if (this.dirtyLines.size > 0) {
        this.refresh();
      }
    }
  }

  applyHighlightToLine(lineNumber, tokens) {
    const lineNode = this.getLineNode(lineNumber);

    if (!lineNode) return;

    const wordNodes = lineNode.children;

    if (!wordNodes || wordNodes.length === 0) return;

    if (!tokens || tokens.length === 0) return;

    let { i, a, maxA } = this.getStartTokenDetails(
      tokens,
      this.editor.lineController.offsetX,
    );
    for (const node of wordNodes) {
      const token = tokens[i];

      if (!node.textContent || node.textContent === " ") continue;

      if (token) {
        if (token.type) {
          node.classList.remove(...this.classValue);
          node.classList.add(token.type);
        }
      }

      if (token) {
        maxA = this.splitValidWord(token.value).length;
      }
      a++;

      if (a === maxA) {
        i++;
        maxA = 0;
        a = 0;
      }
    }

    this.dirtyLines.delete(lineNumber);
  }
}
