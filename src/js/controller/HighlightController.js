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

  get cachedLines() {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.tabManager.activeFile?.cachedLines;
  }

  set cachedLines(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.cachedLines = value;
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

    const getValidWords = (tokenValue) => {
      return this.editor.writerController
        .splitWord(tokenValue || "")
        .filter((w) => w && w !== " ");
    };

    const rawWords = this.editor.writerController.splitWord(
      tokens[i].value || "",
    );
    let maxA = getValidWords(tokens[i].value).length;

    let b = tokens[i].column - 1;
    let a = 0;

    for (const el of rawWords) {
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
      maxA = getValidWords(tokens[i].value).length;
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
        if (!node.dataset.isHighlight || node.dataset.isHighlight === "false")
          this.markDirty(l);
      }
      for (let i = 1; i < this.marginHighlight + 1; i++) {
        if (
          !this.cachedLines.has(l + i) &&
          this.editor.lineController.getLineLength(l + 1) > 0
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

    for (let i = start; i < end; i++) {
      if (
        !this.cachedLines.has(l + i) &&
        this.editor.lineController.getLineLength(l + 1) > 0
      )
        this.dirtyLines.add(i);
    }
  }

  async refresh() {
    if (this.isProcessingDirty || this.dirtyLines.size === 0) return;

    const language = this.editor.tabManager.activeFile?.language || "plaintext";
    if (language === "plaintext") {
      return;
    }

    if (!this.cachedLines) this.cachedLines = new Map();

    this.isProcessingDirty = true;

    try {
      const linesToProcess = [...this.dirtyLines];
      this.dirtyLines.clear();
      const promises = linesToProcess.map(async (lineNumber) => {
        const lineText = this.editor.lineController.lines[lineNumber];
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
          this.applyHighlightToLine(lineNumber, result.tokens);
          this.cachedLines.set(lineNumber, result.tokens);
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
        maxA = this.editor.writerController.splitWord(token.value).length;
      }
      a++;

      if (a === maxA) {
        i++;
        maxA = 0;
        a = 0;
      }
    }

    this.dirtyLines.delete(lineNumber);

    lineNode.dataset.isHighlight = true;
  }
}
