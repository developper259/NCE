class RunChangeTracker {
  constructor(agent) {
    this.agent = agent;
    this.current = null;
  }

  beginRun(runId, workspaceIdentity = null) {
    const requestedRoot =
      typeof workspaceIdentity === "string" && workspaceIdentity.trim()
        ? workspaceIdentity.trim()
        : this.agent?.editor?.fileExplorer?.rootPath || null;
    const identity =
      typeof requestedRoot === "string" && requestedRoot.trim()
        ? AgentPath.normalize(requestedRoot.trim())
        : null;
    this.current = {
      runId: Number.isInteger(runId) ? runId : (this.agent?.runId ?? 0),
      workspaceIdentity: identity,
      startedAt: Date.now(),
      status: "running",
      changes: new Map(),
      pendingToolCalls: new Set(),
      unresolvedFailures: new Map(),
      reviewedChangedFiles: false,
      reviewedDiff: false,
      reviewedChangedFilesVersion: null,
      reviewedDiffVersion: null,
      changeVersion: 0,
      invalidated: false,
    };
    this.agent.currentRunState = this.current;
    return this.current;
  }

  isActiveRun(runId = this.agent?.runId) {
    return Boolean(
      this.current &&
      this.current.runId === runId &&
      this.current.status !== "completed" &&
      this.current.status !== "aborted" &&
      this.current.status !== "failed",
    );
  }

  setRunStatus(status, runId = this.current?.runId) {
    if (!this.current || this.current.runId !== runId) return null;
    const terminal = new Set(["completed", "aborted", "failed"]);
    if (terminal.has(this.current.status)) return this.current;
    if (["completed", "aborted", "failed", "running"].includes(status)) {
      this.current.status = status;
    }
    return this.current;
  }

  commitCompletedState(runId = this.current?.runId) {
    if (!this.current || this.current.runId !== runId) return false;
    if (this.current.status !== "running") return false;
    this.current.status = "completed";
    this.current.completedAt = Date.now();
    return true;
  }

  workspaceMatches(
    workspaceIdentity = this.agent?.editor?.fileExplorer?.rootPath || null,
  ) {
    if (!this.current) return false;
    const identity =
      typeof workspaceIdentity === "string" && workspaceIdentity.trim()
        ? AgentPath.normalize(workspaceIdentity.trim())
        : null;
    return (
      identity &&
      this.current.workspaceIdentity &&
      AgentPath.samePath(this.current.workspaceIdentity, identity)
    );
  }

  normalizePath(path) {
    if (typeof path !== "string" || !path.trim()) return "";
    const relative = path.trim().replace(/\\/g, "/");
    return AgentPath.isAbsolute(relative)
      ? this.agent.toProjectRelativePath(
          relative,
          this.current?.workspaceIdentity ||
            this.agent?.editor?.fileExplorer?.rootPath ||
            "",
        )
      : relative;
  }

  changeKeyForPath(path) {
    const normalized = this.normalizePath(path);
    return normalized || path;
  }

  addChange(change) {
    if (!this.current) return null;
    const key = this.changeKeyForPath(
      change?.path || change?.oldPath || change?.currentPath || "",
    );
    if (!key) return null;
    const existing = this.current.changes.get(key);
    if (existing) {
      const merged = {
        ...existing,
        ...change,
        path:
          change.path ||
          existing.path ||
          existing.currentPath ||
          existing.oldPath ||
          key,
        status: change.status || existing.status || "modified",
        originalPath:
          existing.originalPath ||
          change.originalPath ||
          existing.oldPath ||
          existing.path ||
          key,
        originalContent:
          change.originalContent ??
          existing.originalContent ??
          existing.beforeContent ??
          null,
        beforeContent: existing.beforeContent ?? change.beforeContent ?? null,
        afterContent: change.afterContent ?? existing.afterContent ?? null,
        beforeRevision:
          existing.beforeRevision ?? change.beforeRevision ?? null,
        afterRevision: change.afterRevision ?? existing.afterRevision ?? null,
        created: change.created ?? existing.created ?? false,
        modified: change.modified ?? existing.modified ?? false,
        renamed: change.renamed ?? existing.renamed ?? false,
        deleted: change.deleted ?? existing.deleted ?? false,
        additions: Number.isFinite(change.additions)
          ? change.additions
          : (existing.additions ?? 0),
        deletions: Number.isFinite(change.deletions)
          ? change.deletions
          : (existing.deletions ?? 0),
        reviewed: change.reviewed ?? existing.reviewed ?? false,
        review: change.review ?? existing.review ?? null,
      };
      this.current.changeVersion += 1;
      this.current.changes.set(key, merged);
      return merged;
    }
    const record = {
      path: change.path || key,
      originalPath: change.originalPath || change.oldPath || change.path || key,
      currentPath: change.currentPath || change.path || key,
      status: change.status || "modified",
      beforeContent: change.beforeContent ?? null,
      afterContent: change.afterContent ?? null,
      beforeRevision: change.beforeRevision ?? null,
      afterRevision: change.afterRevision ?? null,
      created: Boolean(change.created),
      modified: Boolean(change.modified),
      renamed: Boolean(change.renamed),
      deleted: Boolean(change.deleted),
      additions: Number.isFinite(change.additions) ? change.additions : 0,
      deletions: Number.isFinite(change.deletions) ? change.deletions : 0,
      reviewed: false,
      review: null,
    };
    this.current.changeVersion += 1;
    this.current.changes.set(key, record);
    return record;
  }

  recordCreate(result = {}) {
    if (!this.current || result?.success === false || !result?.path)
      return null;
    const relativePath = this.normalizePath(result.path);
    const content =
      typeof result.verification?.content === "string"
        ? result.verification.content
        : typeof result.content === "string"
          ? result.content
          : "";
    const record = {
      path: relativePath,
      originalPath: relativePath,
      currentPath: relativePath,
      status: "created",
      beforeContent: null,
      afterContent: content,
      beforeRevision: null,
      afterRevision: result.revision || result.verification?.revision || null,
      created: true,
      modified: false,
      renamed: false,
      deleted: false,
      additions: Math.max(0, (content.match(/\n/g) || []).length),
      deletions: 0,
      reviewed: false,
      review: null,
    };
    return this.addChange(record);
  }

  recordModify(result = {}) {
    if (!this.current || result?.success === false || !result?.path)
      return null;
    const relativePath = this.normalizePath(result.path);
    const before =
      typeof result.beforeText === "string" ? result.beforeText : null;
    const after =
      typeof result.afterText === "string" ? result.afterText : null;
    const existing = this.current.changes.get(relativePath);
    const change = {
      path: relativePath,
      originalPath: relativePath,
      currentPath: relativePath,
      status: existing?.status === "created" ? "created" : existing?.status === "renamed" ? "renamed" : "modified",
      beforeContent: before,
      afterContent: after,
      beforeRevision: result.previousRevision || null,
      afterRevision: result.revision || null,
      created: existing?.created === true,
      modified: true,
      renamed: false,
      deleted: false,
      additions: this.countAddedLines(before, after),
      deletions: this.countDeletedLines(before, after),
    };
    return this.addChange(change);
  }

  recordRename(result = {}) {
    if (
      !this.current ||
      result?.success === false ||
      !result?.oldPath ||
      !result?.newPath
    )
      return null;
    const oldPath = this.normalizePath(result.oldPath);
    const newPath = this.normalizePath(result.newPath);
    const existing =
      this.current.changes.get(oldPath) || this.current.changes.get(newPath);
    if (existing?.status === "created") {
      this.current.changes.delete(oldPath);
      existing.path = newPath;
      existing.currentPath = newPath;
      existing.originalPath = newPath;
      existing.renamed = true;
      existing.afterRevision = result.verification?.revision || existing.afterRevision;
      this.current.changeVersion += 1;
      this.current.changes.set(newPath, existing);
      return existing;
    }
    if (existing && existing.status === "renamed") {
      existing.status = "renamed";
      existing.renamed = true;
      existing.modified = Boolean(existing.modified || result.renamed);
      existing.originalPath = existing.originalPath || oldPath;
      existing.currentPath = newPath;
      existing.path = newPath;
      existing.oldPath = oldPath;
      existing.beforeContent = existing.beforeContent ?? null;
      existing.afterContent = existing.afterContent ?? null;
      existing.beforeRevision = existing.beforeRevision ?? null;
      existing.afterRevision = existing.afterRevision ?? null;
      this.current.changes.delete(oldPath);
      this.current.changes.set(newPath, existing);
      this.current.changeVersion += 1;
      return existing;
    }
    const generated = {
      path: newPath,
      oldPath,
      originalPath: oldPath,
      currentPath: newPath,
      status: "renamed",
      beforeContent: null,
      afterContent: null,
      beforeRevision: null,
      afterRevision: result.verification?.revision || null,
      created: false,
      modified: false,
      renamed: true,
      deleted: false,
      additions: 0,
      deletions: 0,
    };
    this.current.changes.delete(oldPath);
    const change = this.addChange(generated);
    return change;
  }

  recordDelete(result = {}, beforeContent = null) {
    if (!this.current || result?.success === false || !result?.path)
      return null;
    const relativePath = this.normalizePath(result.path);
    const existing = this.current.changes.get(relativePath);
    if (existing && existing.status === "created") {
      this.current.changes.delete(relativePath);
      this.current.changeVersion += 1;
      return null;
    }
    const deletion = {
      path: relativePath,
      originalPath: existing?.originalPath || relativePath,
      currentPath: relativePath,
      status: "deleted",
      beforeContent: existing?.beforeContent ?? beforeContent,
      afterContent: null,
      beforeRevision: null,
      afterRevision: null,
      created: false,
      modified: false,
      renamed: false,
      deleted: true,
      additions: 0,
      deletions: this.countLines(beforeContent || ""),
    };
    return this.addChange(deletion);
  }

  countLines(content) {
    if (typeof content !== "string" || content === "") return 0;
    return content.split(/\r?\n/).length;
  }

  countAddedLines(beforeText, afterText) {
    if (typeof beforeText !== "string" || typeof afterText !== "string")
      return 0;
    const beforeLines = beforeText.split(/\r?\n/);
    const afterLines = afterText.split(/\r?\n/);
    return Math.max(0, afterLines.length - beforeLines.length);
  }

  countDeletedLines(beforeText, afterText) {
    if (typeof beforeText !== "string" || typeof afterText !== "string")
      return 0;
    const beforeLines = beforeText.split(/\r?\n/);
    const afterLines = afterText.split(/\r?\n/);
    return Math.max(0, beforeLines.length - afterLines.length);
  }

  markReviewChangedFiles() {
    if (!this.current) return false;
    this.current.reviewedChangedFiles = true;
    this.current.reviewedChangedFilesVersion = this.current.changeVersion;
    return true;
  }

  markReviewDiff(path = null, result = null) {
    if (!this.current) return false;
    if (path) {
      const change = this.current.changes.get(this.normalizePath(path));
      if (!change) return false;
      change.reviewed = true;
      change.reviewVersion = this.current.changeVersion;
      return true;
    }
    if (result?.truncated === true) return false;
    this.current.reviewedDiff = true;
    this.current.reviewedDiffVersion = this.current.changeVersion;
    return true;
  }

  getChangedFiles(args = {}) {
    if (!this.current) return { success: true, files: [], runId: null };
    const files = [...this.current.changes.values()].map((change) => ({
      path: change.path,
      status: change.status,
      oldPath:
        change.oldPath ||
        (change.status === "renamed" ? change.originalPath : undefined),
      additions: Number.isFinite(change.additions) ? change.additions : 0,
      deletions: Number.isFinite(change.deletions) ? change.deletions : 0,
    }));
    if (args?.path) {
      const path = this.normalizePath(args.path);
      return {
        success: true,
        runId: this.current.runId,
        files: files.filter(
          (entry) => entry.path === path || entry.oldPath === path,
        ),
      };
    }
    return { success: true, runId: this.current.runId, files };
  }

  getDiff(args = {}) {
    if (!this.current)
      return {
        success: false,
        error: { code: "NO_ACTIVE_RUN", message: "Aucun run Agent actif." },
      };
    const requestedPath =
      typeof args?.path === "string" ? this.normalizePath(args.path) : null;
    const wanted = requestedPath
      ? this.current.changes.get(requestedPath)
      : null;
    if (requestedPath && !wanted) {
      return {
        success: false,
        error: {
          code: "PATH_NOT_CHANGED",
          message: "Le chemin demandé n appartient pas à ce run.",
        },
      };
    }
    const changes = requestedPath
      ? [wanted]
      : [...this.current.changes.values()];
    const diff = [];
    for (const entry of changes) {
      diff.push(this.renderDiff(entry));
    }
    const text = diff.join("\n");
    const limit = this.agent?.toolExecutor?.getToolOutputLimit?.(
      "get_diff",
    ) || {
      maxChars: 12000,
    };
    const maxChars = Number.isFinite(limit.maxChars)
      ? Math.max(1, Math.floor(limit.maxChars))
      : 12000;
    const patch = {
      success: true,
      runId: this.current.runId,
      truncated: false,
      hasMore: false,
      path: requestedPath || null,
      diff: text,
    };
    if (text.length > maxChars) {
      patch.truncated = true;
      patch.hasMore = true;
      patch.diff = `${text.slice(0, maxChars)}\n... [truncated]`;
    }

    const fileChanged = requestedPath
      ? this.detectUserChangeAfterAgent(requestedPath)
      : this.detectAnyUserChangeAfterAgent();
    if (fileChanged) {
      patch.currentFileChangedSinceAgentEdit = true;
    }

    return patch;
  }

  detectUserChangeAfterAgent(path = null) {
    if (!this.current || !this.agent?.editor?.tabManager) return false;
    const normalizedPath =
      typeof path === "string" ? this.normalizePath(path) : "";
    if (!normalizedPath) return false;
    const change = this.current.changes.get(normalizedPath);
    if (!change || typeof change.afterContent !== "string") return false;

    const absolute = this.agent.resolveWorkspacePath(
      normalizedPath,
      this.current.workspaceIdentity ||
        this.agent.editor?.fileExplorer?.rootPath ||
        "",
    );
    if (!absolute) return false;

    const openFile = this.agent.editor?.tabManager?.getFileByPath?.(absolute);
    if (!openFile || !Array.isArray(openFile.lines)) return false;

    const liveText = openFile.lines.map((line) => line.getText()).join("\n");
    return (
      this.normalizeLineEndings(liveText) !==
      this.normalizeLineEndings(change.afterContent)
    );
  }

  detectAnyUserChangeAfterAgent() {
    if (!this.current || !this.agent?.editor?.tabManager) return false;
    for (const [key, change] of this.current.changes.entries()) {
      if (
        typeof change.afterContent === "string" &&
        this.detectUserChangeAfterAgent(key)
      ) {
        return true;
      }
    }
    return false;
  }

  normalizeLineEndings(value = "") {
    return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
  }

  renderDiff(change) {
    const before = change.beforeContent ?? "";
    const after = change.afterContent ?? "";
    const oldPath = change.oldPath || change.originalPath || change.path;
    const newPath = change.path;
    if (change.status === "created") {
      return [
        `--- /dev/null`,
        `+++ b/${newPath}`,
        `@@ -0,0 +1,${this.countLines(after)} @@`,
        ...after.split(/\r?\n/).map((line) => `+${line}`),
      ].join("\n");
    }
    if (change.status === "deleted") {
      return [
        `--- a/${oldPath}`,
        `+++ /dev/null`,
        `@@ -1,${this.countLines(before)} +0,0 @@`,
        ...before.split(/\r?\n/).map((line) => `-${line}`),
      ].join("\n");
    }
    if (change.status === "renamed") {
      return [
        `--- a/${oldPath}`,
        `+++ b/${newPath}`,
        `@@ -1,${Math.max(1, this.countLines(before || after || ""))} +1,${Math.max(1, this.countLines(after || before || ""))} @@`,
      ].join("\n");
    }
    const lines = this.unifiedDiffLines(before, after);
    return [`--- a/${oldPath}`, `+++ b/${newPath}`, ...lines].join("\n");
  }

  unifiedDiffLines(before, after) {
    const beforeLines = String(before || "").split(/\r?\n/);
    const afterLines = String(after || "").split(/\r?\n/);
    const cells = beforeLines.length * afterLines.length;
    if (cells > 1_000_000) {
      return [
        `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
        ...beforeLines.map((line) => `-${line}`),
        ...afterLines.map((line) => `+${line}`),
      ];
    }
    const table = Array.from(
      { length: beforeLines.length + 1 },
      () => new Uint32Array(afterLines.length + 1),
    );
    for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
      for (let j = afterLines.length - 1; j >= 0; j -= 1) {
        table[i][j] = beforeLines[i] === afterLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const lines = [];
    let i = 0;
    let j = 0;
    while (i < beforeLines.length || j < afterLines.length) {
      if (
        i < beforeLines.length &&
        j < afterLines.length &&
        beforeLines[i] === afterLines[j]
      ) {
        i += 1;
        j += 1;
      } else if (
        j < afterLines.length &&
        (i === beforeLines.length || table[i][j + 1] >= table[i + 1][j])
      ) {
        lines.push(`+${afterLines[j++]}`);
      } else {
        lines.push(`-${beforeLines[i++]}`);
      }
    }
    return lines.length
      ? [
          `@@ -1,${Math.max(1, beforeLines.length)} +1,${Math.max(1, afterLines.length)} @@`,
          ...lines,
        ]
      : [`@@ -1,0 +1,0 @@`];
  }

  hasEffectiveChanges() {
    if (!this.current) return false;
    return this.current.changes.size > 0;
  }

  validateTaskComplete(args = {}) {
    if (!this.current) {
      return {
        success: true,
        taskCompleteRequested: true,
        validation: "accepted",
        changedFiles: 0,
      };
    }
    if (this.current.status === "aborted") {
      return {
        success: false,
        error: { code: "RUN_ABORTED", message: "Le run a été abandonné." },
      };
    }
    if (this.current.status === "completed") {
      return {
        success: false,
        error: { code: "RUN_COMPLETED", message: "Le run est déjà terminé." },
      };
    }
    if (this.current.status === "failed") {
      return {
        success: false,
        error: { code: "RUN_FAILED", message: "Le run a déjà échoué." },
      };
    }
    if (
      this.current.invalidated ||
      !this.workspaceMatches(this.agent.editor?.fileExplorer?.rootPath)
    ) {
      return {
        success: false,
        error: {
          code: "WORKSPACE_CHANGED",
          message: "Le workspace du run n est plus valide.",
        },
      };
    }
    if (this.current.pendingToolCalls && this.current.pendingToolCalls.size) {
      return {
        success: false,
        error: {
          code: "RUN_NOT_SETTLED",
          message: "Un appel tool encore en attente bloque la complétion.",
        },
      };
    }
    if (
      this.current.unresolvedFailures &&
      [...this.current.unresolvedFailures.values()].some(
        (failure) => failure.blocking !== false,
      )
    ) {
      return {
        success: false,
        error: {
          code: "UNRESOLVED_FAILURES",
          message: "Une erreur importante du run reste non résolue.",
        },
      };
    }
    if (this.hasEffectiveChanges()) {
      const reviewCurrentForChangedFiles =
        this.current.reviewedChangedFilesVersion === this.current.changeVersion;
      const reviewCurrentForDiff =
        this.current.reviewedDiffVersion === this.current.changeVersion;
      const everyFileReviewed = [...this.current.changes.values()].every(
        (change) => change.reviewVersion === this.current.changeVersion,
      );
      if (!reviewCurrentForChangedFiles && !reviewCurrentForDiff && !everyFileReviewed) {
        return {
          success: false,
          error: {
            code: "CHANGES_NOT_REVIEWED",
            message:
              "Revoyez get_changed_files ou get_diff avant task_complete.",
          },
        };
      }
    }
    return {
      success: true,
      taskCompleteRequested: true,
      validation: "eligible",
      changedFiles: this.current.changes.size,
    };
  }

  markPending(toolCallId, runId = this.current?.runId ?? null) {
    if (!this.current) return;
    if (runId !== null && runId !== this.current.runId) return;
    if (typeof toolCallId === "string" && toolCallId.trim()) {
      this.current.pendingToolCalls.add(toolCallId);
    }
  }

  clearPending(toolCallId, runId = this.current?.runId ?? null) {
    if (!this.current) return;
    if (runId !== null && runId !== this.current.runId) return;
    if (typeof toolCallId === "string" && toolCallId.trim()) {
      this.current.pendingToolCalls.delete(toolCallId);
    }
  }

  addUnresolvedFailure(codeOrFailure, message, classification = "unresolved") {
    if (!this.current) return;
    if (codeOrFailure && typeof codeOrFailure === "object") {
      const failure = codeOrFailure;
      const error = failure.error || {};
      const code = error.code || "TOOL_FAILED";
      const path = this.normalizePath(failure.path || "");
      const identity = `${failure.toolName || "unknown"}:${path}:${code}`;
      const previous = this.current.unresolvedFailures.get(identity);
      this.current.unresolvedFailures.set(identity, {
        identity,
        code,
        toolCallId: failure.toolCallId || previous?.toolCallId || null,
        toolName: failure.toolName || previous?.toolName || null,
        path: path || null,
        message: error.message || previous?.message || "Tool failure",
        classification: failure.classification || error.retryStrategy || "unresolved",
        blocking: failure.blocking !== false,
        firstSeen: previous?.firstSeen || Date.now(),
        lastSeen: Date.now(),
        recoveryAction: failure.recoveryAction || null,
        status: "open",
      });
      return identity;
    }
    const code = codeOrFailure;
    if (typeof code === "string" && code.trim()) {
      this.current.unresolvedFailures.set(code, {
        code,
        message: typeof message === "string" ? message : String(message || ""),
        classification,
        status: "open",
      });
    }
  }

  resolveFailuresForTool(toolName, path = null, classification = "recovered") {
    if (!this.current) return 0;
    const normalizedPath = this.normalizePath(path || "");
    let count = 0;
    for (const [identity, failure] of this.current.unresolvedFailures) {
      if (
        failure.toolName === toolName &&
        (!normalizedPath || !failure.path || AgentPath.samePath(failure.path, normalizedPath))
      ) {
        failure.status = "resolved";
        failure.classification = classification;
        this.current.unresolvedFailures.delete(identity);
        count += 1;
      }
    }
    return count;
  }

  resolveFailuresForPath(path, codes = null, classification = "recovered") {
    if (!this.current) return 0;
    const normalizedPath = this.normalizePath(path || "");
    if (!normalizedPath) return 0;
    const allowed = Array.isArray(codes) ? new Set(codes) : null;
    let count = 0;
    for (const [identity, failure] of this.current.unresolvedFailures) {
      if (
        failure.path &&
        AgentPath.samePath(failure.path, normalizedPath) &&
        (!allowed || allowed.has(failure.code))
      ) {
        failure.status = "resolved";
        failure.classification = classification;
        this.current.unresolvedFailures.delete(identity);
        count += 1;
      }
    }
    return count;
  }

  resolveFailure(code, classification = "resolved") {
    if (!this.current) return;
    if (typeof code === "string") {
      const failure = this.current.unresolvedFailures.get(code);
      if (failure) {
        failure.status = "resolved";
        failure.classification = classification;
      }
      this.current.unresolvedFailures.delete(code);
    }
  }

  classifyFailure(code, classification = "unresolved") {
    if (!this.current || typeof code !== "string") return null;
    const existing = this.current.unresolvedFailures.get(code);
    if (!existing) return null;
    existing.classification = classification;
    return existing;
  }
}

window.RunChangeTracker = RunChangeTracker;
