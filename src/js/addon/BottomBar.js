class BottomBar {
  constructor(e) {
    this.editor = e;

    this.cursorOBJ = getElement(".bottomBar-cursorPos");
    this.cursorStatusElement = getElement(".bottomBar-cursor-status");
    this.fileStatusElement = getElement(".bottomBar-file-status");
    this.languageElement = getElement("#language");
    this.configSpaceElement = getElement("#config-space");
    this.viewTypePicker = getElement("#view-type");
    this.bottomBarElement = getElement(".bottomBar");

    this.refreshLanguage();
    this.refreshScrollers();
    this.refreshFileStatus();
    this.refreshViewTypePicker();
  }

  openViewTypePicker() {
    const tab = this.editor.tabManager.activeTab;
    if (!tab?.path) return;
    if (tab.largeFileMode === true || tab.textTab?.largeFileMode === true) return;
    const isImage = this.isImagePath(tab.path);
    const isMarkdown = this.isMarkdownPath(tab.path);
    if (!isImage && !isMarkdown) return;
    const previewId = isImage ? "picture" : "markdown";
    const selectedId = tab.type === previewId ? previewId : "text";
    this.editor.quickPanel.open({
      id: "view-type",
      mode: "pick",
      title: "Change View Type",
      placeholder: "Change View Type",
      selectedId,
      items: isImage ? [
        { id: "picture", label: "Image Preview", data: "picture" },
        { id: "text", label: "Text Editor", data: "text" },
      ] : [
        { id: "markdown", label: "Markdown Preview", data: "markdown" },
        { id: "text", label: "Text Editor", data: "text" },
      ],
      onAccept: (item) => this.editor.tabManager.switchActiveTabView(item.data),
    });
  }

  refreshViewTypePicker() {
    if (!this.viewTypePicker) return;
    const tab = this.editor.tabManager.activeTab;
    const isImage = this.isImagePath(tab?.path || "");
    const isMarkdown = this.isMarkdownPath(tab?.path || "");
    const largeFileMode = tab?.largeFileMode === true ||
      tab?.textTab?.largeFileMode === true;
    this.viewTypePicker.hidden = largeFileMode || (!isImage && !isMarkdown);
    const title = this.viewTypePicker.querySelector(".scroller-title");
    if (!title) return;
    title.textContent = tab?.type === "picture" ? "Image Preview"
      : tab?.type === "markdown" ? "Markdown Preview" : "Text Editor";
  }

  isImagePath(path) {
    if (typeof PictureView !== "undefined")
      return PictureView.isPreviewablePath(path);
    return Boolean(this.editor._pictureView?.isPreviewablePath?.(path));
  }

  isMarkdownPath(path) {
    return FileType.isMarkdownPath(path);
  }

  async openLanguage() {
    const file = this.editor.tabManager.activeFile;
    if (!file) return;

    const languages =
      await this.editor.highlightController.getSupportedLanguage();
    const items = ["plaintext", ...(Array.isArray(languages) ? languages : [])]
      .filter((language) => typeof language === "string" && language.length > 0)
      .map((language) => language.toLowerCase())
      .filter((language, index, values) => values.indexOf(language) === index)
      .map((language) => ({
        id: language.toLowerCase(),
        icon: this.getLanguageLogo(language),
        label:
          language === "plaintext"
            ? "Plain Text"
            : language === "cpp"
              ? "C++"
              : language.charAt(0).toUpperCase() + language.slice(1),
        data: language,
      }));

    this.editor.quickPanel.open({
      id: "language",
      mode: "pick",
      title: "Select Language",
      placeholder: "Select Language",
      selectedId: String(file.language || "plaintext").toLowerCase(),
      items,
      onAccept: (item) => {
        this.editor.highlightController.changeLanguage(file, item.data);
        this.refreshLanguage();
      },
    });
  }

  getLanguageLogo(language) {
    const logos = {
      javascript: "fi fi-brands-js language-logo-javascript",
      typescript: "fi fi-brands-typescript language-logo-typescript",
      python: "fi fi-brands-python language-logo-python",
      html: "fi fi-brands-html5 language-logo-html",
      css: "fi fi-brands-css3 language-logo-css",
      php: "fi fi-brands-php language-logo-php",
      java: "fi fi-brands-java language-logo-java",
      c: "fi fi-brands-c language-logo-c",
      cpp: "fi fi-brands-c language-logo-c",
    };
    return `${logos[language] || "fi fi-rr-code-simple"} quick-panel-language-logo`;
  }

  openConfigSpace() {
    const current = Number(SETTINGS_GET("editor.tabWidth"));
    const items = Array.from({ length: 8 }, (_, index) => {
      const value = index + 1;
      return {
        id: String(value),
        label: `Spaces: ${value}`,
        data: value,
      };
    });

    this.editor.quickPanel.open({
      id: "config-space",
      mode: "pick",
      title: "Select Tab Size",
      placeholder: "Select Tab Size",
      selectedId: String(current),
      items,
      onAccept: async (item) => {
        if (!(await SETTINGS_SET("editor.tabWidth", item.data))) return;
        this.refreshScrollers();
        this.editor.lineController.refresh(true);
      },
    });
  }

  refresh() {
    this.refreshViewTypePicker();
    this.refreshFileStatus();
    if (!this.editor.tabManager.activeFile) return;

    this.refreshCursorOBJ();
    this.refreshLanguage();
    this.refreshScrollers();
  }

  setSettingsActive(active) {
    this.bottomBarElement?.classList.toggle("bottomBar-settings-mode", active === true);
  }

  refreshFileStatus() {
    if (!this.fileStatusElement) return;
    const file = this.editor.tabManager.activeFile;
    const status = file?.loadingState?.status;
    const text = this.fileStatusElement.querySelector(".bottomBar-text");
    const largeFileMode = file?.largeFileMode === true;
    let message = largeFileMode
      ? "Large File Mode · Syntax highlighting and Auto Save are disabled for this file."
      : "";
    if (status === "loading")
      message = `${largeFileMode ? "Large File Mode · " : ""}Loading file… Editing is temporarily disabled.`;
    else if (status === "failed" || file?.loadError)
      message = `${largeFileMode ? "Large File Mode · " : ""}File loading failed. Reload the file to try again.`;
    if (text) text.innerText = message;
    this.fileStatusElement.style.display = message ? "" : "none";
  }

  refreshCursorOBJ() {
    if (!this.cursorOBJ || !this.cursorStatusElement ||
        !this.editor.tabManager.activeFile) return;

    if (this.editor.tabManager.activeFile.loadError) {
      if (this.cursorOBJ.innerText !== "") this.cursorOBJ.innerText = "";
      if (this.cursorStatusElement.style.display !== "none")
        this.cursorStatusElement.style.display = "none";
      return;
    }

    if (this.cursorStatusElement.style.display !== "")
      this.cursorStatusElement.style.display = "";

    let r = "";
    let countLine = this.editor.selectController.getNumberLineSelected();

    if (!countLine) {
      r = `Line ${this.editor.cursorController.row}, Column ${this.editor.cursorController.column}`;
    } else {
      if (countLine > 1) r += countLine + " lines, ";
      r +=
        (this.editor.selectController.getSelectionLength?.() ?? this.editor.selectController.containsSelected.length) +
        " characters selected";
    }

    if (this.cursorOBJ.innerText !== r) this.cursorOBJ.innerText = r;
  }

  refreshScrollers() {
    if (!this.configSpaceElement) return;
    const title = this.configSpaceElement.querySelector(".scroller-title");
    if (title) title.innerText = `Spaces: ${SETTINGS_GET("editor.tabWidth")}`;
  }

  refreshLanguage() {
    if (!this.languageElement) return;
    const title = this.languageElement.querySelector(".scroller-title");
    const language = this.editor.tabManager.activeFile?.language || "plaintext";
    if (title)
      title.innerText = language === "plaintext" ? "Plain Text" : language;
  }

  hide() {
    const leftBottomBar = getElement(".bottomBar .left");
    const middleBottomBar = getElement(".bottomBar .middle");
    const rightBottomBar = getElement(".bottomBar .right");

    leftBottomBar.style.display = "flex";
    middleBottomBar.style.display = "none";
    rightBottomBar.style.display = "none";
  }

  show() {
    const leftBottomBar = getElement(".bottomBar .left");
    const middleBottomBar = getElement(".bottomBar .middle");
    const rightBottomBar = getElement(".bottomBar .right");

    leftBottomBar.style.display = "flex";
    middleBottomBar.style.display = "flex";
    rightBottomBar.style.display = "flex";
    this.bottomBarElement?.classList.remove("bottomBar-image-preview-mode", "bottomBar-preview-mode");
    this.refreshViewTypePicker();
    this.refreshFileStatus();
  }

  showImagePreview() {
    this.show();
    this.bottomBarElement?.classList.add("bottomBar-image-preview-mode", "bottomBar-preview-mode");
  }

  showMarkdownPreview() {
    this.show();
    this.bottomBarElement?.classList.add("bottomBar-preview-mode");
  }
}
