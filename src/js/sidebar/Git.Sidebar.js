class GitSidebar extends Sidebar {
  static resolveAbsolutePath(root, relativePath) {
    if (typeof root !== "string" || !root.trim()) return null;
    if (typeof relativePath !== "string" || !relativePath.trim()) return null;
    const normalized = relativePath.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
    const segments = normalized.split("/");
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
    const normalized = String(relativePath || "").replace(/\\/g, "/");
    const index = normalized.lastIndexOf("/");
    if (index < 0) return { name: normalized, dir: "" };
    return { name: normalized.slice(index + 1), dir: normalized.slice(0, index) };
  }

  constructor(editor) {
    super("git", "Source Control", "fi fi-rr-code-branch", "left", editor);
    this.container = null;
    this.repoNameElement = null;
    this.branchElement = null;
    this.refreshButton = null;
    this.menuButton = null;
    this.commitInput = null;
    this.commitButton = null;
    this.commitStatus = null;
    this.stateElement = null;
    this.stateText = null;
    this.stateRetry = null;
    this.listViewport = null;
    this.listLayer = null;

    this.fileScroller = new SearchResultsScroller(
      editor,
      (item) => this.createListItem(item),
    );

    this.workspaceRoot = "";
    this.status = null;
    this.error = null;
    this.stale = false;
    this.loading = false;
    this.commitMessage = "";
    this.committing = false;
    this.commitError = "";
    this.actionError = "";
    this.notice = "";
    this.operationPaths = new Set();
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

    const title = document.createElement("div");
    title.className = "sidebar-main-title";
    title.textContent = "SOURCE CONTROL";

    const header = document.createElement("div");
    header.className = "git-sidebar-header";

    const identity = document.createElement("div");
    identity.className = "git-sidebar-identity";
    const repoName = document.createElement("span");
    repoName.className = "git-sidebar-repo-name";
    const branch = document.createElement("span");
    branch.className = "git-sidebar-branch";
    identity.append(repoName, branch);
    this.repoNameElement = repoName;
    this.branchElement = branch;

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
    this.menuButton = menuButton;

    headerActions.append(refreshButton, menuButton);
    header.append(identity, headerActions);

    header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openHeaderContextMenu();
    });

    const commitBox = document.createElement("div");
    commitBox.className = "git-sidebar-commit";
    const commitInput = document.createElement("textarea");
    commitInput.className = "git-sidebar-commit-input";
    commitInput.rows = 2;
    commitInput.placeholder = "Message (Ctrl+Enter to commit)";
    commitInput.setAttribute("aria-label", "Commit message");
    commitInput.spellcheck = false;
    commitInput.addEventListener("input", () => {
      this.commitMessage = commitInput.value;
      this.updateCommitControls();
    });
    commitInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.commitChanges();
      }
    });
    this.commitInput = commitInput;

    const commitActions = document.createElement("div");
    commitActions.className = "git-sidebar-commit-actions";
    const commitStatus = document.createElement("span");
    commitStatus.className = "git-sidebar-commit-status";
    commitStatus.setAttribute("role", "status");
    commitStatus.setAttribute("aria-live", "polite");
    this.commitStatus = commitStatus;
    const commitButton = document.createElement("button");
    commitButton.type = "button";
    commitButton.className = "git-sidebar-commit-button";
    commitButton.textContent = "Commit";
    commitButton.disabled = true;
    commitButton.addEventListener("click", () => void this.commitChanges());
    this.commitButton = commitButton;
    commitActions.append(commitStatus, commitButton);
    commitBox.append(commitInput, commitActions);

    const state = document.createElement("div");
    state.className = "git-sidebar-state";
    state.hidden = true;
    const stateText = document.createElement("div");
    stateText.className = "git-sidebar-state-text";
    const stateRetry = document.createElement("button");
    stateRetry.type = "button";
    stateRetry.className = "git-sidebar-retry";
    stateRetry.textContent = "Retry";
    stateRetry.addEventListener("click", () => this.refresh({ reason: "manual" }));
    state.append(stateText, stateRetry);
    this.stateElement = state;
    this.stateText = stateText;
    this.stateRetry = stateRetry;

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
    this.listViewport = viewport;
    this.listLayer = layerNode;
    this.fileScroller.attach(list, viewport, layerNode);

    container.append(title, header, commitBox, state, list);
    this.updateView();
    return container;
  }

  updateView() {
    if (!this.container) return;
    const projectName = this.editor.fileExplorer?.projectName;
    const rootName = this.workspaceRoot
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    if (this.repoNameElement) {
      this.repoNameElement.textContent = projectName || rootName || "Workspace";
      this.repoNameElement.title = this.workspaceRoot || "";
    }
    const branch = this.status?.branch;
    const branchLabel = branch
      ? branch.name || (branch.oid ? `detached @ ${branch.oid.slice(0, 7)}` : "detached")
      : "";
    if (this.branchElement) {
      this.branchElement.textContent = branchLabel;
      this.branchElement.hidden = !branchLabel;
      const tracking = branch && (branch.ahead || branch.behind)
        ? ` ↑${branch.ahead} ↓${branch.behind}`
        : "";
      this.branchElement.title = branch
        ? `${branchLabel}${tracking}${branch.upstream ? ` (${branch.upstream})` : ""}`
        : "";
    }
    if (this.refreshButton) {
      this.refreshButton.disabled = this.loading;
      if (this.loading) this.refreshButton.setAttribute("aria-busy", "true");
      else this.refreshButton.removeAttribute("aria-busy");
    }
    if (this.commitInput) {
      const focused = typeof document !== "undefined" &&
        document.activeElement === this.commitInput;
      if (!focused && this.commitInput.value !== this.commitMessage)
        this.commitInput.value = this.commitMessage;
      this.commitInput.disabled = this.committing;
    }
    this.updateCommitControls();
    this.updateState();
  }

  updateCommitControls() {
    if (this.commitButton)
      this.commitButton.disabled = !this.canCommit();
    if (!this.commitStatus) return;
    this.commitStatus.textContent = this.getCommitStatusText();
    this.commitStatus.dataset.state = this.actionError || this.commitError
      ? "error"
      : this.stale
        ? "warning"
        : "info";
  }

  getCommitStatusText() {
    return this.actionError || this.commitError ||
      this.notice || (this.stale ? "Changes may be out of date." : "");
  }

  getStateMessage() {
    if (!this.workspaceRoot) return "Open a folder to review its changes.";
    if (this.error && !(this.stale && this.status)) return this.error.message;
    if (!this.status && this.loading) return "Loading Source Control…";
    return "";
  }

  updateState() {
    if (!this.stateElement || !this.stateText || !this.stateRetry) return;
    const message = this.getStateMessage();
    this.stateElement.hidden = !message;
    this.stateText.textContent = message;
    this.stateRetry.hidden = !(this.error && this.error.code !== "GIT_NOT_FOUND");
    this.stateRetry.disabled = this.loading;
  }

  getSections() {
    const entries = this.status?.entries || [];
    const staged = entries.filter((entry) =>
      entry.conflicted !== true && entry.index !== null && entry.index !== undefined);
    const changes = entries.filter((entry) =>
      entry.conflicted === true ||
      entry.worktree !== null && entry.worktree !== undefined ||
      entry.kind === "untracked");
    return { staged, changes };
  }

  stagedCount() {
    return this.getSections().staged.length;
  }

  canCommit() {
    return Boolean(this.status) &&
      this.stagedCount() > 0 &&
      this.commitMessage.trim().length > 0 &&
      !this.committing &&
      !this.loading;
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
    const toggle = () => {
      this.collapsed[item.section] = !this.collapsed[item.section];
      this.saveCollapsedState();
      this.renderList();
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (event) => {
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
    if (staged.length === 0 && changes.length === 0) {
      items.push({
        type: "empty",
        text: "No changes in this workspace.",
        height: 48,
        rowHeight: 48,
      });
      return items;
    }
    items.push({
      type: "section",
      section: "staged",
      title: "Staged Changes",
      count: staged.length,
      height: 26,
      rowHeight: 26,
    });
    if (this.collapsed.staged !== true) {
      if (staged.length === 0)
        items.push({ type: "empty", text: "No staged changes", height: 34, rowHeight: 34 });
      else
        for (const entry of staged)
          items.push({ type: "entry", section: "staged", entry, height: 24, rowHeight: 24 });
    }
    items.push({
      type: "section",
      section: "changes",
      title: "Changes",
      count: changes.length,
      height: 26,
      rowHeight: 26,
    });
    if (this.collapsed.changes !== true) {
      if (changes.length === 0)
        items.push({ type: "empty", text: "No unstaged changes", height: 34, rowHeight: 34 });
      else
        for (const entry of changes)
          items.push({ type: "entry", section: "changes", entry, height: 24, rowHeight: 24 });
    }
    return items;
  }

  renderList() {
    if (!this.fileScroller) return;
    const { staged, changes } = this.getSections();
    this.fileScroller.setItems(this.buildListItems(staged, changes), {
      resetScroll: this.listResetPending,
    });
    this.listResetPending = false;
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

  clearTransientMessages() {
    this.actionError = "";
    this.commitError = "";
  }

  async toggleStage(entry, staged) {
    const filePath = GitSidebar.resolveAbsolutePath(this.workspaceRoot, entry?.path);
    if (!filePath) {
      this.setActionError("This change is outside the workspace.");
      return false;
    }
    if (this.operationPaths.has(entry.path)) return false;
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
    if (result?.success === true) {
      this.notice = staged ? `Unstaged ${entry.path}` : `Staged ${entry.path}`;
    } else {
      this.actionError = result?.error || "The Git operation failed.";
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
    return this.editor.tabManager?.openGitDiff?.({
      filePath,
      relativePath: entry.path,
      staged: staged === true,
      statusKind: entry.kind,
      originalPath: entry.originalPath || null,
    }) || null;
  }

  async openEntryFile(entry) {
    const filePath = GitSidebar.resolveAbsolutePath(this.workspaceRoot, entry?.path);
    if (!filePath || entry.kind === "deleted") return null;
    return this.editor.tabManager?.openFileWithPath?.(filePath) ?? null;
  }

  async commitChanges() {
    if (!this.canCommit()) return false;
    const message = this.commitMessage.trim();
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
    if (result?.success === true) {
      this.commitMessage = "";
      if (this.commitInput) this.commitInput.value = "";
      this.notice = `Committed ${String(result.hash || "").slice(0, 7)}`;
      await this.refresh({ reason: "commit" });
    } else {
      const code = result?.code;
      this.commitError = code === "GIT_HOOK_FAILED"
        ? "A Git hook rejected the commit. The message was kept."
        : code === "EMPTY_COMMIT_MESSAGE"
          ? "Enter a commit message."
          : result?.error || "The commit failed.";
      if (code === "NOTHING_TO_COMMIT") await this.refresh({ reason: "commit" });
    }
    this.updateView();
    return result?.success === true;
  }

  async refresh({ reason = "manual" } = {}) {
    if (this.destroyed) return;
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
    if (!result) {
      this.applyStatusError({
        code: "GIT_COMMAND_FAILED",
        error: "Git status could not be read.",
      });
    } else if (result.success !== true) {
      this.applyStatusError(result);
    } else {
      this.status = result.status;
      this.error = null;
      this.stale = false;
    }
    if (reason === "open" || reason === "workspace")
      this.listResetPending = true;
    this.renderList();
    this.updateView();
  }

  applyStatusError(result) {
    const code = result?.code;
    const terminal = code === "GIT_NOT_FOUND" ||
      code === "NOT_A_REPOSITORY" ||
      code === "REPOSITORY_NOT_FOUND" ||
      code === "PERMISSION_DENIED";
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
    this.workspaceRoot = root;
    this.generation++;
    this.status = null;
    this.error = null;
    this.stale = false;
    this.loading = false;
    this.commitMessage = "";
    this.commitError = "";
    this.actionError = "";
    this.notice = "";
    this.operationPaths.clear();
    this.listResetPending = true;
    if (this.commitInput) this.commitInput.value = "";
    this.renderList();
    this.updateView();
  }

  handleWorkspaceChanged(rootPath) {
    const root = typeof rootPath === "string"
      ? rootPath
      : this.editor.fileExplorer?.rootPath || "";
    this.applyWorkspace(root);
    if (this.isOpen && root) void this.refresh({ reason: "workspace" });
  }

  handleFileSystemEvents() {
    if (!this.isOpen || this.committing) return;
    this.scheduleRefresh();
  }

  noteEditorSave() {
    if (!this.isOpen || this.committing) return;
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    if (this.destroyed) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
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
    this.unsubscribeFileSystem?.();
    this.unsubscribeFileSystem = null;
    this.fileScroller?.destroy?.();
    this.fileScroller = null;
    this.container?.remove();
    this.container = null;
  }
}
