class HighlightController {
  constructor(editor) {
    this.editor = editor;
    this.workerPath = "../js/worker/highlight.worker.js";

    this.pendingRequests = new Map();

    this.lineNodes = new Map();
    this.dirtyLines = new Set();
    this.isProcessingDirty = false;

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

  initLineNode() {
    this.editor.output.childNodes.forEach((node) => {
      const lineNumber = parseInt(node.dataset.line, 10);
      this.lineNodes.set(lineNumber, node);
    });
  }

  setLineNode(lineNumber, node) {
    this.lineNodes.set(lineNumber, node);
  }

  getLineNode(lineNumber) {
    return this.lineNodes.get(lineNumber);
  }

  markDirty(lineNumber) {
    this.dirtyLines.add(lineNumber);
  }

  markDirtyAll(onlyUnHighlight=false) {
    if (
      !this.editor.lineController.lines ||
      this.editor.lineController.lines.length === 0
    )
      return;
    if (onlyUnHighlight) {
      for (const node of this.lineNodes.values()) {
        if (!node.dataset.isHighlight || node.dataset.isHighlight === 'false') 
          this.markDirty(parseInt(node.dataset.line, 10));
      }
    }else {
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
    const end = Math.min(
      this.editor.lineController.lines.length,
      this.editor.lineController.startIndex +
        this.editor.lineController.maxViewLines,
    );
    for (let i = start; i < end; i++) {
      this.dirtyLines.add(i);
    }
  }

  async refresh() {
    if (this.isProcessingDirty || this.dirtyLines.size === 0) return;

    const language = this.editor.tabManager.activeFile?.language || "plaintext";

    if (language === "plaintext") {
      this.dirtyLines.clear();
      return;
    }

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

        return { lineNumber, tokens: result?.tokens };
      });

      const results = await Promise.all(promises);

      for (const res of results) {
        if (res && res.tokens) {
          this.applyHighlightToLine(res.lineNumber, res.tokens);
        }
      }
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

    let i = 0;
    let a = 0;
    let maxA = 0;
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
    if (!this.cachedLines) this.cachedLines = [];
    this.cachedLines[lineNumber] = tokens;

    lineNode.dataset.isHighlight = true;
  }
}
