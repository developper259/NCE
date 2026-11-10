const NSH_LANGUAGE_LABELS = Object.freeze({
  plaintext: "Plain Text",
  javascript: "JavaScript",
  typescript: "TypeScript",
  jsx: "JSX",
  tsx: "TSX",
  python: "Python",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  yaml: "YAML",
  php: "PHP",
  java: "Java",
  xml: "XML",
  cpp: "C++",
  c: "C",
  csv: "CSV",
  markdown: "Markdown",
  bash: "Bash",
  sql: "SQL",
  rust: "Rust",
  go: "Go",
  scss: "SCSS",
  sass: "Sass",
});

const NSH_LANGUAGE_LOGOS = Object.freeze({
  javascript: "fi fi-brands-js language-logo-javascript",
  typescript: "fi fi-brands-typescript language-logo-typescript",
  jsx: "fi fi-rr-react language-logo-react",
  tsx: "fi fi-rr-react language-logo-react",
  python: "fi fi-brands-python language-logo-python",
  html: "fi fi-brands-html5 language-logo-html",
  css: "fi fi-brands-css3 language-logo-css",
  php: "fi fi-brands-php language-logo-php",
  java: "fi fi-brands-java language-logo-java",
  c: "fi fi-brands-c language-logo-c",
  cpp: "fi fi-brands-c language-logo-c",
  bash: "fi fi-rr-terminal language-logo-bash",
  sql: "fi fi-rr-database language-logo-sql",
  scss: "fi fi-brands-sass language-logo-sass",
  sass: "fi fi-brands-sass language-logo-sass",
});

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
    this.problemIndicators = null;
    this.problemPairs = { errors: null, warnings: null };
    this.problemCounts = { errors: null, warnings: null };
    this.gitBranchIndicator = null;
    this.gitBranchNameElement = null;
    this.gitBranchDirtyElement = null;
    this.gitBranch = null;
    this.gitBranchDirty = false;
    this.gitBranchRequest = 0;

    this.buildGitBranchIndicator();
    this.buildProblemIndicators();
    this.refreshProblemCounts();
    this.refreshLanguage();
    this.refreshScrollers();
    this.refreshFileStatus();
    this.refreshViewTypePicker();
  }

  buildProblemIndicators() {
    const left = getElement(".bottomBar .left");
    if (!left || typeof document === "undefined" ||
        typeof document.createElement !== "function") return;
    const group = document.createElement("div");
    group.className = "bottomBar-problems";
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", "0 errors, 0 warnings. Open Problems panel.");
    group.setAttribute("aria-live", "polite");
    group.tabIndex = 0;
    group.title = "0 errors, 0 warnings";

    const createPair = (severity, iconName) => {
      const pair = document.createElement("span");
      pair.className = "bottomBar-problem";
      pair.dataset.severity = severity;
      pair.setAttribute("aria-hidden", "true");
      const count = document.createElement("span");
      count.className = "bottomBar-problem-count";
      count.textContent = "0";
      const icon = document.createElement("i");
      icon.className = `fi ${iconName}`;
      icon.setAttribute("aria-hidden", "true");
      pair.append(count, icon);
      group.append(pair);
      return { pair, count };
    };

    const errors = createPair("error", "fi-rr-cross-circle");
    const warnings = createPair("warning", "fi-rr-triangle-warning");
    this.problemPairs = { errors: errors.pair, warnings: warnings.pair };
    this.problemCounts = { errors: errors.count, warnings: warnings.count };

    group.addEventListener("click", () => void this.openProblemsPanel());
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void this.openProblemsPanel();
    });
    left.append(group);
    this.problemIndicators = group;
  }

  buildGitBranchIndicator() {
    const left = getElement(".bottomBar .left");
    if (!left || typeof document === "undefined" ||
        typeof document.createElement !== "function") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bottomBar-git-branch";
    button.hidden = true;
    button.dataset.action = "git-branch";
    button.title = "Open Source Control";
    button.setAttribute("aria-label", "Open Source Control");

    const icon = document.createElement("i");
    icon.className = "fi fi-rr-code-branch";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "bottomBar-git-branch-label";
    const name = document.createElement("span");
    name.className = "bottomBar-git-branch-name";
    const dirty = document.createElement("span");
    dirty.className = "bottomBar-git-branch-dirty";
    dirty.textContent = "*";
    dirty.hidden = true;
    dirty.setAttribute("aria-hidden", "true");
    label.append(name, dirty);
    button.append(icon, label);

    button.addEventListener("click", () => void this.openGitSidebar());
    left.append(button);
    this.gitBranchIndicator = button;
    this.gitBranchNameElement = name;
    this.gitBranchDirtyElement = dirty;
  }

  openGitSidebar() {
    const manager = this.editor.sidebarManager;
    if (typeof manager?.openMenu !== "function") return false;
    manager.openMenu("git");
    return true;
  }

  static getGitBranchLabel(branch) {
    if (typeof branch === "string") return branch.trim();
    if (!branch) return "";
    if (branch.name) return String(branch.name).trim();
    if (branch.oid) return `detached @ ${String(branch.oid).slice(0, 7)}`;
    return branch.detached ? "Detached HEAD" : "detached";
  }

  static isTerminalGitError(code) {
    return code === "GIT_NOT_FOUND" ||
      code === "NOT_A_REPOSITORY" ||
      code === "REPOSITORY_NOT_FOUND" ||
      code === "PERMISSION_DENIED" ||
      code === "INVALID_PATH" ||
      code === "GIT_OUTPUT_LIMIT";
  }

  applyGitBranch(branch, { stale = false, dirty = false } = {}) {
    this.gitBranch = branch || null;
    this.gitBranchDirty = this.gitBranch ? dirty === true : false;
    if (!this.gitBranchIndicator) return;
    const label = BottomBar.getGitBranchLabel(branch);
    this.gitBranchIndicator.hidden = !label;
    this.gitBranchIndicator.dataset.branch = label;
    this.gitBranchIndicator.dataset.dirty = String(this.gitBranchDirty);
    if (this.gitBranchNameElement) this.gitBranchNameElement.textContent = label;
    if (this.gitBranchDirtyElement)
      this.gitBranchDirtyElement.hidden = !label || !this.gitBranchDirty;
    if (!label) {
      this.gitBranchIndicator.title = "Open Source Control";
      this.gitBranchIndicator.setAttribute("aria-label", "Open Source Control");
      return;
    }
    const ahead = Math.max(0, Number(branch?.ahead) || 0);
    const behind = Math.max(0, Number(branch?.behind) || 0);
    const tracking = [
      ahead ? `↑${ahead}` : "",
      behind ? `↓${behind}` : "",
    ].filter(Boolean).join(" ");
    const upstream = typeof branch?.upstream === "string" && branch.upstream
      ? ` (${branch.upstream})`
      : "";
    const changes = this.gitBranchDirty ? " · Uncommitted changes" : "";
    const details = `${label}${tracking ? ` ${tracking}` : ""}${upstream}`;
    this.gitBranchIndicator.title =
      `${details}${changes}${stale ? " · Out of date" : ""} · Open Source Control`;
    this.gitBranchIndicator.setAttribute(
      "aria-label",
      `Git branch ${label}.${this.gitBranchDirty ? " Uncommitted changes." : ""}` +
        `${stale ? " Out of date." : ""} Open Source Control.`,
    );
  }

  async refreshGitBranch() {
    if (!this.gitBranchIndicator) return false;
    const root = this.editor.fileExplorer?.rootPath || "";
    const git = this.editor.api?.git;
    const request = ++this.gitBranchRequest;
    if (!root || typeof git?.getStatus !== "function") {
      this.applyGitBranch(null);
      return false;
    }
    let result = null;
    try {
      result = await git.getStatus();
    } catch {
      result = null;
    }
    if (request !== this.gitBranchRequest) return false;
    if (root !== (this.editor.fileExplorer?.rootPath || "")) return false;
    if (result?.success === true) {
      const status = result.status || null;
      this.applyGitBranch(status?.branch || null, {
        dirty: Array.isArray(status?.entries) && status.entries.length > 0,
      });
      return true;
    }
    const code = result?.code || "GIT_COMMAND_FAILED";
    if (BottomBar.isTerminalGitError(code) || !this.gitBranch) {
      this.applyGitBranch(null);
      return false;
    }
    this.applyGitBranch(this.gitBranch, {
      stale: true,
      dirty: this.gitBranchDirty,
    });
    return false;
  }

  openProblemsPanel() {
    const controller = this.editor.lspController;
    if (typeof controller?.showProblems === "function")
      return controller.showProblems();
    return this.editor.bottomPanelManager?.openPanel?.("problems") || false;
  }

  refreshProblemCounts(counts = null) {
    const resolved = counts || this.editor.lspController?.getProblemCounts?.() ||
      { errors: 0, warnings: 0 };
    const errors = this.updateProblemPair(
      this.problemPairs.errors,
      this.problemCounts.errors,
      resolved.errors,
    );
    const warnings = this.updateProblemPair(
      this.problemPairs.warnings,
      this.problemCounts.warnings,
      resolved.warnings,
    );
    if (!this.problemIndicators) return;
    const label = `${errors} error${errors === 1 ? "" : "s"}, `
      + `${warnings} warning${warnings === 1 ? "" : "s"}`;
    this.problemIndicators.title = label;
    this.problemIndicators.setAttribute(
      "aria-label",
      `${label}. Open Problems panel.`,
    );
    this.problemIndicators.dataset.errors = String(errors);
    this.problemIndicators.dataset.warnings = String(warnings);
  }

  updateProblemPair(pair, countElement, count) {
    const value = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    if (pair) pair.dataset.count = String(value);
    if (countElement) countElement.textContent = String(value);
    return value;
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
        label: this.getLanguageLabel(language),
        data: language,
      }));

    this.editor.quickPanel.open({
      id: "language",
      mode: "pick",
      title: "Select Language",
      placeholder: "Select Language",
      selectedId: String(file.language || "plaintext").toLowerCase(),
      items,
      onAccept: async (item) => {
        await this.editor.highlightController.changeLanguage(file, item.data);
        this.refreshLanguage();
      },
    });
  }

  getLanguageLabel(language) {
    const normalized = String(language || "plaintext").toLowerCase();
    return NSH_LANGUAGE_LABELS[normalized] ||
      normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  getLanguageLogo(language) {
    return `${NSH_LANGUAGE_LOGOS[language] || "fi fi-rr-code-simple"} `
      + "quick-panel-language-logo";
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
    if (title) title.innerText = this.getLanguageLabel(language);
  }

  hide() {
    const leftBottomBar = getElement(".bottomBar .left");
    const middleBottomBar = getElement(".bottomBar .middle");
    const rightBottomBar = getElement(".bottomBar .right");

    leftBottomBar.style.display = "flex";
    middleBottomBar.style.display = "none";
    rightBottomBar.style.display = "flex";
    rightBottomBar.classList.add("bottomBar-right-collapsed");
  }

  show() {
    const leftBottomBar = getElement(".bottomBar .left");
    const middleBottomBar = getElement(".bottomBar .middle");
    const rightBottomBar = getElement(".bottomBar .right");

    leftBottomBar.style.display = "flex";
    middleBottomBar.style.display = "flex";
    rightBottomBar.style.display = "flex";
    rightBottomBar.classList.remove("bottomBar-right-collapsed");
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
