class GitSidebar extends Sidebar {
  static COMMIT_INPUT_MAX_HEIGHT = 160;

  static resolveAbsolutePath(root, relativePath) {
    if (typeof root !== "string" || !root.trim()) return null;
    if (typeof relativePath !== "string" || !relativePath.trim()) return null;
    if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) return null;
    const segments = relativePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".."))
      return null;
    return `${root.trim().replace(/[\\/]+$/, "")}/${segments.join("/")}`;
  }

  static describeError(result) {
    const code = result?.code;
    if (code === "GIT_NOT_FOUND")
      return "Git is not installed or is not accessible from NCE.";
    if (code === "NOT_A_REPOSITORY")
      return "This workspace is not a Git repository.";
    if (code === "REPOSITORY_NOT_FOUND")
      return "The workspace folder is not available.";
    if (code === "PERMISSION_DENIED")
      return "Git cannot access this repository.";
    if (code === "GIT_TIMEOUT")
      return "Git did not respond in time.";
    if (code === "GIT_INDEX_LOCKED")
      return "Git is already running in this repository, or a previous operation was interrupted. Wait for it to finish, then retry.";
    if (code === "GIT_OUTPUT_LIMIT")
      return "Too many changes to display. Reduce untracked files or use the terminal.";
    return result?.error || "Git status could not be read.";
  }

  static statusLetter(entry, staged) {
    const code = staged ? entry?.index : entry?.worktree;
    if (entry?.conflicted) return "!";
    if (code && code !== "?" && code !== ".") return code;
    const letters = {
      untracked: "U",
      added: "A",
      modified: "M",
      deleted: "D",
      renamed: "R",
      copied: "C",
      conflicted: "!",
    };
    return letters[entry?.kind] || "?";
  }

  static splitPath(relativePath) {
    const normalized = String(relativePath || "");
    const index = normalized.lastIndexOf("/");
    if (index < 0) return { name: normalized, dir: "" };
    return { name: normalized.slice(index + 1), dir: normalized.slice(0, index) };
  }

  static validateBranchName(value) {
    const name = String(value ?? "").trim();
    if (!name) return "Enter a branch name.";
    if (name.length > 255) return "The branch name is too long.";
    if (name.startsWith("-")) return "Branch names cannot start with a dash.";
    if (name === "@") return "Enter a valid branch name.";
    if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name))
      return "Branch names cannot contain spaces or ~ ^ : ? * [ \\.";
    if (name.includes("..")) return "Branch names cannot contain '..'.";
    if (name.includes("@{")) return "Branch names cannot contain '@{'.";
    if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock"))
      return "Branch names cannot end with '/', '.', or '.lock'.";
    if (name.split("/").some((part) =>
      !part || part.startsWith(".") || part.endsWith(".lock")))
      return "Each branch path segment must be valid.";
    return null;
  }

  static sortBranches(branches) {
    return (Array.isArray(branches) ? branches.slice() : [])
      .filter((branch) => branch && typeof branch.name === "string" && branch.name)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  constructor(editor) {
    super("git", "Source Control", "fi fi-rr-code-branch", "left", editor);
    this.container = null;
    this.headerElement = null;
    this.refreshButton = null;
    this.menuButton = null;
    this.commitBoxElement = null;
    this.commitInput = null;
    this.commitButton = null;
    this.commitButtonIcon = null;
    this.commitButtonLabel = null;
    this.commitStatus = null;
    this.branchButton = null;
    this.branchButtonName = null;
    this.switchingBranch = false;
    this.commitResizeObserver = null;
    this.commitInputWidth = -1;
    this.stateElement = null;
    this.stateIconElement = null;
    this.stateTitleElement = null;
    this.stateText = null;
    this.stateDetailsElement = null;
    this.stateCodeElement = null;
    this.stateRetry = null;
    this.stateInit = null;
    this.stateRefresh = null;
    this.stateSettings = null;
    this.initializing = false;
    this.listElement = null;
    this.listViewport = null;
    this.listLayer = null;

    this.fileScroller = new SearchResultsScroller(
      editor,
      (item) => this.createListItem(item),
    );

    this.workspaceRoot = "";
    this.workspaceGeneration = 0;
    this.commitDrafts = new Map();
    this.sectionsCacheStatus = null;
    this.sectionsCache = null;
    this.diffRefreshInFlight = new Set();
    this.status = null;
    this.error = null;
    this.stale = false;
    this.loading = false;
    this.commitMessage = "";
    this.committing = false;
    this.stagingAll = false;
    this.unstagingAll = false;
    this.commitError = "";
    this.actionError = "";
    this.initError = "";
    this.notice = "";
    this.operationPaths = new Set();
    this.diffLoadingPaths = new Set();
    this.generation = 0;
    this.refreshTimer = null;
    this.listResetPending = true;
    this.destroyed = false;
    this.collapsed = { staged: false, changes: false };
    this.loadCollapsedState();

    this.unsubscribeFileSystem =
      editor.api?.onFileSystemChange?.((events) =>
        this.handleFileSystemEvents(events)) || null;
  }

  loadCollapsedState() {
    try {
      if (typeof localStorage === "undefined") return;
      const stored = JSON.parse(localStorage.getItem("nce.gitSidebar.collapsed") || "null");
      if (!stored || typeof stored !== "object") return;
      this.collapsed.staged = stored.staged === true;
      this.collapsed.changes = stored.changes === true;
    } catch {}
  }

  saveCollapsedState() {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(
        "nce.gitSidebar.collapsed",
        JSON.stringify(this.collapsed),
      );
    } catch {}
  }

  render() {
    if (this.container) {
      this.updateView();
      return this.container;
    }

    const container = document.createElement("div");
    container.className = "git-sidebar-container";
    this.container = container;

    const header = document.createElement("div");
    header.className = "git-sidebar-header";
    const title = document.createElement("div");
    title.className = "sidebar-main-title";
    title.textContent = "Source Control";
    this.headerTitleElement = title;

    const headerActions = document.createElement("div");
    headerActions.className = "git-sidebar-header-actions";

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "git-sidebar-icon-button";
    refreshButton.title = "Refresh";
    refreshButton.setAttribute("aria-label", "Refresh Source Control");
    const refreshIcon = document.createElement("i");
    refreshIcon.className = "fi fi-rr-refresh";
    refreshIcon.setAttribute("aria-hidden", "true");
    refreshButton.appendChild(refreshIcon);
    refreshButton.addEventListener("click", () => this.refresh({ reason: "manual" }));
    refreshButton.dataset.action = "refresh";
    this.refreshButton = refreshButton;

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "git-sidebar-icon-button";
    menuButton.title = "Source Control actions";
    menuButton.setAttribute("aria-label", "Open Source Control actions");
    menuButton.setAttribute("aria-haspopup", "menu");
    const menuIcon = document.createElement("i");
    menuIcon.className = "fi fi-rr-menu-dots-vertical";
    menuIcon.setAttribute("aria-hidden", "true");
    menuButton.appendChild(menuIcon);
    menuButton.addEventListener("click", () => this.openHeaderContextMenu());
    menuButton.dataset.action = "menu";
    this.menuButton = menuButton;

    headerActions.append(refreshButton, menuButton);
    header.append(title, headerActions);
    this.headerElement = header;

    header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openHeaderContextMenu();
    });

    const commitBox = document.createElement("div");
    commitBox.className = "git-sidebar-commit";

    const commitInput = document.createElement("textarea");
    commitInput.className = "git-composer-input";
    commitInput.rows = 1;
    commitInput.placeholder = "Commit message...";
    commitInput.setAttribute("aria-label", "Commit message");
    commitInput.setAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
    commitInput.autocomplete = "off";
    commitInput.spellcheck = false;
    commitInput.addEventListener("input", () => {
      this.commitMessage = commitInput.value;
      this.autoResizeCommitInput();
      this.updateCommitControls();
    });
    commitInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.commitChanges();
      }
    });
    this.commitInput = commitInput;

    const commitFooter = document.createElement("div");
    commitFooter.className = "git-composer-footer";

    const branchButton = document.createElement("button");
    branchButton.type = "button";
    branchButton.className = "git-branch-button";
    branchButton.title = "Switch Branch";
    branchButton.setAttribute("aria-label", "Switch Branch");
    branchButton.setAttribute("aria-haspopup", "dialog");
    const branchButtonIcon = document.createElement("i");
    branchButtonIcon.className = "fi fi-rr-code-branch";
    branchButtonIcon.setAttribute("aria-hidden", "true");
    const branchButtonName = document.createElement("span");
    branchButtonName.className = "git-branch-button-name";
    const branchButtonArrow = document.createElement("i");
    branchButtonArrow.className = "fi fi-rr-angle-small-down git-branch-button-arrow";
    branchButtonArrow.setAttribute("aria-hidden", "true");
    branchButton.append(branchButtonIcon, branchButtonName, branchButtonArrow);
    branchButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.openBranchPicker();
    });
    this.branchButton = branchButton;
    this.branchButtonName = branchButtonName;

    const commitButton = document.createElement("button");
    commitButton.type = "button";
    commitButton.className = "git-composer-commit";
    commitButton.disabled = true;
    commitButton.title = "Commit changes";
    commitButton.setAttribute("aria-label", "Commit changes");
    const commitLabel = document.createElement("span");
    commitLabel.className = "git-composer-commit-label";
    commitLabel.textContent = "Commit";
    const commitIcon = document.createElement("i");
    commitIcon.className = "fi fi-rr-check";
    commitIcon.setAttribute("aria-hidden", "true");
    commitButton.append(commitIcon, commitLabel);
    commitButton.addEventListener("click", () => void this.commitChanges());
    this.commitButton = commitButton;
    this.commitButtonIcon = commitIcon;
    this.commitButtonLabel = commitLabel;

    commitFooter.append(branchButton, commitButton);

    const commitStatus = document.createElement("span");
    commitStatus.className = "git-sidebar-commit-status";
    commitStatus.setAttribute("role", "status");
    commitStatus.setAttribute("aria-live", "polite");
    this.commitStatus = commitStatus;

    commitBox.append(commitInput, commitFooter, commitStatus);
    this.commitBoxElement = commitBox;
    if (typeof ResizeObserver === "function") {
      this.commitResizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect?.width;
        if (width === this.commitInputWidth) return;
        this.commitInputWidth = width;
        this.autoResizeCommitInput();
      });
      this.commitResizeObserver.observe(commitBox);
    }

    const state = document.createElement("div");
    state.className = "git-sidebar-state";
    state.hidden = true;
    const stateHeading = document.createElement("div");
    stateHeading.className = "git-sidebar-state-heading";
    const stateIcon = document.createElement("i");
    stateIcon.className = "fi fi-rr-code-branch git-state-icon";
    stateIcon.setAttribute("aria-hidden", "true");
    const stateCopy = document.createElement("div");
    stateCopy.className = "git-state-copy";
    stateCopy.setAttribute("aria-live", "polite");
    const stateTitle = document.createElement("div");
    stateTitle.className = "git-state-title";
    const stateText = document.createElement("div");
    stateText.className = "git-state-description";
    const stateDetails = document.createElement("details");
    stateDetails.className = "git-state-details";
    stateDetails.hidden = true;
    const stateDetailsSummary = document.createElement("summary");
    stateDetailsSummary.textContent = "Details";
    const stateCode = document.createElement("code");
    stateCode.className = "git-state-code";
    stateDetails.append(stateDetailsSummary, stateCode);
    stateCopy.append(stateTitle, stateText, stateDetails);
    stateHeading.append(stateIcon, stateCopy);

    const stateActions = document.createElement("div");
    stateActions.className = "git-sidebar-state-actions";

    const stateInit = document.createElement("button");
    stateInit.type = "button";
    stateInit.className = "git-sidebar-state-button git-sidebar-init";
    stateInit.textContent = "Initialize Repository";
    stateInit.title = "Initialize a Git repository in this workspace";
    stateInit.setAttribute("aria-label", "Initialize a Git repository");
    stateInit.dataset.action = "init";
    stateInit.addEventListener("click", () => void this.initializeRepository());
    this.stateInit = stateInit;

    const stateRefresh = document.createElement("button");
    stateRefresh.type = "button";
    stateRefresh.className = "git-sidebar-state-button";
    stateRefresh.textContent = "Refresh";
    stateRefresh.dataset.action = "refresh";
    stateRefresh.addEventListener("click", () => this.refresh({ reason: "manual" }));
    this.stateRefresh = stateRefresh;

    const stateRetry = document.createElement("button");
    stateRetry.type = "button";
    stateRetry.className = "git-sidebar-state-button";
    stateRetry.textContent = "Retry";
    stateRetry.dataset.action = "retry";
    stateRetry.addEventListener("click", () => this.refresh({ reason: "manual" }));

    const stateSettings = document.createElement("button");
    stateSettings.type = "button";
    stateSettings.className = "git-sidebar-state-button";
    stateSettings.textContent = "Go to Settings";
    stateSettings.title = "Open Git settings to configure the Git executable path";
    stateSettings.dataset.action = "settings";
    stateSettings.addEventListener("click", () => void this.openGitSettings());

    stateActions.append(stateInit, stateRefresh, stateRetry, stateSettings);
    state.append(stateHeading, stateActions);
    this.stateElement = state;
    this.stateIconElement = stateIcon;
    this.stateTitleElement = stateTitle;
    this.stateText = stateText;
    this.stateDetailsElement = stateDetails;
    this.stateCodeElement = stateCode;
    this.stateRetry = stateRetry;
    this.stateSettings = stateSettings;

    const list = document.createElement("div");
    list.className = "git-sidebar-list";
    const viewport = document.createElement("div");
    viewport.className = "git-sidebar-list-viewport";
    const layer = this.editor.domManager?.createFastElement?.("div");
    if (layer) layer.setClassName("git-sidebar-list-layer");
    const layerNode = layer?.domNode || document.createElement("div");
    layerNode.classList?.add?.("git-sidebar-list-layer");
    viewport.appendChild(layerNode);
    list.appendChild(viewport);
    this.listElement = list;
    this.listViewport = viewport;
    this.listLayer = layerNode;
    this.fileScroller.attach(list, viewport, layerNode);

    container.append(header, state, list, commitBox);
    this.updateView();
    return container;
  }

  updateView() {
    if (!this.container) return;
    const branchLabel = this.getBranchLabel();
    if (this.branchButtonName)
      this.branchButtonName.textContent = branchLabel || "No branch";
    if (this.branchButton) {
      this.branchButton.title = branchLabel
        ? `Switch Branch (${branchLabel})`
        : "Switch Branch";
      this.branchButton.disabled =
        this.switchingBranch || this.committing || this.stagingAll ||
        this.unstagingAll;
    }
    if (this.refreshButton) {
      this.refreshButton.hidden = !this.workspaceRoot;
      this.refreshButton.disabled = this.loading;
      if (this.loading) this.refreshButton.setAttribute("aria-busy", "true");
      else this.refreshButton.removeAttribute("aria-busy");
    }
    if (this.menuButton)
      this.menuButton.hidden = !this.status?.branch;
    if (this.commitInput) {
      const focused = typeof document !== "undefined" &&
        document.activeElement === this.commitInput;
      if (!focused && this.commitInput.value !== this.commitMessage)
        this.commitInput.value = this.commitMessage;
      this.commitInput.disabled =
        this.committing || this.stagingAll || this.unstagingAll;
      this.autoResizeCommitInput();
    }
    this.updateCommitControls();
    this.updateState();
  }

  getBranchLabel() {
    const branch = this.status?.branch;
    if (!branch) return "";
    return branch.name ||
      (branch.oid ? `detached @ ${branch.oid.slice(0, 7)}` : "detached");
  }

  autoResizeCommitInput() {
    const input = this.commitInput;
    if (!input || !input.isConnected || input.offsetParent === null) return;
    const maxHeight = GitSidebar.COMMIT_INPUT_MAX_HEIGHT;
    input.style.height = "auto";
    const border = Math.max(0, input.offsetHeight - input.clientHeight);
    const height = Math.min(input.scrollHeight + border, maxHeight);
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight + border > maxHeight
      ? "auto"
      : "hidden";
  }

  updateCommitControls() {
    if (this.commitButton) {
      const committing = this.committing;
      this.commitButton.disabled = !this.canCommit();
      this.commitButton.title = committing ? "Committing…" : "Commit changes";
      this.commitButton.setAttribute(
        "aria-label",
        committing ? "Committing…" : "Commit changes",
      );
      if (this.commitButtonIcon) {
        this.commitButtonIcon.className = committing
          ? "fi fi-rr-refresh git-commit-spinner"
          : "fi fi-rr-check";
      }
      if (this.commitButtonLabel)
        this.commitButtonLabel.textContent = committing ? "Committing…" : "Commit";
      if (committing) this.commitButton.setAttribute("aria-busy", "true");
      else this.commitButton.removeAttribute("aria-busy");
    }
    if (!this.commitStatus) return;
    this.commitStatus.textContent = this.getCommitStatusText();
    this.commitStatus.dataset.state = this.actionError || this.commitError
      ? "error"
      : this.stale
        ? "warning"
        : "info";
  }

  getCommitStatusText() {
    const explicit = this.actionError || this.commitError ||
      this.notice || (this.stale ? "Changes may be out of date." : "");
    if (explicit) return explicit;
    if (this.getViewState().mode === "changes" && this.stagedCount() === 0)
      return "Stage a file to commit.";
    return "";
  }

  getViewState() {
    if (!this.workspaceRoot) return { mode: "no-workspace" };
    if (!this.status) {
      if (this.initError && this.error?.code !== "GIT_NOT_FOUND") {
        return {
          mode: "init-error",
          message: this.initError,
          errorCode: this.error?.code || "NOT_A_REPOSITORY",
          busy: this.initializing,
        };
      }
      if (this.error) {
        if (this.error.code === "NOT_A_REPOSITORY")
          return { mode: "no-repository", busy: this.initializing };
        return {
          mode: "error",
          message: this.error.message,
          errorCode: this.error.code || "GIT_COMMAND_FAILED",
          busy: this.loading,
        };
      }
      return { mode: "loading", busy: true };
    }
    const { staged, changes } = this.getSections();
    const total = staged.length + changes.length;
    const stale = Boolean(this.error && this.stale);
    if (total === 0)
      return { mode: "clean", branch: this.status.branch, stale };
    return { mode: "changes", branch: this.status.branch, staged, changes, total, stale };
  }

  static errorTitle(code) {
    if (code === "GIT_NOT_FOUND") return "Git is not installed";
    if (code === "REPOSITORY_NOT_FOUND") return "Workspace unavailable";
    if (code === "PERMISSION_DENIED") return "Repository access denied";
    if (code === "GIT_TIMEOUT") return "Git did not respond";
    if (code === "GIT_INDEX_LOCKED") return "Git is already running";
    if (code === "GIT_OUTPUT_LIMIT") return "Too many changes";
    return "Source Control unavailable";
  }

  getStatePresentation(view = this.getViewState()) {
    if (view.mode === "no-workspace") {
      return {
        icon: "fi-rr-folder",
        tone: "muted",
        title: "No folder open",
        description: "Open a folder to review its changes.",
      };
    }
    if (view.mode === "no-repository") {
      return {
        icon: "fi-rr-code-branch",
        tone: "muted",
        title: "No Git repository",
        description: "This workspace is not tracked by Git.",
      };
    }
    if (view.mode === "init-error") {
      return {
        icon: "fi-rr-triangle-warning",
        tone: "error",
        title: "Repository initialization failed",
        description: view.message,
        code: view.errorCode,
      };
    }
    if (view.mode === "error") {
      return {
        icon: "fi-rr-triangle-warning",
        tone: "error",
        title: GitSidebar.errorTitle(view.errorCode),
        description: view.message,
        code: view.errorCode === "GIT_NOT_FOUND" ? "" : view.errorCode,
      };
    }
    if (view.mode === "loading") {
      return {
        icon: "fi-rr-refresh",
        tone: "muted",
        title: "Loading Source Control…",
        description: "Reading the repository status.",
        spinning: true,
        busy: true,
      };
    }
    if (view.mode === "clean") {
      return {
        icon: "fi-rr-check",
        tone: view.stale ? "warning" : "success",
        title: "Working tree clean",
        description: view.stale
          ? "The last refresh failed, so this status may be out of date."
          : "No changes to commit.",
        code: view.stale ? (this.error?.code || "") : "",
      };
    }
    return null;
  }

  getStateMessage() {
    const view = this.getViewState();
    if (view.mode === "no-workspace") return "Open a folder to review its changes.";
    if (view.mode === "no-repository") return "This workspace is not a Git repository.";
    if (view.mode === "init-error" || view.mode === "error") return view.message;
    if (view.mode === "loading") return "Loading Source Control…";
    return "";
  }

  getStateActions() {
    const view = this.getViewState();
    if (view.mode === "no-repository" || view.mode === "init-error") {
      return { init: true, refresh: true, retry: false, settings: false };
    }
    if (view.mode === "error") {
      return {
        init: false,
        refresh: false,
        retry: view.errorCode !== "GIT_NOT_FOUND" &&
          view.errorCode !== "GIT_OUTPUT_LIMIT",
        settings: view.errorCode === "GIT_NOT_FOUND",
      };
    }
    if (view.mode === "clean") {
      return { init: false, refresh: true, retry: false, settings: false };
    }
    return { init: false, refresh: false, retry: false, settings: false };
  }

  openGitSettings() {
    return this.editor.openSettings?.("Git");
  }

  updateState() {
    if (!this.stateElement) return;
    const view = this.getViewState();
    const presentation = this.getStatePresentation(view);
    this.stateElement.hidden = !presentation;
    if (presentation) {
      this.stateElement.dataset.tone = presentation.tone || "muted";
      this.stateElement.setAttribute(
        "aria-busy",
        String(presentation.busy === true || this.initializing),
      );
      if (this.stateIconElement) {
        this.stateIconElement.className =
          `fi ${presentation.icon} git-state-icon${presentation.spinning ? " is-spinning" : ""}`;
      }
      if (this.stateTitleElement)
        this.stateTitleElement.textContent = presentation.title;
      if (this.stateText)
        this.stateText.textContent = presentation.description;
      if (this.stateDetailsElement && this.stateCodeElement) {
        this.stateDetailsElement.hidden = !presentation.code;
        this.stateCodeElement.textContent = presentation.code || "";
      }
    } else {
      this.stateElement.removeAttribute("aria-busy");
    }

    const actions = this.getStateActions();
    const busy = this.loading || this.initializing;
    const primary = actions.init
      ? this.stateInit
      : actions.retry
        ? this.stateRetry
        : actions.settings
          ? this.stateSettings
          : null;
    if (this.stateInit) {
      this.stateInit.hidden = !actions.init;
      this.stateInit.disabled = busy;
      this.stateInit.textContent = view.mode === "init-error"
        ? "Retry Initialization"
        : "Initialize Repository";
      if (this.initializing) this.stateInit.setAttribute("aria-busy", "true");
      else this.stateInit.removeAttribute("aria-busy");
    }
    if (this.stateRetry) {
      this.stateRetry.hidden = !actions.retry;
      this.stateRetry.disabled = busy;
    }
    if (this.stateRefresh) {
      this.stateRefresh.hidden = !actions.refresh;
      this.stateRefresh.disabled = busy;
    }
    if (this.stateSettings) {
      this.stateSettings.hidden = !actions.settings;
      this.stateSettings.disabled = busy;
    }
    for (const button of [
      this.stateInit,
      this.stateRetry,
      this.stateRefresh,
      this.stateSettings,
    ]) {
      button?.classList.toggle("git-sidebar-primary", button === primary);
    }

    if (this.commitBoxElement)
      this.commitBoxElement.hidden = view.mode !== "changes";
    if (this.listElement)
      this.listElement.hidden = view.mode !== "changes";
  }

  getSections() {
    if (this.sectionsCacheStatus === this.status && this.sectionsCache)
      return this.sectionsCache;
    const entries = this.status?.entries || [];
    const staged = entries.filter((entry) =>
      entry.conflicted !== true && entry.index !== null && entry.index !== undefined);
    const changes = entries.filter((entry) =>
      entry.conflicted === true ||
      entry.worktree !== null && entry.worktree !== undefined ||
      entry.kind === "untracked");
    this.sectionsCacheStatus = this.status;
    this.sectionsCache = { staged, changes };
    return this.sectionsCache;
  }

  stagedCount() {
    return this.getSections().staged.length;
  }

  canCommit() {
    return this.getViewState().mode === "changes" &&
      this.stagedCount() > 0 &&
      this.commitMessage.trim().length > 0 &&
      !this.committing &&
      !this.stagingAll &&
      !this.unstagingAll &&
      !this.loading &&
      !this.stale;
  }

  createListItem(item) {
    if (item.type === "section") return this.createSectionHeader(item);
    if (item.type === "entry") return this.createEntryRow(item.entry, item.section);
    const empty = document.createElement("div");
    empty.className = "git-sidebar-empty";
    empty.textContent = item.text;
    return empty;
  }

  createSectionHeader(item) {
    const header = document.createElement("div");
    header.className = "git-section-header";
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    const collapsed = this.collapsed[item.section] === true;
    header.setAttribute("aria-expanded", String(!collapsed));
    header.dataset.section = item.section;
    header.dataset.gitFocusKey = `section:${item.section}`;

    const arrow = document.createElement("i");
    arrow.className = `fi ${collapsed ? "fi-rr-angle-small-right" : "fi-rr-angle-small-down"}`;
    arrow.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "git-section-title";
    name.textContent = item.title;

    const count = document.createElement("span");
    count.className = "git-section-count";
    count.textContent = String(item.count);

    header.append(arrow, name, count);
    if ((item.section === "changes" || item.section === "staged") && item.count > 0) {
      const staging = item.section === "changes";
      const action = document.createElement("button");
      action.type = "button";
      action.className = "git-section-action";
      action.title = staging ? "Stage all changes" : "Unstage all changes";
      action.setAttribute("aria-label", action.title);
      action.disabled = this.loading || this.committing ||
        this.stagingAll || this.unstagingAll;
      if (staging ? this.stagingAll : this.unstagingAll)
        action.setAttribute("aria-busy", "true");
      const icon = document.createElement("i");
      icon.className = `fi ${staging ? "fi-rr-plus" : "fi-rr-minus"}`;
      icon.setAttribute("aria-hidden", "true");
      action.appendChild(icon);
      action.addEventListener("click", (event) => {
        event.stopPropagation();
        void (staging ? this.stageAllChanges() : this.unstageAllChanges());
      });
      header.appendChild(action);
    }
    const toggle = () => {
      this.collapsed[item.section] = !this.collapsed[item.section];
      this.saveCollapsedState();
      this.renderList();
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (event) => {
      if (event.target !== header) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    return header;
  }

  createEntryRow(entry, section) {
    const staged = section === "staged";
    const doc = document;
    const row = doc.createElement("div");
    row.className = "git-file-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    const relativePath = entry.path;
    row.dataset.path = relativePath;
    row.dataset.gitFocusKey = `entry:${relativePath}`;
    const parts = GitSidebar.splitPath(relativePath);
    row.setAttribute(
      "aria-label",
      `${parts.name}${parts.dir ? ` in ${parts.dir}` : ""}, ${this.describeEntry(entry, staged)}`,
    );
    row.title = entry.originalPath
      ? `${relativePath} ← ${entry.originalPath}`
      : relativePath;
    if (this.operationPaths.has(relativePath)) row.classList.add("git-file-pending");

    const badge = doc.createElement("span");
    badge.className = "git-status-badge";
    badge.dataset.kind = entry.conflicted ? "conflicted" : entry.kind;
    badge.textContent = GitSidebar.statusLetter(entry, staged);

    const info = doc.createElement("span");
    info.className = "git-file-info";
    const name = doc.createElement("span");
    name.className = "git-file-name";
    name.textContent = parts.name;
    info.appendChild(name);
    if (parts.dir) {
      const directory = doc.createElement("span");
      directory.className = "git-file-dir";
      directory.textContent = parts.dir;
      info.appendChild(directory);
    }

    const actions = doc.createElement("span");
    actions.className = "git-file-actions";
    const action = doc.createElement("button");
    action.type = "button";
    action.className = "git-file-action";
    action.title = staged ? "Unstage File" : "Stage File";
    action.setAttribute("aria-label", `${action.title}: ${relativePath}`);
    action.disabled = this.operationPaths.has(relativePath);
    const icon = doc.createElement("i");
    icon.className = `fi ${staged ? "fi-rr-minus" : "fi-rr-plus"}`;
    icon.setAttribute("aria-hidden", "true");
    action.appendChild(icon);
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.toggleStage(entry, staged);
    });
    actions.appendChild(action);

    row.append(badge, info, actions);
    row.addEventListener("click", () => void this.openDiff(entry, staged));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void this.openDiff(entry, staged);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openFileContextMenu(entry, staged);
    });
    return row;
  }

  describeEntry(entry, staged) {
    const label = staged ? "staged" : "unstaged";
    return `${entry.kind}, ${label}`;
  }

  describeStatus() {
    const { staged, changes } = this.getSections();
    return {
      staged,
      changes,
      items: this.buildListItems(staged, changes),
    };
  }

  buildListItems(staged, changes) {
    const items = [];
    if (!this.status) return items;
    if (changes.length > 0) {
      items.push({
        type: "section",
        section: "changes",
        title: "Changes",
        count: changes.length,
        height: 24,
        rowHeight: 24,
      });
      if (this.collapsed.changes !== true) {
        for (const entry of changes)
          items.push({ type: "entry", section: "changes", entry, height: 25, rowHeight: 25 });
      }
    }
    if (staged.length > 0) {
      items.push({
        type: "section",
        section: "staged",
        title: "Staged Changes",
        count: staged.length,
        height: 24,
        rowHeight: 24,
      });
      if (this.collapsed.staged !== true) {
        for (const entry of staged)
          items.push({ type: "entry", section: "staged", entry, height: 25, rowHeight: 25 });
      }
    }
    return items;
  }

  renderList() {
    if (!this.fileScroller) return;
    const focusKey = this.captureListFocusKey();
    const { staged, changes } = this.getSections();
    this.fileScroller.setItems(this.buildListItems(staged, changes), {
      resetScroll: this.listResetPending,
    });
    this.listResetPending = false;
    if (focusKey) this.restoreListFocus(focusKey);
  }

  captureListFocusKey() {
    if (typeof document === "undefined") return null;
    const active = document.activeElement;
    const row = active?.closest?.(".git-file-row, .git-section-header");
    if (!row || !this.container?.contains?.(row)) return null;
    return row.dataset?.gitFocusKey || null;
  }

  restoreListFocus(focusKey) {
    const focusRow = (remaining) => {
      if (this.destroyed) return;
      const active = typeof document !== "undefined" ? document.activeElement : null;
      if (active && active !== document.body) return;
      const rows = this.container?.querySelectorAll?.(".git-file-row, .git-section-header") || [];
      for (const row of rows) {
        if (row.dataset?.gitFocusKey !== focusKey) continue;
        row.focus?.({ preventScroll: true });
        return;
      }
      if (remaining > 0) {
        if (typeof requestAnimationFrame === "function")
          requestAnimationFrame(() => focusRow(remaining - 1));
        else setTimeout(() => focusRow(remaining - 1), 16);
      }
    };
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => focusRow(8));
    else setTimeout(() => focusRow(8), 0);
  }

  getBranchName() {
    return this.status?.branch?.name || null;
  }

  openHeaderContextMenu() {
    this.editor.contextMenuManager?.openContextMenu("git-header", {
      sidebar: this,
    });
  }

  openFileContextMenu(entry, staged) {
    this.editor.contextMenuManager?.openContextMenu("git-file", {
      sidebar: this,
      entry,
      staged,
    });
  }

  toggleSection(section) {
    if (section !== "staged" && section !== "changes") return false;
    this.collapsed[section] = !this.collapsed[section];
    this.saveCollapsedState();
    this.renderList();
    return this.collapsed[section];
  }

  setActionError(message) {
    this.actionError = message || "";
    this.updateCommitControls();
  }

  notifyGit(options) {
    const manager = this.editor?.notificationManager;
    if (!manager || typeof manager.notify !== "function") return null;
    return manager.notify({ source: "Git", ...options });
  }

  clearTransientMessages() {
    this.actionError = "";
    this.commitError = "";
  }

  async toggleStage(entry, staged) {
    if (this.stagingAll || this.unstagingAll) return false;
    this.cancelScheduledRefresh();
    const filePath = GitSidebar.resolveAbsolutePath(this.workspaceRoot, entry?.path);
    if (!filePath) {
      this.setActionError("This change is outside the workspace.");
      return false;
    }
    if (this.operationPaths.has(entry.path)) return false;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.operationPaths.add(entry.path);
    this.actionError = "";
    this.notice = "";
    this.renderList();
    this.updateView();
    let result = null;
    try {
      result = staged
        ? await this.editor.api.git.unstageFile(filePath)
        : await this.editor.api.git.stageFile(filePath);
    } catch {
      result = null;
    }
    this.operationPaths.delete(entry.path);
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot))
      return false;
    if (result?.success === true) {
      this.notice = staged ? `Unstaged ${entry.path}` : `Staged ${entry.path}`;
    } else {
      this.actionError = result?.error || "The Git operation failed.";
      this.notifyGit({
        type: "error",
        title: staged ? "Could not unstage file" : "Could not stage file",
        message: this.actionError,
        actions: [{
          label: "Retry",
          action: () => {
            if (!this.destroyed) void this.toggleStage(entry, staged);
          },
        }],
      });
    }
    await this.refresh({ reason: "stage" });
    this.updateView();
    return result?.success === true;
  }

  async openDiff(entry, staged) {
    const filePath = GitSidebar.resolveAbsolutePath(this.workspaceRoot, entry?.path);
    if (!filePath) {
      this.setActionError("This change is outside the workspace.");
      return null;
    }
    const key = `${staged ? "staged" : "worktree"}:${entry.path}`;
    if (this.diffLoadingPaths.has(key)) return null;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.diffLoadingPaths.add(key);
    this.clearTransientMessages();
    this.notice = "Loading diff…";
    this.updateCommitControls();
    try {
      let versions = null;
      try {
        versions = await this.editor.api.git.getFileVersions(filePath, {
          staged: staged === true,
          originalPath: entry.originalPath || null,
        });
      } catch {
        versions = null;
      }
      if (this.destroyed ||
          workspaceGeneration !== this.workspaceGeneration ||
          !NCEPath.equals(workspaceRoot, this.workspaceRoot) ||
          !NCEPath.equals(workspaceRoot, this.editor.fileExplorer?.rootPath || ""))
        return null;
      if (!versions || versions.success !== true) {
        this.actionError = versions
          ? GitSidebar.describeError(versions)
          : "The diff could not be loaded.";
        return null;
      }
      return (await this.editor.tabManager?.openGitDiff?.({
        filePath,
        relativePath: entry.path,
        staged: staged === true,
        statusKind: entry.kind,
        originalPath: entry.originalPath || null,
        versions,
      })) || null;
    } finally {
      this.diffLoadingPaths.delete(key);
      if (this.notice === "Loading diff…") this.notice = "";
      this.updateCommitControls();
    }
  }

  async openEntryFile(entry) {
    const filePath = GitSidebar.resolveAbsolutePath(this.workspaceRoot, entry?.path);
    if (!filePath || entry.kind === "deleted") return null;
    return this.editor.tabManager?.openFileWithPath?.(filePath) ?? null;
  }

  async openBranchPicker(currentBranch = "") {
    if (this.destroyed || this.switchingBranch) return false;
    const quickPanel = this.editor.quickPanel;
    if (!quickPanel || typeof quickPanel.open !== "function") return false;
    let result = null;
    try {
      result = await this.editor.api.git.getBranches();
    } catch {
      result = null;
    }
    if (this.destroyed) return false;
    if (result?.success !== true) {
      this.notifyGit({
        type: "error",
        title: "Branches unavailable",
        message: result?.error || "Branches could not be loaded.",
      });
      return false;
    }
    const current = result.current ||
      String(currentBranch || "").trim() ||
      this.status?.branch?.name ||
      "";
    const branches = GitSidebar.sortBranches(result.branches);
    if (current && !branches.some((branch) => branch.name === current)) {
      branches.push({ name: current, current: true });
      branches.sort((left, right) => left.name.localeCompare(right.name));
    }
    const items = [
      { id: "create", label: "Create new branch", icon: "fi fi-rr-plus" },
      ...branches.map((branch, index) => ({
        id: `branch:${branch.name}`,
        label: branch.name,
        icon: "fi fi-rr-code-branch",
        checked: branch.current === true || branch.name === current,
        separatorBefore: index === 0,
        data: branch.name,
      })),
    ];
    return quickPanel.open({
      id: "git-branch-picker",
      mode: "pick",
      title: "Switch Branch",
      placeholder: "Switch Branch",
      preserveLabelCase: true,
      selectedId: `branch:${current}`,
      items,
      onAccept: (item) => {
        if (item.id === "create") {
          this.promptNewBranch();
          return;
        }
        void this.switchToBranch(item.data);
      },
    });
  }

  promptNewBranch() {
    const quickPanel = this.editor.quickPanel;
    if (!quickPanel || typeof quickPanel.open !== "function") return false;
    return quickPanel.open({
      id: "git-new-branch",
      mode: "input",
      title: "New Branch",
      placeholder: "Branch name",
      validate: (value) => GitSidebar.validateBranchName(value),
      onAccept: (value) => {
        void this.createNewBranch(String(value ?? "").trim());
      },
    });
  }

  async switchToBranch(name) {
    const target = String(name ?? "").trim();
    if (!target || target === this.getBranchLabel()) return false;
    return this.checkoutBranch(target, false);
  }

  async createNewBranch(name) {
    const target = String(name ?? "").trim();
    const validation = GitSidebar.validateBranchName(target);
    if (validation) {
      this.notifyGit({
        type: "error",
        title: "Invalid branch name",
        message: validation,
      });
      return false;
    }
    return this.checkoutBranch(target, true);
  }

  async checkoutBranch(name, create) {
    if (this.destroyed || this.switchingBranch) return false;
    this.cancelScheduledRefresh();
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.switchingBranch = true;
    this.updateView();
    let result = null;
    try {
      result = create
        ? await this.editor.api.git.createBranch(name)
        : await this.editor.api.git.switchBranch(name);
    } catch {
      result = null;
    }
    this.switchingBranch = false;
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.updateView();
      return false;
    }
    if (result?.success !== true) {
      this.notifyGit({
        type: "error",
        title: create ? "Could not create branch" : "Could not switch branch",
        message: result?.error || "The branch could not be switched.",
        actions: [{
          label: "Retry",
          action: () => {
            if (!this.destroyed) void this.checkoutBranch(name, create);
          },
        }],
      });
      this.updateView();
      return false;
    }
    await this.refresh({ reason: "branch" });
    this.updateView();
    return true;
  }

  async stageAllChanges() {
    if (this.destroyed || this.loading || this.committing ||
        this.stagingAll || this.unstagingAll)
      return false;
    this.cancelScheduledRefresh();
    const { changes } = this.getSections();
    if (!this.status || changes.length === 0) return false;
    const count = changes.length;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.stagingAll = true;
    this.actionError = "";
    this.notice = "";
    this.renderList();
    this.updateView();
    let result = null;
    try {
      result = await this.editor.api.git.stageAll();
    } catch {
      result = null;
    }
    this.stagingAll = false;
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.updateView();
      return false;
    }
    if (result?.success === true) {
      this.notice = count === 1 ? "Staged 1 change" : `Staged ${count} changes`;
    } else {
      this.actionError = result?.error || "The Git operation failed.";
      this.notifyGit({
        type: "error",
        title: "Could not stage all changes",
        message: this.actionError,
        actions: [{
          label: "Retry",
          action: () => {
            if (!this.destroyed) void this.stageAllChanges();
          },
        }],
      });
    }
    await this.refresh({ reason: "stage" });
    this.updateView();
    return result?.success === true;
  }

  async unstageAllChanges() {
    if (this.destroyed || this.loading || this.committing ||
        this.stagingAll || this.unstagingAll)
      return false;
    this.cancelScheduledRefresh();
    const { staged } = this.getSections();
    if (!this.status || staged.length === 0) return false;
    const count = staged.length;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.unstagingAll = true;
    this.actionError = "";
    this.notice = "";
    this.renderList();
    this.updateView();
    let result = null;
    try {
      result = await this.editor.api.git.unstageAll();
    } catch {
      result = null;
    }
    this.unstagingAll = false;
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.updateView();
      return false;
    }
    if (result?.success === true) {
      this.notice = count === 1
        ? "Unstaged 1 change"
        : `Unstaged ${count} changes`;
    } else {
      this.actionError = result?.error || "The Git operation failed.";
      this.notifyGit({
        type: "error",
        title: "Could not unstage all changes",
        message: this.actionError,
        actions: [{
          label: "Retry",
          action: () => {
            if (!this.destroyed) void this.unstageAllChanges();
          },
        }],
      });
    }
    await this.refresh({ reason: "stage" });
    this.updateView();
    return result?.success === true;
  }

  async commitChanges() {
    if (!this.canCommit()) return false;
    this.cancelScheduledRefresh();
    const message = this.commitMessage.trim();
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.committing = true;
    this.commitError = "";
    this.actionError = "";
    this.notice = "";
    this.updateView();
    let result = null;
    try {
      result = await this.editor.api.git.commit(message);
    } catch {
      result = null;
    }
    this.committing = false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.updateView();
      return false;
    }
    if (result?.success === true) {
      this.commitDrafts.delete(workspaceRoot);
      this.commitMessage = "";
      if (this.commitInput) this.commitInput.value = "";
      this.notice = `Committed ${String(result.hash || "").slice(0, 7)}`;
      this.notifyGit({
        type: "success",
        title: "Commit created",
        message: result.summary || message,
      });
      await this.refresh({ reason: "commit" });
    } else {
      const code = result?.code;
      this.commitError = code === "GIT_HOOK_FAILED"
        ? "A Git hook rejected the commit. The message was kept."
        : code === "EMPTY_COMMIT_MESSAGE"
          ? "Enter a commit message."
          : result?.error || "The commit failed.";
      if (code === "NOTHING_TO_COMMIT") {
        this.notifyGit({
          type: "info",
          title: "Nothing to commit",
          message: "There are no staged changes to commit.",
        });
        await this.refresh({ reason: "commit" });
      } else {
        this.notifyGit({
          type: "error",
          title: "Commit failed",
          message: this.commitError,
          persistent: code === "GIT_HOOK_FAILED" || code === "GIT_IDENTITY_MISSING",
          actions: [{
            label: "Retry",
            action: () => {
              if (!this.destroyed) void this.commitChanges();
            },
          }],
        });
      }
    }
    this.updateView();
    return result?.success === true;
  }

  async initializeRepository() {
    if (this.destroyed || this.initializing || this.loading) return false;
    this.cancelScheduledRefresh();
    const root = this.editor.fileExplorer?.rootPath || "";
    if (!root || this.error?.code !== "NOT_A_REPOSITORY") return false;
    const workspaceGeneration = this.workspaceGeneration;
    this.initializing = true;
    this.actionError = "";
    this.initError = "";
    this.notice = "";
    this.updateView();
    let result = null;
    try {
      result = await this.editor.api.git.init();
    } catch {
      result = null;
    }
    this.initializing = false;
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(root, this.editor.fileExplorer?.rootPath || "")) {
      this.updateView();
      return false;
    }
    if (result?.success === true) {
      this.notice = "Git repository initialized.";
      this.notifyGit({
        type: "success",
        title: "Git repository initialized",
        message: "Source Control is ready for this workspace.",
      });
      await this.refresh({ reason: "init" });
    } else {
      const failure = result || {
        code: "GIT_COMMAND_FAILED",
        error: "The Git repository could not be initialized.",
      };
      this.initError = GitSidebar.describeError(failure);
      if (failure.code === "GIT_NOT_FOUND") {
        this.applyStatusError(failure);
        this.notifyGit({
          type: "error",
          title: "Git is not available",
          message: this.initError,
        });
      } else {
        this.notifyGit({
          type: "error",
          title: "Git initialization failed",
          message: this.initError,
          actions: [{
            label: "Retry",
            action: () => {
              if (!this.destroyed) void this.initializeRepository();
            },
          }],
        });
      }
    }
    this.updateView();
    return result?.success === true;
  }

  async refresh({ reason = "manual" } = {}) {
    if (this.destroyed) return;
    this.initError = "";
    const root = this.editor.fileExplorer?.rootPath || "";
    if (!NCEPath.equals(root, this.workspaceRoot)) {
      this.applyWorkspace(root);
    }
    const generation = ++this.generation;
    if (!root) {
      this.status = null;
      this.error = null;
      this.loading = false;
      this.stale = false;
      this.renderList();
      this.updateView();
      this.editor.bottomBar?.refreshGitBranch?.();
      return;
    }
    this.loading = true;
    this.error = null;
    this.updateView();
    let result = null;
    try {
      result = await this.editor.api.git.getStatus();
    } catch {
      result = null;
    }
    if (generation !== this.generation) return;
    if (!NCEPath.equals(root, this.editor.fileExplorer?.rootPath || "")) return;
    this.loading = false;
    const statusError = !result
      ? { code: "GIT_COMMAND_FAILED", error: "Git status could not be read." }
      : result.success !== true
        ? result
        : null;
    if (statusError) {
      this.applyStatusError(statusError);
      if (reason === "manual" && statusError.code !== "NOT_A_REPOSITORY") {
        this.notifyGit({
          type: "error",
          title: "Source Control unavailable",
          message: GitSidebar.describeError(statusError),
        });
      }
    } else {
      this.status = result.status;
      this.error = null;
      this.stale = false;
    }
    if (reason === "open" || reason === "workspace")
      this.listResetPending = true;
    this.renderList();
    this.updateView();
    this.editor.bottomBar?.refreshGitBranch?.();
    if (reason === "stage" || reason === "commit" || reason === "branch" ||
        reason === "manual")
      void this.refreshDiffTabs();
  }

  async refreshDiffTabs() {
    const manager = this.editor.tabManager;
    if (!manager?.tabs || this.destroyed) return;
    const workspaceRoot = this.editor.fileExplorer?.rootPath || "";
    if (!workspaceRoot) return;
    const workspaceGeneration = this.workspaceGeneration;
    const tabs = manager.tabs.filter((tab) =>
      tab.type === "git-diff" && this.isPathInWorkspace(tab.filePath, workspaceRoot));
    for (const tab of tabs) {
      if (this.diffRefreshInFlight.has(tab)) continue;
      this.diffRefreshInFlight.add(tab);
      try {
        let versions = null;
        try {
          versions = await this.editor.api.git.getFileVersions(tab.filePath, {
            staged: tab.staged === true,
            originalPath: tab.originalPath || null,
          });
        } catch {
          versions = null;
        }
        if (this.destroyed ||
            workspaceGeneration !== this.workspaceGeneration ||
            !NCEPath.equals(workspaceRoot, this.editor.fileExplorer?.rootPath || ""))
          return;
        if (!versions || versions.success !== true) continue;
        await manager.openGitDiff?.({
          filePath: tab.filePath,
          relativePath: tab.relativePath,
          staged: tab.staged === true,
          statusKind: tab.statusKind,
          originalPath: tab.originalPath || null,
          versions,
          focus: false,
        });
      } catch {
        // A stale tab keeps its previous content; the next refresh retries.
      } finally {
        this.diffRefreshInFlight.delete(tab);
      }
    }
  }

  isPathInWorkspace(filePath, root = this.editor.fileExplorer?.rootPath) {
    if (typeof filePath !== "string" || typeof root !== "string" || !root)
      return false;
    const base = root.replace(/[\\/]+$/, "");
    return filePath === base || filePath.startsWith(`${base}/`) ||
      filePath.startsWith(`${base}\\`);
  }

  applyStatusError(result) {
    const code = result?.code;
    const terminal = code === "GIT_NOT_FOUND" ||
      code === "NOT_A_REPOSITORY" ||
      code === "REPOSITORY_NOT_FOUND" ||
      code === "PERMISSION_DENIED" ||
      code === "GIT_OUTPUT_LIMIT";
    this.error = {
      code: code || "GIT_COMMAND_FAILED",
      message: GitSidebar.describeError(result),
    };
    if (terminal) {
      this.status = null;
      this.stale = false;
    } else {
      this.stale = Boolean(this.status);
    }
  }

  applyWorkspace(root) {
    this.switchingBranch = false;
    if (this.workspaceRoot && this.commitMessage.trim())
      this.commitDrafts.set(this.workspaceRoot, this.commitMessage);
    this.workspaceRoot = root;
    this.workspaceGeneration++;
    this.generation++;
    this.status = null;
    this.error = null;
    this.stale = false;
    this.loading = false;
    this.commitMessage = root ? this.commitDrafts.get(root) || "" : "";
    this.commitError = "";
    this.actionError = "";
    this.initError = "";
    this.notice = "";
    this.operationPaths.clear();
    this.diffRefreshInFlight.clear();
    this.listResetPending = true;
    if (this.commitInput) this.commitInput.value = this.commitMessage;
    this.renderList();
    this.updateView();
  }

  handleWorkspaceChanged(rootPath) {
    const root = typeof rootPath === "string"
      ? rootPath
      : this.editor.fileExplorer?.rootPath || "";
    this.applyWorkspace(root);
    if (this.isOpen && root) void this.refresh({ reason: "workspace" });
    else this.editor.bottomBar?.refreshGitBranch?.();
  }

  isMutating() {
    return this.committing || this.switchingBranch || this.stagingAll ||
      this.unstagingAll || this.initializing;
  }

  cancelScheduledRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  handleFileSystemEvents() {
    if (!this.isOpen || this.isMutating()) return;
    this.scheduleRefresh();
  }

  noteEditorSave() {
    if (!this.isOpen || this.isMutating()) return;
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    if (this.destroyed) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.isMutating()) return;
      void this.refresh({ reason: "watcher" });
    }, 300);
  }

  onOpen() {
    this.workspaceRoot = this.editor.fileExplorer?.rootPath || "";
    this.listResetPending = true;
    this.fileScroller?.resume?.();
    void this.refresh({ reason: "open" });
  }

  onClose() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.fileScroller?.suspend?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.commitResizeObserver?.disconnect();
    this.commitResizeObserver = null;
    this.unsubscribeFileSystem?.();
    this.unsubscribeFileSystem = null;
    this.fileScroller?.destroy?.();
    this.fileScroller = null;
    this.container?.remove();
    this.container = null;
  }
}
