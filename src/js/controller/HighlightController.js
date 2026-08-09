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
      .filter((w) => w && w !== " " && w !== "\t");
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
      for (const lineNode of this.editor.lineController.lines) {
        lineNode.setState(null);
      }
      this.markDirtyFrom(0);
    }
  }

  getInitialState(lineNumber) {
    const prevLineNode = this.editor.lineController.lines[lineNumber - 1];
    return (prevLineNode && prevLineNode.getState()) || ["root"];
  }

  statesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  propagateState(lineNumber, finalState) {
    const lineNode = this.editor.lineController.lines[lineNumber];
    if (!lineNode) return;

    const previousState = lineNode.getState();
    lineNode.setState(finalState);

    const nextLineExists =
      lineNumber + 1 <= this.editor.lineController.lines.length;

    if (nextLineExists && !this.statesEqual(previousState, finalState)) {
      this.markDirty(lineNumber + 1);
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
      const linesToProcess = [...this.dirtyLines].sort((a, b) => a - b);
      this.dirtyLines.clear();

      for (const lineNumber of linesToProcess) {
        const lineNode = this.editor.lineController.lines[lineNumber];
        const lineText = lineNode ? lineNode.getText() : "";
        const initialState = this.getInitialState(lineNumber);

        if (lineText === undefined || lineText === null) {
          continue;
        }

        if (lineText.trim() === "") {
          this.propagateState(lineNumber, initialState);
          continue;
        }

        if (lineText.length >= this.maxLength) {
          this.propagateState(lineNumber, lineNode.getState() || initialState);
          continue;
        }

        try {
          const result = await this.editor.threadManager.executeTask(
            this.workerPath,
            "highlightLine",
            {
              requestType: "highlightLine",
              code: lineText,
              language: language,
              initialState: initialState,
              lineIndex: lineNumber,
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

          this.propagateState(
            lineNumber,
            (result && result.finalState) || initialState,
          );
        } catch (error) {
          console.error(
            `Erreur lors du highlight de la ligne ${lineNumber} :`,
            error,
          );
          this.propagateState(lineNumber, initialState);
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

    tokens = tokens || [];

    let position = this.editor.lineController.offsetX || 0;
    let i = 0;

    while (
      i < tokens.length &&
      tokens[i].column - 1 + tokens[i].value.length <= position
    ) {
      i++;
    }

    for (const node of wordNodes) {
      const text = node.textContent || "";
      const length = text.length;

      if (!text || text.replaceAll(" ", "").length === 0 || text === "\t") {
        position += length;
        continue;
      }

      while (
        i < tokens.length &&
        tokens[i].column - 1 + tokens[i].value.length <= position
      ) {
        i++;
      }

      const token = tokens[i];
      const tokenStart = token ? token.column - 1 : -1;
      const tokenEnd = token ? tokenStart + token.value.length : -1;
      const belongsToToken =
        !!token && position >= tokenStart && position < tokenEnd;

      node.classList.remove(...this.classValue);
      if (belongsToToken && token.type) {
        node.classList.add(token.type);
      }

      position += length;
    }

    this.dirtyLines.delete(lineNumber);
  }
}