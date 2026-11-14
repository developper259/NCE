class GitSidebar extends Sidebar {
  static COMMIT_INPUT_MAX_HEIGHT = 160;
  static HISTORY_PAGE_SIZE = 50;
  static MAX_HISTORY_COMMITS = 500;
  static MAX_COMMIT_REF_BADGES = 2;
  static DETAIL_ROW_HEIGHT = 16;
  static DETAIL_NAV_HEIGHT = 26;
  static DETAIL_FILE_HEIGHT = 20;
  static DETAIL_MESSAGE_HEIGHT = 24;
  static DETAIL_GAP = 2;
  static DETAIL_PADDING = 10;
  static MAX_DISCARD_LIST_ROWS = 8;
  static COMMIT_FILE_LETTERS = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    copied: "C",
  };
  static HISTORY_REFRESH_REASONS = new Set(["commit", "branch", "init", "manual", "settings"]);

  static emptyHistory() {
    return {
      commits: [],
      hasMore: false,
      loading: false,
      error: "",
      loaded: false,
      truncated: false,
      pendingReset: false,
    };
  }

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

  static syncSuccessTitle(operation) {
    if (operation === "fetch") return "Fetched";
    if (operation === "pull") return "Pulled";
    return "Pushed";
  }

  static syncFailureTitle(operation) {
    if (operation === "fetch") return "Fetch failed";
    if (operation === "pull") return "Pull failed";
    return "Push failed";
  }

  static syncSuccessMessage(operation, result) {
    if (operation === "fetch") {
      if (result?.all) return "Fetched updates from all remotes.";
      return result?.remote
        ? `Fetched updates from ${result.remote}.`
        : "Fetched updates.";
    }
    if (operation === "pull")
      return result?.alreadyUpToDate ? "Already up to date." : "Pulled the latest changes.";
    const remote = result?.remote;
    const branch = result?.branch;
    const target = remote && branch ? `${branch} to ${remote}` : "the current branch";
    return result?.forced
      ? `Force pushed ${target} with lease.`
      : `Pushed ${target}.`;
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

  static shortHash(hash) {
    return String(hash || "").slice(0, 7);
  }

  static plural(count, unit) {
    return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }

  static formatCommitDate(timestamp, now = Date.now()) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const elapsed = Math.max(0, Math.floor(now / 1000 - seconds));
    if (elapsed < 60) return "just now";
    if (elapsed < 3600) return GitSidebar.plural(Math.floor(elapsed / 60), "minute");
    if (elapsed < 86400) return GitSidebar.plural(Math.floor(elapsed / 3600), "hour");
    if (elapsed < 604800) return GitSidebar.plural(Math.floor(elapsed / 86400), "day");
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }

  static formatCommitTimestamp(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
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
    this.stateInstall = null;
    this.initializing = false;
    this.installingGit = false;
    this.installProgress = null;
    this.unsubscribeInstallProgress = null;
    this.listElement = null;
    this.listViewport = null;
    this.listLayer = null;
    this.collapsedBar = null;

    this.fileScroller = new SearchResultsScroller(
      editor,
      (item) => this.createListItem(item),
      () => this.handleListNearEnd(),
    );

    this.workspaceRoot = "";
    this.workspaceGeneration = 0;
    this.commitDrafts = new Map();
    this.sectionsCacheStatus = null;
    this.sectionsCache = null;
    this.diffRefreshInFlight = new Set();
    this.status = null;
    this.history = GitSidebar.emptyHistory();
    this.selectedCommit = null;
    this.commitDetail = null;
    this.compare = null;
    this.compareBase = null;
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
    this.selectedEntries = new Map();
    this.selectionAnchor = null;
    this.discarding = false;
    this.aborting = false;
    this.operationBanner = null;
    this.operationBannerText = null;
    this.operationBannerButton = null;
    this.operationDialog = null;
    this.operationDialogSession = null;
    this.syncing = null;
    this.syncProgress = null;
    this.unsubscribeNetworkProgress = null;
    this.syncBar = null;
    this.syncFetchButton = null;
    this.syncPullButton = null;
    this.syncPushButton = null;
    this.syncPullCount = null;
    this.syncPushCount = null;
    this.syncRemotesButton = null;
    this.syncStatus = null;
    this.syncCancelButton = null;
    this.remotes = [];
    this.defaultRemote = null;
    this.remotesDialog = null;
    this.remotesDialogSession = null;
    this.remotesBusy = false;
    this.remotesEditing = null;
    this.remotesPendingRemove = null;
    this.remotesList = null;
    this.remotesError = null;
    this.remotesAddName = null;
    this.remotesAddUrl = null;
    this.remotesAddButton = null;
    this.remotesCloseButton = null;
    this.stateClone = null;
    this.cloneDialog = null;
    this.cloneDialogSession = null;
    this.cloneBusy = false;
    this.cloneProgress = null;
    this.cloneDestination = "";
    this.cloneUrlInput = null;
    this.cloneFolderInput = null;
    this.cloneDestinationInput = null;
    this.cloneBrowseButton = null;
    this.cloneCloneButton = null;
    this.cloneCancelButton = null;
    this.cloneError = null;
    this.cloneProgressElement = null;
    this.cloneProgressBar = null;
    this.cloneProgressText = null;
    this.diffLoadingPaths = new Set();
    this.generation = 0;
    this.refreshTimer = null;
    this.listResetPending = true;
    this.destroyed = false;
    this.collapsed = { staged: false, changes: false, history: true };
    this.loadCollapsedState();

    this.unsubscribeFileSystem =
      editor.api?.onFileSystemChange?.((events) =>
        this.handleFileSystemEvents(events)) || null;
    this.unsubscribeNetworkProgress =
      editor.api?.git?.onNetworkProgress?.((progress) =>
        this.handleNetworkProgress(progress)) || null;
  }

  loadCollapsedState() {
    try {
      if (typeof localStorage === "undefined") return;
      const stored = JSON.parse(localStorage.getItem("nce.gitSidebar.collapsed") || "null");
      if (!stored || typeof stored !== "object") return;
      this.collapsed.staged = stored.staged === true;
      this.collapsed.changes = stored.changes === true;
      this.collapsed.history = stored.history !== false;
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

    const stateInstall = document.createElement("button");
    stateInstall.type = "button";
    stateInstall.className = "git-sidebar-state-button";
    stateInstall.textContent = "Install Git";
    stateInstall.title = "Download a verified Git build and configure NCE to use it";
    stateInstall.setAttribute("aria-label", "Install Git");
    stateInstall.dataset.action = "install";
    stateInstall.addEventListener("click", () => void this.installGit());
    this.stateInstall = stateInstall;

    const stateSettings = document.createElement("button");
    stateSettings.type = "button";
    stateSettings.className = "git-sidebar-state-button";
    stateSettings.textContent = "Go to Settings";
    stateSettings.title = "Open Git settings to configure the Git executable path";
    stateSettings.dataset.action = "settings";
    stateSettings.addEventListener("click", () => void this.openGitSettings());

    const stateClone = document.createElement("button");
    stateClone.type = "button";
    stateClone.className = "git-sidebar-state-button";
    stateClone.textContent = "Clone Repository";
    stateClone.title = "Clone a remote repository into a folder you choose";
    stateClone.setAttribute("aria-label", "Clone a repository");
    stateClone.dataset.action = "clone";
    stateClone.addEventListener("click", () => void this.openCloneDialog());
    this.stateClone = stateClone;

    stateActions.append(stateInit, stateRefresh, stateRetry, stateInstall, stateSettings, stateClone);
    state.append(stateHeading, stateActions);
    this.stateElement = state;
    this.stateIconElement = stateIcon;
    this.stateTitleElement = stateTitle;
    this.stateText = stateText;
    this.stateDetailsElement = stateDetails;
    this.stateCodeElement = stateCode;
    this.stateRetry = stateRetry;
    this.stateSettings = stateSettings;

    const banner = document.createElement("div");
    banner.className = "git-operation-banner";
    banner.hidden = true;
    banner.setAttribute("role", "status");
    const bannerIcon = document.createElement("i");
    bannerIcon.className = "fi fi-rr-triangle-warning";
    bannerIcon.setAttribute("aria-hidden", "true");
    const bannerText = document.createElement("span");
    bannerText.className = "git-operation-banner-text";
    const bannerButton = document.createElement("button");
    bannerButton.type = "button";
    bannerButton.className = "git-operation-banner-button";
    bannerButton.addEventListener("click", () => void this.requestAbortOperation());
    banner.append(bannerIcon, bannerText, bannerButton);
    this.operationBanner = banner;
    this.operationBannerText = bannerText;
    this.operationBannerButton = bannerButton;

    const syncBar = document.createElement("div");
    syncBar.className = "git-sync-bar";
    syncBar.hidden = true;
    syncBar.setAttribute("role", "group");
    syncBar.setAttribute("aria-label", "Remote synchronization");

    const makeSyncButton = (action, iconClass, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "git-sync-button";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.dataset.action = action;
      const icon = document.createElement("i");
      icon.className = iconClass;
      icon.setAttribute("aria-hidden", "true");
      button.appendChild(icon);
      return button;
    };

    const fetchButton = makeSyncButton("fetch", "fi fi-rr-refresh", "Fetch");
    fetchButton.addEventListener("click", () => void this.fetchChanges());
    this.syncFetchButton = fetchButton;

    const pullButton = makeSyncButton("pull", "fi fi-rr-arrow-up git-sync-pull-icon", "Pull");
    const pullCount = document.createElement("span");
    pullCount.className = "git-sync-count";
    pullCount.hidden = true;
    pullButton.appendChild(pullCount);
    pullButton.addEventListener("click", () => void this.pullChanges());
    this.syncPullButton = pullButton;
    this.syncPullCount = pullCount;

    const pushButton = makeSyncButton("push", "fi fi-rr-arrow-up", "Push");
    const pushCount = document.createElement("span");
    pushCount.className = "git-sync-count";
    pushCount.hidden = true;
    pushButton.appendChild(pushCount);
    pushButton.addEventListener("click", () => void this.pushChanges());
    this.syncPushButton = pushButton;
    this.syncPushCount = pushCount;

    const syncStatus = document.createElement("span");
    syncStatus.className = "git-sync-status";
    syncStatus.setAttribute("role", "status");
    syncStatus.setAttribute("aria-live", "polite");
    syncStatus.hidden = true;
    this.syncStatus = syncStatus;

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "git-sync-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.title = "Cancel the running operation";
    cancelButton.setAttribute("aria-label", "Cancel the running operation");
    cancelButton.hidden = true;
    cancelButton.addEventListener("click", () => void this.cancelSync());
    this.syncCancelButton = cancelButton;

    const remotesButton = makeSyncButton("remotes", "fi fi-rr-settings-sliders", "Manage Remotes");
    remotesButton.setAttribute("aria-haspopup", "dialog");
    remotesButton.addEventListener("click", () => void this.openRemotesDialog());
    this.syncRemotesButton = remotesButton;

    syncBar.append(fetchButton, pullButton, pushButton, syncStatus, cancelButton, remotesButton);
    this.syncBar = syncBar;

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

    // Collapsed section headers live in their own flex-pinned bar so they always
    // sit at the bottom, just above the commit input, while expanded sections
    // stack at the top of the virtual list (accordion layout).
    const collapsedBar = document.createElement("div");
    collapsedBar.className = "git-collapsed-bar";
    collapsedBar.hidden = true;
    this.collapsedBar = collapsedBar;

    container.append(header, state, banner, syncBar, list, collapsedBar, commitBox);
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
        this.unstagingAll || this.discarding || this.aborting || Boolean(this.syncing);
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
        this.committing || this.stagingAll || this.unstagingAll ||
        this.discarding || this.aborting || Boolean(this.syncing);
      this.autoResizeCommitInput();
    }
    this.updateCommitControls();
    this.updateState();
    this.updateOperationBanner();
    this.updateSyncBar();
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
    if (this.installingGit) {
      const progress = this.installProgress;
      const percent = typeof progress?.percent === "number"
        ? ` ${progress.percent}%`
        : "";
      return {
        icon: "fi-rr-refresh",
        tone: "muted",
        title: "Installing Git…",
        description: `${progress?.message || "Downloading a verified Git build."}${percent}`,
        spinning: true,
        busy: true,
      };
    }
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
    if (this.installingGit) return "Installing Git…";
    if (view.mode === "no-workspace") return "Open a folder to review its changes.";
    if (view.mode === "no-repository") return "This workspace is not a Git repository.";
    if (view.mode === "init-error" || view.mode === "error") return view.message;
    if (view.mode === "loading") return "Loading Source Control…";
    return "";
  }

  getStateActions() {
    const view = this.getViewState();
    if (this.installingGit) {
      return { init: false, refresh: false, retry: false, install: false, settings: false, clone: false };
    }
    if (view.mode === "no-repository" || view.mode === "init-error") {
      return { init: true, refresh: true, retry: false, install: false, settings: false, clone: true };
    }
    if (view.mode === "no-workspace") {
      return { init: false, refresh: false, retry: false, install: false, settings: false, clone: true };
    }
    if (view.mode === "error") {
      return {
        init: false,
        refresh: false,
        retry: view.errorCode !== "GIT_NOT_FOUND" &&
          view.errorCode !== "GIT_OUTPUT_LIMIT",
        install: view.errorCode === "GIT_NOT_FOUND",
        settings: view.errorCode === "GIT_NOT_FOUND",
        clone: false,
      };
    }
    if (view.mode === "clean") {
      return { init: false, refresh: true, retry: false, install: false, settings: false, clone: false };
    }
    return { init: false, refresh: false, retry: false, install: false, settings: false, clone: false };
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
    const busy = this.loading || this.initializing || this.installingGit;
    const primary = actions.init
      ? this.stateInit
      : actions.install
        ? this.stateInstall
        : actions.retry
          ? this.stateRetry
          : actions.settings
            ? this.stateSettings
            : actions.clone
              ? this.stateClone
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
    if (this.stateInstall) {
      this.stateInstall.hidden = !actions.install;
      this.stateInstall.disabled = busy;
      if (this.installingGit) this.stateInstall.setAttribute("aria-busy", "true");
      else this.stateInstall.removeAttribute("aria-busy");
    }
    if (this.stateSettings) {
      this.stateSettings.hidden = !actions.settings;
      this.stateSettings.disabled = busy;
    }
    if (this.stateClone) {
      this.stateClone.hidden = !actions.clone;
      this.stateClone.disabled = busy || this.cloneBusy;
    }
    for (const button of [
      this.stateInit,
      this.stateRetry,
      this.stateRefresh,
      this.stateInstall,
      this.stateSettings,
      this.stateClone,
    ]) {
      button?.classList.toggle("git-sidebar-primary", button === primary);
    }

    if (this.commitBoxElement)
      this.commitBoxElement.hidden = view.mode !== "changes";
    if (this.listElement)
      this.listElement.hidden = view.mode !== "changes" && view.mode !== "clean";
    this.syncCollapsedBarVisibility();
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
      !this.discarding &&
      !this.aborting &&
      !this.loading &&
      !this.stale;
  }

  createListItem(item) {
    if (item.type === "section") return this.createSectionHeader(item);
    if (item.type === "entry") return this.createEntryRow(item.entry, item.section);
    if (item.type === "commit") return this.createCommitRow(item.commit);
    if (item.type === "commit-detail") return this.createCommitDetail(item.commit);
    if (item.type === "compare-detail") return this.createCompareDetail(item.commit);
    if (item.type === "history-more") return this.createHistoryMoreRow();
    const empty = document.createElement("div");
    empty.className = "git-sidebar-empty";
    empty.textContent = item.text;
    if (item.action === "retry-history") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "git-sidebar-state-button";
      retry.textContent = "Retry";
      retry.dataset.action = "retry-history";
      retry.addEventListener("click", () => void this.loadHistory({ reset: true }));
      empty.appendChild(retry);
    }
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
      action.dataset.action = staging ? "stage-all" : "unstage-all";
      action.disabled = this.loading || this.isMutating();
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

      const discard = document.createElement("button");
      discard.type = "button";
      discard.className = "git-section-action git-section-discard";
      discard.title = staging ? "Discard all changes" : "Discard all staged changes";
      discard.setAttribute("aria-label", discard.title);
      discard.dataset.action = staging ? "discard-all" : "discard-all-staged";
      discard.disabled = this.loading || this.isMutating() ||
        !this.getSections()[item.section].some((entry) => !entry.conflicted);
      if (this.discarding) discard.setAttribute("aria-busy", "true");
      const discardIcon = document.createElement("i");
      discardIcon.className = "fi fi-rr-undo";
      discardIcon.setAttribute("aria-hidden", "true");
      discard.appendChild(discardIcon);
      discard.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.requestDiscardAll(item.section);
      });
      header.append(discard, action);
    }
    const toggle = () => this.toggleSection(item.section);
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
    row.dataset.section = section;
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
    if (this.selectedEntries.has(this.selectionKey(entry, staged)))
      row.classList.add("is-selected");

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
    row.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        this.toggleEntrySelection(entry, staged);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        this.selectEntryRange(entry, staged);
        return;
      }
      this.clearEntrySelection();
      void this.openDiff(entry, staged);
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Delete") {
        event.preventDefault();
        const key = this.selectionKey(entry, staged);
        const targets = this.selectedEntries.has(key) && this.selectedEntries.size > 1
          ? this.getSelectedTargets()
          : [{ entry, staged }];
        void this.requestDiscard(targets);
        return;
      }
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

  selectionKey(entry, staged) {
    return `${staged === true ? "s" : "c"}:${entry?.path || ""}`;
  }

  liveTargetMap({ excludeConflicted = false } = {}) {
    const { staged, changes } = this.getSections();
    const live = new Map();
    for (const entry of staged) {
      if (excludeConflicted && entry.conflicted) continue;
      live.set(this.selectionKey(entry, true), { entry, staged: true });
    }
    for (const entry of changes) {
      if (excludeConflicted && entry.conflicted) continue;
      live.set(this.selectionKey(entry, false), { entry, staged: false });
    }
    return live;
  }

  getSelectedTargets() {
    const live = this.liveTargetMap();
    const targets = [];
    for (const key of this.selectedEntries.keys()) {
      const target = live.get(key);
      if (target) targets.push(target);
    }
    return targets;
  }

  toggleEntrySelection(entry, staged) {
    const key = this.selectionKey(entry, staged);
    if (this.selectedEntries.has(key)) this.selectedEntries.delete(key);
    else this.selectedEntries.set(key, true);
    this.selectionAnchor = key;
    this.renderList();
  }

  selectEntryRange(entry, staged) {
    const key = this.selectionKey(entry, staged);
    const section = staged === true ? "staged" : "changes";
    const entries = this.getSections()[section];
    const targetIndex = entries.findIndex((candidate) => candidate.path === entry.path);
    const anchorSection = this.selectionAnchor?.startsWith("s:") ? "staged" : "changes";
    const anchorIndex = this.selectionAnchor && anchorSection === section
      ? entries.findIndex((candidate) => candidate.path === this.selectionAnchor.slice(2))
      : -1;
    if (targetIndex < 0) return;
    if (anchorIndex < 0) {
      this.selectedEntries.set(key, true);
    } else {
      const from = Math.min(anchorIndex, targetIndex);
      const to = Math.max(anchorIndex, targetIndex);
      for (let index = from; index <= to; index++)
        this.selectedEntries.set(this.selectionKey(entries[index], staged), true);
    }
    if (!this.selectionAnchor) this.selectionAnchor = key;
    this.renderList();
  }

  clearEntrySelection() {
    this.selectionAnchor = null;
    if (this.selectedEntries.size === 0) return;
    this.selectedEntries.clear();
    this.renderList();
  }

  pruneEntrySelection() {
    if (this.selectedEntries.size === 0) return;
    const live = this.liveTargetMap();
    for (const key of [...this.selectedEntries.keys()])
      if (!live.has(key)) this.selectedEntries.delete(key);
    if (this.selectionAnchor && !live.has(this.selectionAnchor))
      this.selectionAnchor = null;
  }

  describeStatus() {
    const { staged, changes } = this.getSections();
    return {
      staged,
      changes,
      items: this.buildListItems(staged, changes),
      collapsed: this.buildCollapsedSections(staged, changes),
    };
  }

  sectionDescriptor(section, title, count) {
    return { type: "section", section, title, count, height: 24, rowHeight: 24 };
  }

  buildListItems(staged, changes) {
    const items = [];
    if (!this.status) return items;
    if (changes.length > 0 && this.collapsed.changes !== true) {
      items.push(this.sectionDescriptor("changes", "Changes", changes.length));
      for (const entry of changes)
        items.push({ type: "entry", section: "changes", entry, height: 25, rowHeight: 25 });
    }
    if (staged.length > 0 && this.collapsed.staged !== true) {
      items.push(this.sectionDescriptor("staged", "Staged Changes", staged.length));
      for (const entry of staged)
        items.push({ type: "entry", section: "staged", entry, height: 25, rowHeight: 25 });
    }
    if (this.collapsed.history !== true) {
      items.push(this.sectionDescriptor("history", "History", this.history.commits.length));
      items.push(...this.buildHistoryItems());
    }
    return items;
  }

  buildCollapsedSections(staged, changes) {
    const sections = [];
    if (!this.status) return sections;
    if (changes.length > 0 && this.collapsed.changes === true)
      sections.push(this.sectionDescriptor("changes", "Changes", changes.length));
    if (staged.length > 0 && this.collapsed.staged === true)
      sections.push(this.sectionDescriptor("staged", "Staged Changes", staged.length));
    if (this.collapsed.history === true)
      sections.push(this.sectionDescriptor("history", "History", this.history.commits.length));
    return sections;
  }

  buildHistoryItems() {
    const items = [];
    const { commits, loading, error, hasMore, loaded, truncated } = this.history;
    for (const commit of commits) {
      items.push({ type: "commit", commit, height: 40, rowHeight: 40 });
      if (this.selectedCommit !== commit.hash) continue;
      if (this.compare && this.compare.target === commit.hash) {
        const height = this.compareDetailHeight();
        items.push({ type: "compare-detail", commit, height, rowHeight: height });
      } else {
        const height = this.commitDetailHeight(commit);
        items.push({ type: "commit-detail", commit, height, rowHeight: height });
      }
    }
    if (loading)
      items.push({ type: "message", text: "Loading history…", height: 24, rowHeight: 24 });
    else if (error)
      items.push({ type: "message", text: error, action: "retry-history", height: 24, rowHeight: 24 });
    else if (hasMore)
      items.push({ type: "history-more", height: 26, rowHeight: 26 });
    else if (truncated)
      items.push({
        type: "message",
        text: `Showing the most recent ${GitSidebar.MAX_HISTORY_COMMITS} commits.`,
        height: 24,
        rowHeight: 24,
      });
    else if (loaded && commits.length === 0)
      items.push({ type: "message", text: "No commits yet.", height: 24, rowHeight: 24 });
    return items;
  }

  commitDetailHeight(commit) {
    const heights = [
      GitSidebar.DETAIL_ROW_HEIGHT,
      GitSidebar.DETAIL_ROW_HEIGHT,
      GitSidebar.DETAIL_ROW_HEIGHT,
    ];
    if (commit?.refs?.length) heights.push(GitSidebar.DETAIL_ROW_HEIGHT);
    heights.push(GitSidebar.DETAIL_NAV_HEIGHT);
    if (this.compareBase === commit?.hash) heights.push(GitSidebar.DETAIL_ROW_HEIGHT);
    heights.push(GitSidebar.DETAIL_ROW_HEIGHT);
    const state = this.commitDetail?.hash === commit?.hash ? this.commitDetail : null;
    heights.push(...this.commitFilesHeights(state));
    return heights.reduce((total, value) => total + value, 0) +
      GitSidebar.DETAIL_GAP * (heights.length - 1) + GitSidebar.DETAIL_PADDING;
  }

  compareDetailHeight() {
    const heights = [
      GitSidebar.DETAIL_ROW_HEIGHT,
      GitSidebar.DETAIL_NAV_HEIGHT,
      GitSidebar.DETAIL_ROW_HEIGHT,
      ...this.commitFilesHeights(this.compare),
    ];
    return heights.reduce((total, value) => total + value, 0) +
      GitSidebar.DETAIL_GAP * (heights.length - 1) + GitSidebar.DETAIL_PADDING;
  }

  commitFilesHeights(state) {
    if (!state || state.loading || state.error) return [GitSidebar.DETAIL_MESSAGE_HEIGHT];
    const heights = state.files.map(() => GitSidebar.DETAIL_FILE_HEIGHT);
    if (state.files.length === 0) heights.push(GitSidebar.DETAIL_MESSAGE_HEIGHT);
    if (state.truncated) heights.push(GitSidebar.DETAIL_MESSAGE_HEIGHT);
    return heights;
  }

  createCommitRow(commit) {
    const doc = document;
    const row = doc.createElement("div");
    row.className = "git-commit-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.dataset.hash = commit.hash;
    row.dataset.gitFocusKey = `commit:${commit.hash}`;
    const selected = this.selectedCommit === commit.hash;
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-expanded", String(selected));
    row.setAttribute(
      "aria-label",
      `${commit.subject || "(no message)"}, ${GitSidebar.shortHash(commit.hash)} by ${commit.author}`,
    );
    row.title = `${commit.subject || "(no message)"}\n${commit.hash}`;

    const main = doc.createElement("span");
    main.className = "git-commit-main";
    const subject = doc.createElement("span");
    subject.className = "git-commit-subject";
    subject.textContent = commit.subject || "(no message)";
    const meta = doc.createElement("span");
    meta.className = "git-commit-meta";
    meta.textContent = [
      GitSidebar.shortHash(commit.hash),
      commit.author,
      GitSidebar.formatCommitDate(commit.timestamp),
    ].filter(Boolean).join(" · ");
    main.append(subject, meta);
    row.appendChild(main);
    if (commit.refs?.length) row.appendChild(this.createCommitRefs(commit.refs));

    const toggle = () => this.selectCommit(commit.hash);
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    return row;
  }

  createCommitRefs(refs) {
    const wrap = document.createElement("span");
    wrap.className = "git-commit-refs";
    // Only HEAD and tags name a commit usefully; a wall of branch names does not.
    const named = [
      ...refs.filter((ref) => ref.startsWith("HEAD")),
      ...refs.filter((ref) => ref.startsWith("tag: ")),
    ];
    const shown = named.slice(0, GitSidebar.MAX_COMMIT_REF_BADGES);
    for (const ref of shown) {
      const badge = document.createElement("span");
      badge.className = "git-commit-ref";
      badge.textContent = ref.replace(/^HEAD -> /, "");
      badge.title = ref;
      if (ref.startsWith("HEAD -> ")) badge.dataset.current = "true";
      wrap.appendChild(badge);
    }
    const hidden = refs.filter((ref) => !shown.includes(ref));
    if (hidden.length > 0) {
      const more = document.createElement("span");
      more.className = "git-commit-ref git-commit-ref-more";
      more.textContent = `+${hidden.length}`;
      more.title = hidden.join(", ");
      wrap.appendChild(more);
    }
    return wrap;
  }

  createCommitDetail(commit) {
    const doc = document;
    const detail = doc.createElement("div");
    detail.className = "git-commit-detail";
    detail.dataset.gitFocusKey = `commit-detail:${commit.hash}`;
    const addRow = (label, value, { code = false, copy = false } = {}) => {
      const row = doc.createElement("div");
      row.className = "git-commit-detail-row";
      const name = doc.createElement("span");
      name.className = "git-commit-detail-label";
      name.textContent = label;
      const text = doc.createElement(code ? "code" : "span");
      text.className = "git-commit-detail-value";
      text.textContent = value;
      row.append(name, text);
      if (copy) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "git-file-action git-commit-copy";
        button.title = "Copy Commit Hash";
        button.setAttribute("aria-label", "Copy Commit Hash");
        const icon = doc.createElement("i");
        icon.className = "fi fi-rr-copy";
        icon.setAttribute("aria-hidden", "true");
        button.appendChild(icon);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          void this.editor.api?.writeClipboardText?.(commit.hash);
        });
        row.appendChild(button);
      }
      detail.appendChild(row);
    };
    addRow("Commit", commit.hash, { code: true, copy: true });
    addRow("Author", commit.email ? `${commit.author} <${commit.email}>` : commit.author);
    addRow("Date", GitSidebar.formatCommitTimestamp(commit.timestamp));
    if (commit.refs?.length) addRow("Refs", commit.refs.join(", "));
    detail.appendChild(this.createCommitNav(commit));
    if (this.compareBase === commit.hash) {
      const hint = doc.createElement("div");
      hint.className = "git-commit-detail-hint";
      hint.textContent = "Select another commit to compare.";
      detail.appendChild(hint);
    }
    const state = this.commitDetail?.hash === commit.hash ? this.commitDetail : null;
    detail.appendChild(this.createCommitFilesSection(commit.hash, state, null));
    return detail;
  }

  createCompareDetail(commit) {
    const doc = document;
    const compare = this.compare;
    const detail = doc.createElement("div");
    detail.className = "git-commit-detail git-compare-detail";
    detail.dataset.gitFocusKey = `compare-detail:${commit.hash}`;
    const row = doc.createElement("div");
    row.className = "git-commit-detail-row";
    const label = doc.createElement("span");
    label.className = "git-commit-detail-label";
    label.textContent = "Compare";
    const value = doc.createElement("span");
    value.className = "git-commit-detail-value";
    value.textContent = `${GitSidebar.shortHash(compare.base)} → ${GitSidebar.shortHash(compare.target)}`;
    value.title = `${compare.base} → ${compare.target}`;
    row.append(label, value);
    detail.appendChild(row);

    const nav = doc.createElement("div");
    nav.className = "git-commit-nav";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "git-commit-nav-button";
    cancel.textContent = "Cancel Comparison";
    cancel.dataset.action = "cancel-compare";
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      this.cancelCompare();
    });
    nav.appendChild(cancel);
    detail.appendChild(nav);
    detail.appendChild(this.createCommitFilesSection(compare.target, compare, compare.base));
    return detail;
  }

  createCommitNav(commit) {
    const doc = document;
    const nav = doc.createElement("div");
    nav.className = "git-commit-nav";
    const index = this.history.commits.findIndex((entry) => entry.hash === commit.hash);
    const newer = index > 0 ? this.history.commits[index - 1] : null;
    const older = index >= 0 && index < this.history.commits.length - 1
      ? this.history.commits[index + 1]
      : null;
    const makeButton = (text, title, target, action) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "git-commit-nav-button";
      button.textContent = text;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.dataset.action = action;
      button.disabled = !target;
      if (target) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.selectCommit(target.hash);
        });
      }
      return button;
    };
    nav.append(
      makeButton("Newer", "Select the newer commit", newer, "commit-newer"),
      makeButton("Older", "Select the older commit", older, "commit-older"),
    );
    const compare = doc.createElement("button");
    compare.type = "button";
    compare.className = "git-commit-nav-button";
    compare.textContent = "Compare";
    compare.title = "Compare this commit with another one";
    compare.setAttribute("aria-label", compare.title);
    compare.dataset.action = "commit-compare";
    compare.addEventListener("click", (event) => {
      event.stopPropagation();
      this.beginCompare(commit.hash);
    });
    nav.appendChild(compare);
    return nav;
  }

  createCommitFilesSection(hash, state, baseHash) {
    const doc = document;
    const section = doc.createElement("div");
    section.className = "git-commit-files";
    const header = doc.createElement("div");
    header.className = "git-commit-detail-row";
    const label = doc.createElement("span");
    label.className = "git-commit-detail-label";
    label.textContent = "Files";
    const count = doc.createElement("span");
    count.className = "git-commit-detail-value";
    count.textContent = state && !state.loading && !state.error
      ? String(state.files.length)
      : "";
    header.append(label, count);
    section.appendChild(header);

    const message = (text, retryAction) => {
      const row = doc.createElement("div");
      row.className = "git-commit-files-message";
      const label = doc.createElement("span");
      label.textContent = text;
      row.appendChild(label);
      if (retryAction) {
        const retry = doc.createElement("button");
        retry.type = "button";
        retry.className = "git-sidebar-state-button";
        retry.textContent = "Retry";
        retry.dataset.action = retryAction;
        retry.addEventListener("click", (event) => {
          event.stopPropagation();
          if (baseHash) void this.startCompare(baseHash, hash);
          else void this.loadCommitDetail(hash);
        });
        row.appendChild(retry);
      }
      section.appendChild(row);
    };

    if (!state || state.loading) {
      message("Loading files…");
      return section;
    }
    if (state.error) {
      message(state.error, baseHash ? "retry-compare" : "retry-commit-files");
      return section;
    }
    if (state.files.length === 0) message("No file changes.");
    for (const file of state.files)
      section.appendChild(this.createCommitFileRow(hash, file, baseHash));
    if (state.truncated) message("Showing the first 500 files.");
    return section;
  }

  createCommitFileRow(hash, file, baseHash) {
    const doc = document;
    const row = doc.createElement("div");
    row.className = "git-commit-file";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.dataset.path = file.path;
    const parts = GitSidebar.splitPath(file.path);
    row.title = file.originalPath ? `${file.path} ← ${file.originalPath}` : file.path;
    row.setAttribute(
      "aria-label",
      `${parts.name}${parts.dir ? ` in ${parts.dir}` : ""}, ${file.status} in commit`,
    );
    const badge = doc.createElement("span");
    badge.className = "git-status-badge";
    badge.dataset.kind = file.status;
    badge.textContent = GitSidebar.COMMIT_FILE_LETTERS[file.status] || "M";
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
    row.append(badge, info);
    const open = () => void this.openCommitFileDiff(hash, file, baseHash);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    return row;
  }

  createHistoryMoreRow() {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "git-history-more";
    row.textContent = "Load more commits";
    row.dataset.action = "history-more";
    row.dataset.gitFocusKey = "history-more";
    row.disabled = this.history.loading;
    row.addEventListener("click", () => void this.loadHistory());
    return row;
  }

  selectCommit(hash) {
    if (this.destroyed || typeof hash !== "string" || !hash) return false;
    if (this.compareBase && this.compareBase !== hash) {
      const base = this.compareBase;
      this.compareBase = null;
      void this.startCompare(base, hash);
      return true;
    }
    if (this.compareBase === hash) {
      this.compareBase = null;
      this.notice = "";
      this.renderList();
      this.updateCommitControls();
      return false;
    }
    this.selectedCommit = this.selectedCommit === hash ? null : hash;
    if (this.selectedCommit) {
      this.compare = null;
      void this.loadCommitDetail(hash);
    } else {
      this.commitDetail = null;
    }
    this.renderList();
    return this.selectedCommit === hash;
  }

  beginCompare(hash) {
    if (this.destroyed || typeof hash !== "string" || !hash) return false;
    this.compareBase = hash;
    this.notice = `Select a commit to compare with ${GitSidebar.shortHash(hash)}.`;
    this.renderList();
    this.updateCommitControls();
    return true;
  }

  cancelCompare() {
    this.compare = null;
    this.compareBase = null;
    this.notice = "";
    if (this.selectedCommit) void this.loadCommitDetail(this.selectedCommit);
    this.renderList();
    this.updateCommitControls();
  }

  async startCompare(base, target) {
    if (this.destroyed || !this.status) return false;
    const api = this.editor.api?.git;
    if (typeof api?.compareCommits !== "function") return false;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.selectedCommit = target;
    this.commitDetail = null;
    this.compare = { base, target, loading: true, error: "", files: [], truncated: false };
    this.notice = "";
    this.renderList();
    this.updateCommitControls();
    let result = null;
    try {
      result = await api.compareCommits(base, target);
    } catch {
      result = null;
    }
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot))
      return false;
    if (this.compare?.base !== base || this.compare?.target !== target) return false;
    if (result?.success !== true) {
      this.compare = {
        base,
        target,
        loading: false,
        error: result ? GitSidebar.describeError(result) : "The commits could not be compared.",
        files: [],
        truncated: false,
      };
    } else {
      this.compare = {
        base: result.base || base,
        target: result.target || target,
        loading: false,
        error: "",
        files: Array.isArray(result.files) ? result.files : [],
        truncated: result.truncated === true,
      };
    }
    this.renderList();
    return result?.success === true;
  }

  async loadCommitDetail(hash) {
    if (this.destroyed || !this.status) return false;
    const api = this.editor.api?.git;
    if (typeof api?.getCommitDetail !== "function") return false;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.commitDetail = { hash, loading: true, error: "", files: [], truncated: false };
    this.renderList();
    let result = null;
    try {
      result = await api.getCommitDetail(hash);
    } catch {
      result = null;
    }
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot))
      return false;
    if (this.selectedCommit !== hash) return false;
    if (result?.success !== true) {
      this.commitDetail = {
        hash,
        loading: false,
        error: result ? GitSidebar.describeError(result) : "The commit could not be read.",
        files: [],
        truncated: false,
      };
    } else {
      this.commitDetail = {
        hash,
        loading: false,
        error: "",
        files: Array.isArray(result.files) ? result.files : [],
        truncated: result.truncated === true,
      };
    }
    this.renderList();
    return result?.success === true;
  }

  async openCommitFileDiff(hash, file, baseHash = null) {
    const filePath = GitSidebar.resolveAbsolutePath(this.workspaceRoot, file?.path);
    if (!filePath) {
      this.setActionError("This change is outside the workspace.");
      return null;
    }
    const key = `commit:${baseHash || ""}:${hash}:${file.path}`;
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
        versions = await this.editor.api.git.getCommitFileVersions(hash, file.path, {
          baseHash: baseHash || null,
          originalPath: file.originalPath || null,
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
        relativePath: file.path,
        staged: false,
        statusKind: file.status,
        originalPath: file.originalPath || null,
        commitHash: hash,
        baseHash: baseHash || null,
        versions,
      })) || null;
    } finally {
      this.diffLoadingPaths.delete(key);
      if (this.notice === "Loading diff…") this.notice = "";
      this.updateCommitControls();
    }
  }

  async showHistory() {
    if (this.destroyed || !this.status) return false;
    this.collapsed.history = false;
    this.saveCollapsedState();
    this.renderList();
    if (!this.history.loaded) await this.loadHistory({ reset: true });
    return true;
  }

  async loadHistory({ reset = false } = {}) {
    if (this.destroyed || !this.status) return false;
    if (this.history.loading) {
      // A refresh that lands mid-load must still replace the stale page.
      if (reset) this.history.pendingReset = true;
      return false;
    }
    const api = this.editor.api?.git;
    if (typeof api?.getLog !== "function") return false;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    const skip = reset ? 0 : this.history.commits.length;
    this.history.loading = true;
    this.history.error = "";
    this.renderList();
    let result = null;
    try {
      result = await api.getLog({ limit: GitSidebar.HISTORY_PAGE_SIZE, skip });
    } catch {
      result = null;
    }
    this.history.loading = false;
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot))
      return false;
    if (result?.success !== true) {
      this.history.error = result
        ? GitSidebar.describeError(result)
        : "The commit history could not be read.";
      this.renderList();
      return this.flushPendingHistoryReset(false);
    }
    const commits = Array.isArray(result.commits) ? result.commits : [];
    const merged = reset ? commits : [...this.history.commits, ...commits];
    // A huge repository must never pull its whole log into the renderer.
    const truncated = merged.length > GitSidebar.MAX_HISTORY_COMMITS;
    this.history.commits = truncated
      ? merged.slice(0, GitSidebar.MAX_HISTORY_COMMITS)
      : merged;
    this.history.truncated = truncated;
    this.history.hasMore = result.hasMore === true && commits.length > 0 && !truncated;
    this.history.loaded = true;
    if (this.selectedCommit &&
        !this.history.commits.some((commit) => commit.hash === this.selectedCommit)) {
      this.selectedCommit = null;
      this.commitDetail = null;
      this.compare = null;
      this.compareBase = null;
    }
    this.renderList();
    return this.flushPendingHistoryReset(true);
  }

  flushPendingHistoryReset(result) {
    if (!this.history.pendingReset) return result;
    this.history.pendingReset = false;
    if (this.destroyed) return result;
    void this.loadHistory({ reset: true });
    return result;
  }

  handleListNearEnd() {
    if (this.destroyed || this.collapsed.history === true) return;
    if (!this.history.hasMore || this.history.loading) return;
    void this.loadHistory();
  }

  renderList() {
    if (!this.fileScroller) return;
    const focusKey = this.captureListFocusKey();
    const { staged, changes } = this.getSections();
    this.fileScroller.setItems(this.buildListItems(staged, changes), {
      resetScroll: this.listResetPending,
    });
    this.listResetPending = false;
    this.renderCollapsedBar(staged, changes);
    if (focusKey) this.restoreListFocus(focusKey);
  }

  renderCollapsedBar(staged, changes) {
    if (!this.collapsedBar) return;
    const sections = this.buildCollapsedSections(staged, changes);
    this.collapsedBar.replaceChildren(
      ...sections.map((section) => this.createSectionHeader(section)),
    );
    this.syncCollapsedBarVisibility();
  }

  syncCollapsedBarVisibility() {
    if (!this.collapsedBar) return;
    const listHidden = this.listElement?.hidden !== false;
    this.collapsedBar.hidden = listHidden || this.collapsedBar.children.length === 0;
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
    if (section !== "staged" && section !== "changes" && section !== "history") return false;
    this.collapsed[section] = !this.collapsed[section];
    this.saveCollapsedState();
    this.renderList();
    if (section === "history" && !this.collapsed.history && !this.history.loaded)
      void this.loadHistory({ reset: true });
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

  resolveDiscardTargets(targets) {
    const live = this.liveTargetMap({ excludeConflicted: true });
    const resolved = [];
    const seen = new Set();
    for (const target of Array.isArray(targets) ? targets : []) {
      const key = this.selectionKey(target?.entry, target?.staged === true);
      const match = live.get(key);
      if (!match || seen.has(key)) continue;
      seen.add(key);
      resolved.push(match);
    }
    return resolved;
  }

  resolveDiscardTargetsFor(entry, staged) {
    const key = this.selectionKey(entry, staged);
    if (this.selectedEntries.has(key) && this.selectedEntries.size > 1)
      return this.getSelectedTargets();
    return [{ entry, staged }];
  }

  requestDiscardAll(section) {
    if (section !== "changes" && section !== "staged") return Promise.resolve(false);
    const staged = section === "staged";
    const targets = this.getSections()[section]
      .filter((entry) => !entry.conflicted)
      .map((entry) => ({ entry, staged }));
    return this.requestDiscard(targets);
  }

  requestDiscard(targets) {
    if (this.destroyed || this.loading || this.isMutating())
      return Promise.resolve(false);
    const resolved = this.resolveDiscardTargets(targets);
    if (resolved.length === 0) {
      this.setActionError("There are no changes to discard.");
      return Promise.resolve(false);
    }
    return this.showDiscardConfirmation(resolved).then((answer) => {
      if (!answer?.confirmed || this.destroyed) return false;
      return this.performDiscard(resolved, answer.includeStaged === true);
    });
  }

  buildDiscardEntries(targets, includeStaged) {
    const stagedByPath = new Map();
    for (const entry of this.getSections().staged)
      if (!entry.conflicted) stagedByPath.set(entry.path, entry);
    const entries = [];
    const seen = new Set();
    const push = (entry) => {
      const key = `${entry.staged ? "s" : entry.untracked ? "u" : "w"}:${entry.path}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push(entry);
    };
    for (const { entry, staged } of targets) {
      if (!entry || entry.conflicted) continue;
      if (staged) {
        push({ path: entry.path, originalPath: entry.originalPath || null, staged: true });
      } else if (entry.kind === "untracked" || entry.worktree === "?") {
        push({ path: entry.path, untracked: true });
      } else {
        push({ path: entry.path, originalPath: entry.originalPath || null });
        if (includeStaged) {
          const counterpart = stagedByPath.get(entry.path);
          if (counterpart)
            push({ path: counterpart.path, originalPath: counterpart.originalPath || null, staged: true });
        }
      }
    }
    return entries;
  }

  canIncludeStaged(targets) {
    const stagedPaths = new Set(
      this.getSections().staged
        .filter((entry) => !entry.conflicted)
        .map((entry) => entry.path),
    );
    return targets.some(({ entry, staged }) =>
      !staged && !entry.conflicted &&
      entry.kind !== "untracked" && entry.worktree !== "?" &&
      stagedPaths.has(entry.path));
  }

  async performDiscard(targets, includeStaged) {
    if (this.destroyed || this.discarding || this.committing ||
        this.stagingAll || this.unstagingAll)
      return false;
    const entries = this.buildDiscardEntries(targets, includeStaged);
    if (entries.length === 0) return false;
    this.cancelScheduledRefresh();
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    const paths = [...new Set(entries.map((entry) => entry.path))];
    this.discarding = true;
    for (const path of paths) this.operationPaths.add(path);
    this.actionError = "";
    this.notice = "";
    this.renderList();
    this.updateView();
    let result = null;
    try {
      result = await this.editor.api.git.discardChanges(entries);
    } catch {
      result = null;
    }
    this.discarding = false;
    for (const path of paths) this.operationPaths.delete(path);
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.updateView();
      return false;
    }
    if (result?.success === true) {
      const count = Array.isArray(result.discarded) ? result.discarded.length : entries.length;
      this.notice = count === 1 ? "Discarded 1 change" : `Discarded ${count} changes`;
      this.clearEntrySelection();
    } else {
      this.actionError = result?.error || "The Git operation failed.";
      this.notifyGit({
        type: "error",
        title: "Could not discard changes",
        message: this.actionError,
        actions: [{
          label: "Retry",
          action: () => {
            if (!this.destroyed) void this.performDiscard(targets, includeStaged);
          },
        }],
      });
    }
    await this.refresh({ reason: "stage" });
    this.updateView();
    return result?.success === true;
  }

  requestAbortOperation() {
    const operation = this.status?.merging === true ? "merge"
      : this.status?.rebasing === true ? "rebase"
        : null;
    if (!operation || this.destroyed || this.loading || this.isMutating())
      return Promise.resolve(false);
    return this.showAbortConfirmation(operation).then((answer) => {
      if (!answer?.confirmed || this.destroyed) return false;
      return this.performAbort(operation);
    });
  }

  async performAbort(operation) {
    if (this.destroyed || this.isMutating()) return false;
    this.cancelScheduledRefresh();
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.aborting = true;
    this.actionError = "";
    this.notice = "";
    this.renderList();
    this.updateView();
    let result = null;
    try {
      result = await this.editor.api.git.abortOperation(operation);
    } catch {
      result = null;
    }
    this.aborting = false;
    if (this.destroyed) return false;
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.updateView();
      return false;
    }
    if (result?.success === true) {
      this.notice = operation === "merge" ? "Aborted the merge" : "Aborted the rebase";
    } else {
      this.actionError = result?.error || "The Git operation failed.";
      this.notifyGit({
        type: "error",
        title: operation === "merge" ? "Could not abort merge" : "Could not abort rebase",
        message: this.actionError,
        actions: [{
          label: "Retry",
          action: () => {
            if (!this.destroyed) void this.performAbort(operation);
          },
        }],
      });
    }
    await this.refresh({ reason: "branch" });
    this.updateView();
    return result?.success === true;
  }

  updateOperationBanner() {
    if (!this.operationBanner) return;
    const merging = this.status?.merging === true;
    const rebasing = this.status?.rebasing === true;
    this.operationBanner.hidden = !merging && !rebasing;
    if (!merging && !rebasing) return;
    this.operationBannerText.textContent = merging
      ? "A merge is in progress."
      : "A rebase is in progress.";
    this.operationBannerButton.textContent = merging ? "Abort Merge" : "Abort Rebase";
    this.operationBannerButton.disabled = this.loading || this.isMutating();
    if (this.aborting) this.operationBannerButton.setAttribute("aria-busy", "true");
    else this.operationBannerButton.removeAttribute("aria-busy");
  }

  updateSyncBar() {
    if (!this.syncBar) return;
    const branch = this.status?.branch;
    this.syncBar.hidden = !this.status;
    if (!this.status) return;
    const busy = this.loading || this.isMutating();
    const syncing = Boolean(this.syncing);
    const behind = Number(branch?.behind) || 0;
    const ahead = Number(branch?.ahead) || 0;
    const remoteLabel = this.defaultRemote ? ` (${this.defaultRemote})` : "";

    this.syncFetchButton.disabled = busy;
    this.syncFetchButton.title = `Fetch${remoteLabel}`;
    this.syncFetchButton.setAttribute("aria-label", `Fetch${remoteLabel}`);

    this.syncPullButton.disabled = busy;
    this.syncPullButton.title = behind > 0 ? `Pull ${behind} commit${behind === 1 ? "" : "s"}` : "Pull";
    this.syncPullButton.setAttribute("aria-label", this.syncPullButton.title);
    this.syncPullCount.hidden = behind === 0;
    this.syncPullCount.textContent = String(behind);

    this.syncPushButton.disabled = busy;
    this.syncPushButton.title = ahead > 0 ? `Push ${ahead} commit${ahead === 1 ? "" : "s"}` : "Push";
    this.syncPushButton.setAttribute("aria-label", this.syncPushButton.title);
    this.syncPushCount.hidden = ahead === 0;
    this.syncPushCount.textContent = String(ahead);

    this.syncRemotesButton.disabled = this.loading || this.remotesBusy || syncing;

    if (syncing) {
      const progress = this.syncProgress;
      const label = this.syncing === "fetch" ? "Fetching" : this.syncing === "pull" ? "Pulling" : "Pushing";
      this.syncStatus.hidden = false;
      this.syncStatus.textContent = progress
        ? `${label}… ${progress.phase} ${progress.percent}%`
        : `${label}…`;
      this.syncCancelButton.hidden = false;
      this.syncCancelButton.disabled = false;
    } else {
      this.syncStatus.hidden = true;
      this.syncStatus.textContent = "";
      this.syncCancelButton.hidden = true;
    }
  }

  handleNetworkProgress(progress) {
    if (!progress || this.destroyed) return;
    if (this.cloneBusy && progress.operation === "clone") {
      this.cloneProgress = {
        phase: String(progress.phase || ""),
        percent: Number(progress.percent) || 0,
      };
      this.renderCloneProgress();
      return;
    }
    if (!this.syncing || progress.operation !== this.syncing) return;
    this.syncProgress = {
      phase: String(progress.phase || ""),
      percent: Number(progress.percent) || 0,
    };
    this.updateSyncBar();
  }

  fetchChanges() {
    return this.performSync("fetch", {});
  }

  pullChanges() {
    return this.performSync("pull", {});
  }

  pushChanges() {
    return this.performSync("push", {});
  }

  async cancelSync() {
    if (!this.syncing) return false;
    try {
      await this.editor.api?.git?.cancelNetworkOperation?.();
    } catch {}
    return true;
  }

  async performSync(operation, options = {}) {
    if (this.destroyed || this.loading || this.isMutating()) return false;
    const api = this.editor.api?.git;
    if (!api || typeof api[operation] !== "function") return false;
    this.cancelScheduledRefresh();
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.syncing = operation;
    this.syncProgress = null;
    this.clearTransientMessages();
    this.notice = "";
    this.updateView();
    let result = null;
    try {
      result = await api[operation](options);
    } catch {
      result = null;
    }
    if (workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.syncing = null;
      this.syncProgress = null;
      this.updateView();
      return false;
    }
    this.syncing = null;
    this.syncProgress = null;
    if (result?.success === true) {
      this.notice = GitSidebar.syncSuccessMessage(operation, result);
      this.notifyGit({
        type: "success",
        title: GitSidebar.syncSuccessTitle(operation),
        message: this.notice,
      });
      await this.refresh({ reason: "branch" });
      this.updateView();
      return true;
    }
    this.updateView();
    this.handleSyncFailure(operation, result, options);
    return false;
  }

  handleSyncFailure(operation, result, options) {
    const code = result?.code;
    const message = result
      ? GitSidebar.describeError(result)
      : "The Git operation failed.";
    if (code === "OPERATION_CANCELLED") {
      this.notice = "The operation was cancelled.";
      this.updateCommitControls();
      return;
    }
    if (code === "PULL_CONFLICTS") {
      this.notifyGit({
        type: "warning",
        title: "Pull stopped with conflicts",
        message,
      });
      void this.refresh({ reason: "branch" });
      return;
    }
    if (code === "NO_UPSTREAM" && operation === "push") {
      this.notifyGit({
        type: "info",
        title: "No upstream branch",
        message: "Publish this branch to a remote so it can be tracked.",
        actions: [{
          label: "Publish Branch",
          action: () => { if (!this.destroyed) void this.publishBranch(); },
        }],
      });
      return;
    }
    if (code === "PUSH_REJECTED") {
      this.notifyGit({
        type: "error",
        title: "Push rejected",
        message,
        persistent: true,
        actions: [
          { label: "Pull", action: () => { if (!this.destroyed) void this.pullChanges(); } },
          { label: "Force With Lease…", action: () => { if (!this.destroyed) void this.requestForcePush(options); } },
        ],
      });
      return;
    }
    if (code === "PULL_STRATEGY_REQUIRED") {
      this.promptPullStrategy();
      return;
    }
    if (code === "NO_REMOTE") {
      this.notifyGit({
        type: "info",
        title: "No remote configured",
        message,
        actions: [{
          label: "Add Remote",
          action: () => { if (!this.destroyed) void this.openRemotesDialog(); },
        }],
      });
      return;
    }
    if (code === "AUTH_REQUIRED") {
      this.notifyGit({
        type: "error",
        title: "Authentication required",
        message,
        persistent: true,
      });
      return;
    }
    this.setActionError(message);
    this.notifyGit({
      type: "error",
      title: GitSidebar.syncFailureTitle(operation),
      message,
      actions: [{
        label: "Retry",
        action: () => { if (!this.destroyed) void this.performSync(operation, options); },
      }],
    });
  }

  async publishBranch() {
    const branch = this.status?.branch?.name;
    if (!branch) {
      this.notifyGit({
        type: "error",
        title: "Cannot publish branch",
        message: "There is no current branch to publish.",
      });
      return false;
    }
    const remote = await this.resolveSyncRemote();
    if (!remote) return false;
    return this.performSync("push", { remote, branch, setUpstream: true });
  }

  async requestForcePush(options = {}) {
    const remote = options.remote || await this.resolveSyncRemote();
    const branch = options.branch || this.status?.branch?.name;
    if (!remote || !branch) {
      this.notifyGit({
        type: "error",
        title: "Force push unavailable",
        message: "A remote and a branch are required to force push.",
      });
      return false;
    }
    const answer = await this.showForcePushConfirmation(remote, branch);
    if (!answer?.confirmed) return false;
    return this.performSync("push", { remote, branch, forceWithLease: true });
  }

  showForcePushConfirmation(remote, branch) {
    const dialog = this.ensureOperationDialog();
    if (!dialog || dialog.open || this.operationDialogSession || this.destroyed)
      return Promise.resolve({ confirmed: false });
    this.operationDialog.dataset.mode = "force-push";
    this.operationDialogBadgeIcon.className = "fi fi-rr-triangle-warning";
    this.operationDialogTitle.textContent = "Force Push With Lease";
    this.operationDialogMessage.textContent =
      `This overwrites "${branch}" on "${remote}" with your local branch. ` +
      "Remote commits you do not have will be lost. The lease aborts the push if the remote moved since your last fetch.";
    this.operationDialogFiles.hidden = true;
    this.operationDialogFiles.replaceChildren();
    this.operationDialogCheckboxLabel.hidden = true;
    this.operationDialogCheckbox.checked = false;
    this.operationDialogConfirmButton.textContent = "Force Push With Lease";
    this.operationDialogCancelButton.disabled = false;
    this.operationDialogConfirmButton.disabled = false;
    return this.openOperationDialog();
  }

  promptPullStrategy() {
    const quickPanel = this.editor.quickPanel;
    if (!quickPanel || typeof quickPanel.open !== "function") {
      this.notifyGit({
        type: "info",
        title: "Choose a pull strategy",
        message: "Configure pull.rebase in Git, or pull again with an explicit merge or rebase choice.",
      });
      return false;
    }
    return quickPanel.open({
      id: "git-pull-strategy",
      mode: "pick",
      title: "Pull Strategy",
      placeholder: "Reconcile divergent branches",
      items: [
        { id: "merge", label: "Merge — create a merge commit", icon: "fi fi-rr-code-branch" },
        { id: "rebase", label: "Rebase — replay local commits", icon: "fi fi-rr-arrow-up" },
      ],
      onAccept: (item) => {
        void this.performSync("pull", { rebase: item.id === "rebase" });
      },
    });
  }

  async loadRemotes() {
    let result = null;
    try {
      result = await this.editor.api?.git?.getRemotes?.();
    } catch {
      result = null;
    }
    if (result?.success === true) {
      this.remotes = Array.isArray(result.remotes) ? result.remotes : [];
      this.defaultRemote = result.defaultRemote || null;
    }
    return result?.success === true;
  }

  async resolveSyncRemote() {
    await this.loadRemotes();
    if (this.defaultRemote) return this.defaultRemote;
    if (this.remotes.length === 1) return this.remotes[0].name;
    if (this.remotes.length === 0) {
      void this.openRemotesDialog();
      return null;
    }
    const quickPanel = this.editor.quickPanel;
    if (!quickPanel || typeof quickPanel.open !== "function") return null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      quickPanel.open({
        id: "git-remote-picker",
        mode: "pick",
        title: "Choose Remote",
        placeholder: "Choose a remote",
        items: this.remotes.map((remote) => ({
          id: remote.name,
          label: remote.name,
          icon: "fi fi-rr-database",
        })),
        onAccept: (item) => finish(item.id),
        onCancel: () => finish(null),
      });
    });
  }

  async openRemotesDialog() {
    const dialog = this.ensureRemotesDialog();
    if (!dialog || dialog.open || this.remotesDialogSession || this.destroyed)
      return false;
    this.remotesEditing = null;
    this.remotesPendingRemove = null;
    this.setRemotesError("");
    await this.loadRemotes();
    if (this.destroyed) return false;
    this.renderRemotesList();
    return new Promise((resolve) => {
      const session = {
        resolve,
        completed: false,
        previousFocus: document.activeElement,
      };
      this.remotesDialogSession = session;
      try {
        dialog.showModal();
        this.remotesAddName?.focus({ preventScroll: true });
      } catch {
        this.completeRemotesDialog();
      }
    });
  }

  ensureRemotesDialog() {
    if (this.remotesDialog) return this.remotesDialog;
    if (!document.body || typeof document.createElement !== "function") return null;

    const dialog = document.createElement("dialog");
    dialog.className = "git-remotes-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "git-remotes-title");

    const content = document.createElement("div");
    content.className = "git-remotes-content";

    const heading = document.createElement("div");
    heading.className = "git-remotes-heading";
    const badge = document.createElement("span");
    badge.className = "git-operation-badge";
    badge.setAttribute("aria-hidden", "true");
    const badgeIcon = document.createElement("i");
    badgeIcon.className = "fi fi-rr-database";
    badge.appendChild(badgeIcon);
    const titleGroup = document.createElement("div");
    titleGroup.className = "git-operation-title-group";
    const title = document.createElement("h2");
    title.id = "git-remotes-title";
    title.textContent = "Remotes";
    const subtitle = document.createElement("p");
    subtitle.className = "git-operation-subtitle";
    subtitle.textContent = "Manage the remote repositories for this project.";
    titleGroup.append(title, subtitle);
    heading.append(badge, titleGroup);

    const list = document.createElement("div");
    list.className = "git-remotes-list";

    const error = document.createElement("p");
    error.className = "git-remotes-error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    const addForm = document.createElement("div");
    addForm.className = "git-remotes-add";
    const addTitle = document.createElement("h3");
    addTitle.className = "git-remotes-add-title";
    addTitle.textContent = "Add Remote";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "git-remotes-input";
    nameInput.placeholder = "Name (e.g. origin)";
    nameInput.setAttribute("aria-label", "Remote name");
    nameInput.autocomplete = "off";
    nameInput.spellcheck = false;
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "git-remotes-input";
    urlInput.placeholder = "https://… or git@host:…";
    urlInput.setAttribute("aria-label", "Remote URL");
    urlInput.autocomplete = "off";
    urlInput.spellcheck = false;
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "git-remotes-add-button";
    addButton.textContent = "Add Remote";
    addButton.addEventListener("click", () => void this.submitAddRemote());
    const submitOnEnter = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.submitAddRemote();
      }
    };
    nameInput.addEventListener("keydown", submitOnEnter);
    urlInput.addEventListener("keydown", submitOnEnter);
    addForm.append(addTitle, nameInput, urlInput, addButton);

    const actions = document.createElement("div");
    actions.className = "git-operation-actions";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "git-operation-cancel";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => this.finishRemotesDialog());
    actions.append(closeButton);

    content.append(heading, list, error, addForm, actions);
    dialog.appendChild(content);

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.finishRemotesDialog();
    });
    dialog.addEventListener("close", () => this.completeRemotesDialog());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) this.finishRemotesDialog();
    });
    document.body.appendChild(dialog);

    this.remotesDialog = dialog;
    this.remotesList = list;
    this.remotesError = error;
    this.remotesAddName = nameInput;
    this.remotesAddUrl = urlInput;
    this.remotesAddButton = addButton;
    this.remotesCloseButton = closeButton;
    return dialog;
  }

  renderRemotesList() {
    const list = this.remotesList;
    if (!list) return;
    list.replaceChildren();
    if (!this.remotes.length) {
      const empty = document.createElement("p");
      empty.className = "git-remotes-empty";
      empty.textContent = "No remotes configured.";
      list.appendChild(empty);
      return;
    }
    for (const remote of this.remotes) {
      list.appendChild(this.buildRemoteRow(remote));
    }
  }

  buildRemoteRow(remote) {
    const row = document.createElement("div");
    row.className = "git-remotes-row";
    row.dataset.remote = remote.name;

    if (this.remotesPendingRemove === remote.name) {
      const prompt = document.createElement("span");
      prompt.className = "git-remotes-remove-prompt";
      prompt.textContent = `Remove "${remote.name}"?`;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "git-remotes-row-button";
      cancel.textContent = "Cancel";
      cancel.disabled = this.remotesBusy;
      cancel.addEventListener("click", () => {
        this.remotesPendingRemove = null;
        this.renderRemotesList();
      });
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "git-remotes-row-button danger";
      confirm.textContent = "Remove";
      confirm.disabled = this.remotesBusy;
      confirm.addEventListener("click", () => void this.confirmRemoveRemote(remote.name));
      row.append(prompt, cancel, confirm);
      return row;
    }

    if (this.remotesEditing === remote.name) {
      const form = document.createElement("div");
      form.className = "git-remotes-edit";
      const nameLabel = document.createElement("span");
      nameLabel.className = "git-remotes-name";
      nameLabel.textContent = remote.name;
      const fetchInput = document.createElement("input");
      fetchInput.type = "text";
      fetchInput.className = "git-remotes-input";
      fetchInput.value = remote.fetchUrl || "";
      fetchInput.placeholder = "Fetch URL";
      fetchInput.setAttribute("aria-label", `Fetch URL for ${remote.name}`);
      fetchInput.autocomplete = "off";
      fetchInput.spellcheck = false;
      const pushInput = document.createElement("input");
      pushInput.type = "text";
      pushInput.className = "git-remotes-input";
      pushInput.value = remote.pushUrl || "";
      pushInput.placeholder = "Push URL (optional)";
      pushInput.setAttribute("aria-label", `Push URL for ${remote.name}`);
      pushInput.autocomplete = "off";
      pushInput.spellcheck = false;
      const buttons = document.createElement("div");
      buttons.className = "git-remotes-edit-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "git-remotes-row-button";
      cancel.textContent = "Cancel";
      cancel.disabled = this.remotesBusy;
      cancel.addEventListener("click", () => {
        this.remotesEditing = null;
        this.renderRemotesList();
      });
      const save = document.createElement("button");
      save.type = "button";
      save.className = "git-remotes-row-button primary";
      save.textContent = "Save";
      save.disabled = this.remotesBusy;
      save.addEventListener("click", () =>
        void this.submitEditRemote(remote.name, fetchInput.value, pushInput.value));
      const saveOnEnter = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.submitEditRemote(remote.name, fetchInput.value, pushInput.value);
        }
      };
      fetchInput.addEventListener("keydown", saveOnEnter);
      pushInput.addEventListener("keydown", saveOnEnter);
      buttons.append(cancel, save);
      form.append(nameLabel, fetchInput, pushInput, buttons);
      row.appendChild(form);
      return row;
    }

    const info = document.createElement("div");
    info.className = "git-remotes-info";
    const name = document.createElement("span");
    name.className = "git-remotes-name";
    name.textContent = remote.name;
    if (this.defaultRemote === remote.name) {
      const tag = document.createElement("span");
      tag.className = "git-remotes-default";
      tag.textContent = "default";
      name.appendChild(tag);
    }
    const fetchUrl = document.createElement("span");
    fetchUrl.className = "git-remotes-url";
    fetchUrl.textContent = remote.fetchUrl || "";
    fetchUrl.title = remote.fetchUrl || "";
    info.append(name, fetchUrl);
    if (remote.pushUrl && remote.pushUrl !== remote.fetchUrl) {
      const pushUrl = document.createElement("span");
      pushUrl.className = "git-remotes-url git-remotes-push-url";
      pushUrl.textContent = `push: ${remote.pushUrl}`;
      pushUrl.title = remote.pushUrl;
      info.appendChild(pushUrl);
    }

    const buttons = document.createElement("div");
    buttons.className = "git-remotes-row-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "git-remotes-row-button";
    edit.textContent = "Edit";
    edit.disabled = this.remotesBusy;
    edit.addEventListener("click", () => {
      this.remotesEditing = remote.name;
      this.remotesPendingRemove = null;
      this.setRemotesError("");
      this.renderRemotesList();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "git-remotes-row-button danger";
    remove.textContent = "Remove";
    remove.disabled = this.remotesBusy;
    remove.addEventListener("click", () => {
      this.remotesPendingRemove = remote.name;
      this.remotesEditing = null;
      this.setRemotesError("");
      this.renderRemotesList();
    });
    buttons.append(edit, remove);
    row.append(info, buttons);
    return row;
  }

  setRemotesError(message) {
    if (!this.remotesError) return;
    this.remotesError.textContent = message || "";
    this.remotesError.hidden = !message;
  }

  setRemotesBusy(busy) {
    this.remotesBusy = busy;
    if (this.remotesAddButton) this.remotesAddButton.disabled = busy;
    if (this.remotesAddName) this.remotesAddName.disabled = busy;
    if (this.remotesAddUrl) this.remotesAddUrl.disabled = busy;
    this.renderRemotesList();
    this.updateSyncBar();
  }

  async submitAddRemote() {
    if (this.remotesBusy || this.destroyed) return false;
    const name = (this.remotesAddName?.value || "").trim();
    const url = (this.remotesAddUrl?.value || "").trim();
    if (!name || !url) {
      this.setRemotesError("A remote name and URL are required.");
      return false;
    }
    const api = this.editor.api?.git;
    if (!api?.addRemote) return false;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.setRemotesError("");
    this.setRemotesBusy(true);
    let result = null;
    try {
      result = await api.addRemote(name, url);
    } catch {
      result = null;
    }
    if (this.destroyed ||
        workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.remotesBusy = false;
      return false;
    }
    if (result?.success === true) {
      if (this.remotesAddName) this.remotesAddName.value = "";
      if (this.remotesAddUrl) this.remotesAddUrl.value = "";
      await this.loadRemotes();
      this.setRemotesBusy(false);
      this.notifyGit({
        type: "success",
        title: "Remote added",
        message: `Added remote "${name}".`,
      });
      return true;
    }
    this.setRemotesBusy(false);
    this.setRemotesError(result ? GitSidebar.describeError(result) : "Could not add the remote.");
    return false;
  }

  async submitEditRemote(name, fetchUrl, pushUrl) {
    if (this.remotesBusy || this.destroyed) return false;
    const fetch = String(fetchUrl || "").trim();
    const push = String(pushUrl || "").trim();
    if (!fetch) {
      this.setRemotesError("A fetch URL is required.");
      return false;
    }
    const api = this.editor.api?.git;
    if (!api?.setRemoteUrl) return false;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.setRemotesError("");
    this.setRemotesBusy(true);
    let result = null;
    try {
      result = await api.setRemoteUrl(name, fetch);
      if (result?.success === true && push)
        result = await api.setRemoteUrl(name, push, { push: true });
    } catch {
      result = null;
    }
    if (this.destroyed ||
        workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.remotesBusy = false;
      return false;
    }
    if (result?.success === true) {
      this.remotesEditing = null;
      await this.loadRemotes();
      this.setRemotesBusy(false);
      this.notifyGit({
        type: "success",
        title: "Remote updated",
        message: `Updated remote "${name}".`,
      });
      return true;
    }
    this.setRemotesBusy(false);
    this.setRemotesError(result ? GitSidebar.describeError(result) : "Could not update the remote.");
    return false;
  }

  async confirmRemoveRemote(name) {
    if (this.remotesBusy || this.destroyed) return false;
    const api = this.editor.api?.git;
    if (!api?.removeRemote) return false;
    const workspaceGeneration = this.workspaceGeneration;
    const workspaceRoot = this.workspaceRoot;
    this.setRemotesError("");
    this.setRemotesBusy(true);
    let result = null;
    try {
      result = await api.removeRemote(name);
    } catch {
      result = null;
    }
    if (this.destroyed ||
        workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(workspaceRoot, this.workspaceRoot)) {
      this.remotesBusy = false;
      return false;
    }
    this.remotesPendingRemove = null;
    if (result?.success === true) {
      await this.loadRemotes();
      this.setRemotesBusy(false);
      this.notifyGit({
        type: "success",
        title: "Remote removed",
        message: `Removed remote "${name}".`,
      });
      return true;
    }
    this.setRemotesBusy(false);
    this.setRemotesError(result ? GitSidebar.describeError(result) : "Could not remove the remote.");
    return false;
  }

  finishRemotesDialog() {
    const session = this.remotesDialogSession;
    if (!session) return false;
    if (this.remotesDialog?.open) this.remotesDialog.close();
    else this.completeRemotesDialog();
    return true;
  }

  completeRemotesDialog() {
    const session = this.remotesDialogSession;
    if (!session || session.completed) return false;
    this.remotesDialogSession = null;
    session.completed = true;
    this.remotesEditing = null;
    this.remotesPendingRemove = null;
    const previousFocus = session.previousFocus;
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {}
    }
    session.resolve(true);
    return true;
  }

  async openCloneDialog() {
    const dialog = this.ensureCloneDialog();
    if (!dialog || dialog.open || this.cloneDialogSession || this.destroyed)
      return false;
    this.cloneBusy = false;
    this.cloneProgress = null;
    this.cloneDestination = "";
    this.setCloneError("");
    if (this.cloneUrlInput) this.cloneUrlInput.value = "";
    if (this.cloneFolderInput) this.cloneFolderInput.value = "";
    if (this.cloneDestinationInput) this.cloneDestinationInput.value = "";
    this.updateCloneControls();
    return new Promise((resolve) => {
      const session = {
        resolve,
        completed: false,
        previousFocus: document.activeElement,
      };
      this.cloneDialogSession = session;
      try {
        dialog.showModal();
        this.cloneUrlInput?.focus({ preventScroll: true });
      } catch {
        this.completeCloneDialog();
      }
    });
  }

  ensureCloneDialog() {
    if (this.cloneDialog) return this.cloneDialog;
    if (!document.body || typeof document.createElement !== "function") return null;

    const dialog = document.createElement("dialog");
    dialog.className = "git-clone-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "git-clone-title");

    const content = document.createElement("div");
    content.className = "git-clone-content";

    const heading = document.createElement("div");
    heading.className = "git-remotes-heading";
    const badge = document.createElement("span");
    badge.className = "git-operation-badge";
    badge.setAttribute("aria-hidden", "true");
    const badgeIcon = document.createElement("i");
    badgeIcon.className = "fi fi-rr-code-branch";
    badge.appendChild(badgeIcon);
    const titleGroup = document.createElement("div");
    titleGroup.className = "git-operation-title-group";
    const title = document.createElement("h2");
    title.id = "git-clone-title";
    title.textContent = "Clone Repository";
    const subtitle = document.createElement("p");
    subtitle.className = "git-operation-subtitle";
    subtitle.textContent = "Clone a remote repository into a folder you choose.";
    titleGroup.append(title, subtitle);
    heading.append(badge, titleGroup);

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "git-remotes-input";
    urlInput.placeholder = "https://… or git@host:…";
    urlInput.setAttribute("aria-label", "Repository URL");
    urlInput.autocomplete = "off";
    urlInput.spellcheck = false;

    const destinationRow = document.createElement("div");
    destinationRow.className = "git-clone-destination";
    const destinationInput = document.createElement("input");
    destinationInput.type = "text";
    destinationInput.className = "git-remotes-input";
    destinationInput.placeholder = "Destination folder";
    destinationInput.setAttribute("aria-label", "Destination folder");
    destinationInput.readOnly = true;
    const browseButton = document.createElement("button");
    browseButton.type = "button";
    browseButton.className = "git-remotes-add-button git-clone-browse";
    browseButton.textContent = "Browse…";
    browseButton.addEventListener("click", () => void this.browseCloneDestination());
    destinationRow.append(destinationInput, browseButton);

    const folderInput = document.createElement("input");
    folderInput.type = "text";
    folderInput.className = "git-remotes-input";
    folderInput.placeholder = "Folder name (optional, defaults to the repository name)";
    folderInput.setAttribute("aria-label", "Folder name");
    folderInput.autocomplete = "off";
    folderInput.spellcheck = false;

    const progress = document.createElement("div");
    progress.className = "git-clone-progress";
    progress.hidden = true;
    const progressTrack = document.createElement("div");
    progressTrack.className = "git-clone-progress-track";
    const progressBar = document.createElement("div");
    progressBar.className = "git-clone-progress-bar";
    progressTrack.appendChild(progressBar);
    const progressText = document.createElement("span");
    progressText.className = "git-clone-progress-text";
    progress.append(progressTrack, progressText);

    const error = document.createElement("p");
    error.className = "git-remotes-error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "git-operation-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "git-operation-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => this.requestCloneCancel());
    const cloneButton = document.createElement("button");
    cloneButton.type = "button";
    cloneButton.className = "git-operation-confirm";
    cloneButton.textContent = "Clone";
    cloneButton.addEventListener("click", () => void this.submitClone());
    actions.append(cancelButton, cloneButton);

    const submitOnEnter = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.submitClone();
      }
    };
    urlInput.addEventListener("keydown", submitOnEnter);
    folderInput.addEventListener("keydown", submitOnEnter);

    content.append(heading, urlInput, destinationRow, folderInput, progress, error, actions);
    dialog.appendChild(content);

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.requestCloneCancel();
    });
    dialog.addEventListener("close", () => this.completeCloneDialog());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) this.requestCloneCancel();
    });
    document.body.appendChild(dialog);

    this.cloneDialog = dialog;
    this.cloneUrlInput = urlInput;
    this.cloneFolderInput = folderInput;
    this.cloneDestinationInput = destinationInput;
    this.cloneBrowseButton = browseButton;
    this.cloneCloneButton = cloneButton;
    this.cloneCancelButton = cancelButton;
    this.cloneError = error;
    this.cloneProgressElement = progress;
    this.cloneProgressBar = progressBar;
    this.cloneProgressText = progressText;
    return dialog;
  }

  async browseCloneDestination() {
    if (this.cloneBusy || this.destroyed) return false;
    const selectFolder = this.editor.api?.selectFolder;
    if (typeof selectFolder !== "function") return false;
    let folderPath;
    try {
      folderPath = await selectFolder();
    } catch {
      folderPath = undefined;
    }
    if (!folderPath || this.destroyed) return false;
    this.cloneDestination = folderPath;
    if (this.cloneDestinationInput) this.cloneDestinationInput.value = folderPath;
    this.setCloneError("");
    this.updateCloneControls();
    return true;
  }

  setCloneError(message) {
    if (!this.cloneError) return;
    this.cloneError.textContent = message || "";
    this.cloneError.hidden = !message;
  }

  updateCloneControls() {
    const busy = this.cloneBusy;
    if (this.cloneUrlInput) this.cloneUrlInput.disabled = busy;
    if (this.cloneFolderInput) this.cloneFolderInput.disabled = busy;
    if (this.cloneBrowseButton) this.cloneBrowseButton.disabled = busy;
    if (this.cloneCloneButton) {
      this.cloneCloneButton.disabled = busy;
      this.cloneCloneButton.textContent = busy ? "Cloning…" : "Clone";
      if (busy) this.cloneCloneButton.setAttribute("aria-busy", "true");
      else this.cloneCloneButton.removeAttribute("aria-busy");
    }
    if (this.cloneCancelButton)
      this.cloneCancelButton.textContent = busy ? "Cancel Clone" : "Cancel";
    if (this.cloneProgressElement) this.cloneProgressElement.hidden = !busy;
    if (busy) this.renderCloneProgress();
    this.updateState();
  }

  renderCloneProgress() {
    const progress = this.cloneProgress;
    if (this.cloneProgressBar)
      this.cloneProgressBar.style.width = `${progress ? progress.percent : 0}%`;
    if (this.cloneProgressText) {
      this.cloneProgressText.textContent = progress
        ? `${progress.phase} ${progress.percent}%`
        : "Cloning…";
    }
  }

  async submitClone() {
    if (this.cloneBusy || this.destroyed) return false;
    const api = this.editor.api?.git;
    if (!api || typeof api.clone !== "function") return false;
    const url = String(this.cloneUrlInput?.value || "").trim();
    if (!url) {
      this.setCloneError("Enter the repository URL to clone.");
      this.cloneUrlInput?.focus({ preventScroll: true });
      return false;
    }
    if (!this.cloneDestination) {
      this.setCloneError("Choose a destination folder.");
      return false;
    }
    const folderName = String(this.cloneFolderInput?.value || "").trim();
    const destination = this.cloneDestination;
    this.cloneBusy = true;
    this.cloneProgress = null;
    this.setCloneError("");
    this.updateCloneControls();
    let result = null;
    try {
      result = await api.clone({
        url,
        destination,
        ...(folderName ? { folderName } : {}),
      });
    } catch {
      result = null;
    }
    if (this.destroyed) return false;
    if (!result || result.success !== true) {
      this.cloneBusy = false;
      this.cloneProgress = null;
      this.updateCloneControls();
      if (result?.code === "OPERATION_CANCELLED") {
        this.setCloneError("The clone was cancelled.");
        return false;
      }
      this.setCloneError(result?.error || "The repository could not be cloned.");
      return false;
    }
    const clonedPath = result.path;
    this.cloneBusy = false;
    this.cloneProgress = null;
    this.finishCloneDialog();
    this.notifyGit({
      tone: "success",
      title: "Repository cloned",
      message: `Cloned into ${result.folderName}. Opening the folder…`,
    });
    await this.editor.fileExplorer?.requestWorkspaceSwitch?.(clonedPath);
    return true;
  }

  requestCloneCancel() {
    if (this.cloneBusy) {
      void this.cancelClone();
      return;
    }
    this.finishCloneDialog();
  }

  async cancelClone() {
    if (!this.cloneBusy) return false;
    try {
      await this.editor.api?.git?.cancelNetworkOperation?.();
    } catch {}
    return true;
  }

  finishCloneDialog() {
    const session = this.cloneDialogSession;
    if (!session) return false;
    if (this.cloneDialog?.open) this.cloneDialog.close();
    else this.completeCloneDialog();
    return true;
  }

  completeCloneDialog() {
    const session = this.cloneDialogSession;
    if (!session || session.completed) return false;
    this.cloneDialogSession = null;
    session.completed = true;
    this.cloneBusy = false;
    this.cloneProgress = null;
    const previousFocus = session.previousFocus;
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {}
    }
    session.resolve(true);
    return true;
  }

  ensureOperationDialog() {
    if (this.operationDialog) return this.operationDialog;
    if (!document.body || typeof document.createElement !== "function") return null;

    const dialog = document.createElement("dialog");
    dialog.className = "git-operation-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "git-operation-title");
    dialog.setAttribute(
      "aria-describedby",
      "git-operation-subtitle git-operation-message",
    );

    const content = document.createElement("div");
    content.className = "git-operation-dialog-content";
    const heading = document.createElement("div");
    heading.className = "git-operation-heading";
    const badge = document.createElement("span");
    badge.className = "git-operation-badge";
    badge.setAttribute("aria-hidden", "true");
    const badgeIcon = document.createElement("i");
    badge.appendChild(badgeIcon);
    const titleGroup = document.createElement("div");
    titleGroup.className = "git-operation-title-group";
    const title = document.createElement("h2");
    title.id = "git-operation-title";
    const subtitle = document.createElement("p");
    subtitle.id = "git-operation-subtitle";
    subtitle.className = "git-operation-subtitle";
    subtitle.textContent = "This action cannot be undone.";
    titleGroup.append(title, subtitle);
    heading.append(badge, titleGroup);
    const message = document.createElement("p");
    message.className = "git-operation-description";
    message.id = "git-operation-message";

    const files = document.createElement("div");
    files.className = "git-operation-files";

    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "nce-checkbox git-operation-checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = false;
    const checkboxBox = document.createElement("span");
    checkboxBox.className = "nce-checkbox-box";
    checkboxBox.setAttribute("aria-hidden", "true");
    const checkboxIcon = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    checkboxIcon.setAttribute("viewBox", "0 0 16 16");
    checkboxIcon.setAttribute("focusable", "false");
    const checkboxTick = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    checkboxTick.setAttribute("d", "M3.25 8.25 6.5 11.5 12.75 4.75");
    checkboxIcon.appendChild(checkboxTick);
    checkboxBox.appendChild(checkboxIcon);
    const checkboxText = document.createElement("span");
    checkboxText.className = "nce-checkbox-text";
    checkboxText.textContent = "Also discard staged changes";
    checkboxLabel.append(checkbox, checkboxBox, checkboxText);

    const actions = document.createElement("div");
    actions.className = "git-operation-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "git-operation-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.autofocus = true;
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "git-operation-confirm danger";
    actions.append(cancelButton, confirmButton);
    content.append(heading, message, files, checkboxLabel, actions);
    dialog.appendChild(content);

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.finishOperationDialog({ confirmed: false });
    });
    dialog.addEventListener("close", () => this.completeOperationDialog());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) this.finishOperationDialog({ confirmed: false });
    });
    cancelButton.addEventListener("click", () =>
      this.finishOperationDialog({ confirmed: false }));
    confirmButton.addEventListener("click", () =>
      this.finishOperationDialog({
        confirmed: true,
        includeStaged: checkbox.checked === true,
      }));
    document.body.appendChild(dialog);

    this.operationDialog = dialog;
    this.operationDialogBadgeIcon = badgeIcon;
    this.operationDialogTitle = title;
    this.operationDialogMessage = message;
    this.operationDialogFiles = files;
    this.operationDialogCheckboxLabel = checkboxLabel;
    this.operationDialogCheckbox = checkbox;
    this.operationDialogCancelButton = cancelButton;
    this.operationDialogConfirmButton = confirmButton;
    return dialog;
  }

  showDiscardConfirmation(targets) {
    const dialog = this.ensureOperationDialog();
    if (!dialog || dialog.open || this.operationDialogSession || this.destroyed)
      return Promise.resolve({ confirmed: false, includeStaged: false });

    const stagedOnly = targets.every((target) => target.staged);
    const untrackedCount = targets.filter(({ entry, staged }) =>
      !staged && (entry.kind === "untracked" || entry.worktree === "?")).length;
    this.operationDialog.dataset.mode = "discard";
    this.operationDialogBadgeIcon.className = "fi fi-rr-trash";
    this.operationDialogTitle.textContent = targets.length === 1
      ? (stagedOnly ? "Discard Staged Change" : "Discard Change")
      : (stagedOnly
        ? `Discard ${targets.length} Staged Changes`
        : `Discard ${targets.length} Changes`);
    this.operationDialogMessage.textContent = untrackedCount > 0
      ? (untrackedCount === targets.length
        ? (untrackedCount === 1
          ? "This untracked file will be permanently deleted."
          : "These untracked files will be permanently deleted.")
        : "Tracked changes will be reverted and untracked files will be permanently deleted.")
      : (stagedOnly
        ? "These staged changes will be removed from the index and the working tree."
        : "These working tree changes will be reverted.");

    this.operationDialogFiles.hidden = false;
    this.operationDialogFiles.replaceChildren();
    const visible = targets.slice(0, GitSidebar.MAX_DISCARD_LIST_ROWS);
    for (const { entry, staged } of visible) {
      const row = document.createElement("div");
      row.className = "git-operation-file";
      const fileBadge = document.createElement("span");
      fileBadge.className = "git-status-badge";
      fileBadge.dataset.kind = entry.conflicted ? "conflicted" : entry.kind;
      fileBadge.textContent = GitSidebar.statusLetter(entry, staged);
      const name = document.createElement("span");
      name.className = "git-operation-file-name";
      name.textContent = entry.originalPath
        ? `${entry.path} ← ${entry.originalPath}`
        : entry.path;
      name.title = name.textContent;
      row.append(fileBadge, name);
      this.operationDialogFiles.appendChild(row);
    }
    if (targets.length > visible.length) {
      const more = document.createElement("div");
      more.className = "git-operation-more";
      more.textContent = `…and ${targets.length - visible.length} more`;
      this.operationDialogFiles.appendChild(more);
    }
    const canIncludeStaged = this.canIncludeStaged(targets);
    this.operationDialogCheckboxLabel.hidden = !canIncludeStaged;
    this.operationDialogCheckbox.checked = false;
    this.operationDialogConfirmButton.textContent = stagedOnly
      ? "Discard Staged Changes"
      : "Discard Changes";
    this.operationDialogCancelButton.disabled = false;
    this.operationDialogConfirmButton.disabled = false;
    return this.openOperationDialog();
  }

  showAbortConfirmation(operation) {
    const dialog = this.ensureOperationDialog();
    if (!dialog || dialog.open || this.operationDialogSession || this.destroyed)
      return Promise.resolve({ confirmed: false });
    this.operationDialog.dataset.mode = "abort";
    this.operationDialogBadgeIcon.className = "fi fi-rr-triangle-warning";
    this.operationDialogTitle.textContent = operation === "merge"
      ? "Abort Merge"
      : "Abort Rebase";
    this.operationDialogMessage.textContent = operation === "merge"
      ? "This stops the merge in progress and restores the state from before it started."
      : "This stops the rebase in progress and returns the branch to its original state.";
    this.operationDialogFiles.hidden = true;
    this.operationDialogFiles.replaceChildren();
    this.operationDialogCheckboxLabel.hidden = true;
    this.operationDialogCheckbox.checked = false;
    this.operationDialogConfirmButton.textContent = operation === "merge"
      ? "Abort Merge"
      : "Abort Rebase";
    this.operationDialogCancelButton.disabled = false;
    this.operationDialogConfirmButton.disabled = false;
    return this.openOperationDialog();
  }

  openOperationDialog() {
    const dialog = this.operationDialog;
    return new Promise((resolve) => {
      const session = {
        resolve,
        result: null,
        completed: false,
        previousFocus: document.activeElement,
      };
      this.operationDialogSession = session;
      try {
        dialog.showModal();
        this.operationDialogCancelButton.focus({ preventScroll: true });
      } catch {
        session.result = { confirmed: false };
        this.completeOperationDialog();
      }
    });
  }

  finishOperationDialog(result) {
    const session = this.operationDialogSession;
    if (!session || session.result) return false;
    session.result = result;
    if (this.operationDialog?.open) this.operationDialog.close();
    else this.completeOperationDialog();
    return true;
  }

  completeOperationDialog() {
    const session = this.operationDialogSession;
    if (!session || session.completed) return false;
    this.operationDialogSession = null;
    session.completed = true;
    const previousFocus = session.previousFocus;
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {}
    }
    session.resolve(session.result || { confirmed: false });
    return true;
  }

  handleOperationDialogKeyDown(event) {
    if (!this.operationDialog?.open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      this.finishOperationDialog({ confirmed: false });
    }
    return true;
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
      await this.refresh({ reason: "branch" });
      if (this.destroyed) return false;
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

  async installGit() {
    if (this.destroyed || this.installingGit) return false;
    const installer = this.editor.api?.installer;
    if (typeof installer?.install !== "function") {
      this.notifyGit({
        type: "error",
        title: "Git installation unavailable",
        message: "Set the Git executable path in Settings instead.",
      });
      return false;
    }
    this.cancelScheduledRefresh();
    this.installingGit = true;
    this.installProgress = null;
    this.actionError = "";
    this.notice = "";
    this.updateView();
    this.unsubscribeInstallProgress = installer.onProgress?.((progress) => {
      if (this.destroyed || !this.installingGit) return;
      if (progress?.packageId !== "git") return;
      this.installProgress = progress;
      this.updateState();
    }) || null;
    const pending = this.notifyGit({
      type: "info",
      title: "Installing Git",
      message: "Downloading a verified Git build. This can take a few minutes.",
      persistent: true,
      actions: [{
        label: "Cancel",
        action: () => { void installer.cancel?.(); },
      }],
    });
    let result = null;
    try {
      result = await installer.install("git");
    } catch {
      result = null;
    }
    this.unsubscribeInstallProgress?.();
    this.unsubscribeInstallProgress = null;
    this.installingGit = false;
    this.installProgress = null;
    if (pending?.id) this.editor.notificationManager?.dismiss?.(pending.id);
    if (this.destroyed) return false;
    if (result?.success === true) {
      const saved = await SETTINGS_SET("git.path", result.executable);
      if (saved) {
        this.notice = `Git ${result.version} installed.`;
        this.notifyGit({
          type: "success",
          title: "Git installed",
          message: `Git ${result.version} is now used by Source Control.`,
        });
        await this.refresh({ reason: "settings" });
      } else {
        this.notifyGit({
          type: "error",
          title: "Git path could not be saved",
          message: `Git ${result.version} was installed at ${result.executable}. Set that path in Settings.`,
        });
      }
    } else if (result?.code === "CANCELLED") {
      this.notifyGit({
        type: "info",
        title: "Git installation cancelled",
        message: "Your Git configuration was left unchanged.",
      });
    } else {
      this.notifyGit({
        type: "error",
        title: "Git installation failed",
        message: result?.error || "The Git package could not be installed.",
        actions: [{
          label: "Retry",
          action: () => {
            if (!this.destroyed) void this.installGit();
          },
        }],
      });
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
      this.pruneEntrySelection();
    }
    if (reason === "open" || reason === "workspace")
      this.listResetPending = true;
    this.renderList();
    this.updateView();
    this.editor.bottomBar?.refreshGitBranch?.();
    if (reason === "stage" || reason === "commit" || reason === "branch" ||
        reason === "manual")
      void this.refreshDiffTabs();
    if (this.history.loaded && GitSidebar.HISTORY_REFRESH_REASONS.has(reason)) {
      // A collapsed section re-reads its log when it is opened again, not on
      // every commit, so unrelated work never re-renders the visible rows.
      if (this.collapsed.history === true) this.history.loaded = false;
      else void this.loadHistory({ reset: true });
    } else if (!this.collapsed.history && !this.history.loaded) {
      // An expanded section also loads on first open, not only after a
      // collapse/expand toggle, so it never shows an empty "History 0".
      void this.loadHistory({ reset: true });
    }
  }

  async refreshDiffTabs() {
    const manager = this.editor.tabManager;
    if (!manager?.tabs || this.destroyed) return;
    const workspaceRoot = this.editor.fileExplorer?.rootPath || "";
    if (!workspaceRoot) return;
    const workspaceGeneration = this.workspaceGeneration;
    const tabs = manager.tabs.filter((tab) =>
      tab.type === "git-diff" && !tab.commitHash &&
      this.isPathInWorkspace(tab.filePath, workspaceRoot));
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
    this.history = GitSidebar.emptyHistory();
    this.selectedCommit = null;
    this.commitDetail = null;
    this.compare = null;
    this.compareBase = null;
    this.error = null;
    this.stale = false;
    this.loading = false;
    this.commitMessage = root ? this.commitDrafts.get(root) || "" : "";
    this.commitError = "";
    this.actionError = "";
    this.initError = "";
    this.notice = "";
    this.operationPaths.clear();
    this.selectedEntries.clear();
    this.selectionAnchor = null;
    this.syncing = null;
    this.syncProgress = null;
    this.remotes = [];
    this.defaultRemote = null;
    this.remotesBusy = false;
    this.finishRemotesDialog();
    this.cloneBusy = false;
    this.cloneProgress = null;
    this.cloneDestination = "";
    this.finishCloneDialog();
    this.finishOperationDialog({ confirmed: false });
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
      this.unstagingAll || this.initializing || this.discarding || this.aborting ||
      Boolean(this.syncing);
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
    this.unsubscribeInstallProgress?.();
    this.unsubscribeInstallProgress = null;
    this.unsubscribeNetworkProgress?.();
    this.unsubscribeNetworkProgress = null;
    this.fileScroller?.destroy?.();
    this.fileScroller = null;
    this.finishRemotesDialog();
    this.remotesDialog?.remove();
    this.remotesDialog = null;
    this.finishCloneDialog();
    this.cloneDialog?.remove();
    this.cloneDialog = null;
    this.finishOperationDialog({ confirmed: false });
    this.operationDialog?.remove();
    this.operationDialog = null;
    this.container?.remove();
    this.container = null;
  }
}
