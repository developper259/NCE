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
      reviewedDiffVersion: null,
      globalDiffTruncated: false,
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

  refreshChangeStats(change) {
    if (!change) return change;
    if (
      change.status === "renamed" &&
      typeof change.originalContent !== "string" &&
      typeof change.afterContent !== "string"
    ) {
      change.additions = 0;
      change.deletions = 0;
      return change;
    }
    if (change.created && typeof change.originalContent !== "string") {
      change.additions = this.countLines(change.afterContent || "");
      change.deletions = 0;
      return change;
    }
    const before = change.created
      ? typeof change.originalContent === "string"
        ? change.originalContent
        : ""
      : typeof change.originalContent === "string"
        ? change.originalContent
        : typeof change.beforeContent === "string"
          ? change.beforeContent
          : "";
    const after =
      typeof change.afterContent === "string" ? change.afterContent : "";
    const stats = this.getDiffStats(before, after);
    change.additions = stats.additions;
    change.deletions = stats.deletions;
    return change;
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
        originalContent: existing.created
          ? (existing.originalContent ?? null)
          : (change.originalContent ??
            existing.originalContent ??
            existing.beforeContent ??
            change.beforeContent ??
            null),
        beforeContent: existing.beforeContent ?? change.beforeContent ?? null,
        afterContent: Object.prototype.hasOwnProperty.call(
          change,
          "afterContent",
        )
          ? change.afterContent
          : (existing.afterContent ?? null),
        beforeRevision:
          existing.beforeRevision ?? change.beforeRevision ?? null,
        afterRevision: change.afterRevision ?? existing.afterRevision ?? null,
        created: change.created ?? existing.created ?? false,
        modified: change.modified ?? existing.modified ?? false,
        renamed: change.renamed ?? existing.renamed ?? false,
        deleted: change.deleted ?? existing.deleted ?? false,
        additions: existing.additions ?? 0,
        deletions: existing.deletions ?? 0,
        reviewed: false,
        review: null,
        version: (existing.version || 0) + 1,
        reviewedVersion: null,
      };
      this.refreshChangeStats(merged);
      this.current.changeVersion += 1;
      this.current.reviewedDiff = false;
      this.current.globalDiffTruncated = false;
      this.current.reviewedChangedFiles = false;
      this.current.changes.set(key, merged);
      if (
        !merged.created &&
        !merged.renamed &&
        !merged.deleted &&
        typeof merged.originalContent === "string" &&
        typeof merged.afterContent === "string" &&
        this.normalizeLineEndings(merged.originalContent) ===
          this.normalizeLineEndings(merged.afterContent)
      ) {
        this.current.changes.delete(key);
      }
      return merged;
    }
    const record = {
      path: change.path || key,
      originalPath: change.originalPath || change.oldPath || change.path || key,
      currentPath: change.currentPath || change.path || key,
      status: change.status || "modified",
      beforeContent: change.beforeContent ?? null,
      afterContent: change.afterContent ?? null,
      originalContent: change.originalContent ?? change.beforeContent ?? null,
      beforeRevision: change.beforeRevision ?? null,
      afterRevision: change.afterRevision ?? null,
      created: Boolean(change.created),
      modified: Boolean(change.modified),
      renamed: Boolean(change.renamed),
      deleted: Boolean(change.deleted),
      additions: 0,
      deletions: 0,
      reviewed: false,
      review: null,
      version: 1,
      reviewedVersion: null,
    };
    this.refreshChangeStats(record);
    this.current.changeVersion += 1;
    this.current.reviewedDiff = false;
    this.current.globalDiffTruncated = false;
    this.current.reviewedChangedFiles = false;
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
    const overwritten = result.overwritten === true;
    const before =
      overwritten && typeof result.beforeText === "string"
        ? result.beforeText
        : null;
    const stats = this.getDiffStats(before || "", content);
    const record = {
      path: relativePath,
      originalPath: relativePath,
      currentPath: relativePath,
      status: overwritten ? "modified" : "created",
      beforeContent: before,
      afterContent: content,
      beforeRevision: null,
      afterRevision: result.revision || result.verification?.revision || null,
      created: !overwritten,
      modified: overwritten,
      renamed: false,
      deleted: false,
      additions: overwritten ? stats.additions : this.countLines(content),
      deletions: overwritten ? stats.deletions : 0,
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
      status:
        existing?.status === "created"
          ? "created"
          : existing?.status === "renamed"
            ? "renamed"
            : "modified",
      beforeContent: before,
      afterContent: after,
      beforeRevision: result.previousRevision || null,
      afterRevision: result.revision || null,
      created: existing?.created === true,
      modified: true,
      renamed: false,
      deleted: false,
      additions: this.getDiffStats(before, after).additions,
      deletions: this.getDiffStats(before, after).deletions,
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
    if (existing?.created === true) {
      this.current.changes.delete(oldPath);
      existing.path = newPath;
      existing.currentPath = newPath;
      existing.renamed = true;
      existing.afterRevision =
        result.verification?.revision || existing.afterRevision;
      this.current.changeVersion += 1;
      existing.version = (existing.version || 0) + 1;
      existing.reviewed = false;
      existing.reviewedVersion = null;
      this.refreshChangeStats(existing);
      this.current.reviewedDiff = false;
      this.current.globalDiffTruncated = false;
      this.current.reviewedChangedFiles = false;
      this.current.changes.set(newPath, existing);
      return existing;
    }
    if (existing) {
      existing.status = existing.created ? "created" : "renamed";
      existing.renamed = true;
      existing.modified = Boolean(existing.modified);
      existing.originalPath = existing.originalPath || oldPath;
      existing.currentPath = newPath;
      existing.path = newPath;
      existing.oldPath = oldPath;
      existing.beforeContent =
        existing.beforeContent ?? result.beforeText ?? null;
      existing.afterContent =
        existing.afterContent ??
        result.afterText ??
        result.verification?.content ??
        null;
      existing.beforeRevision = existing.beforeRevision ?? null;
      existing.afterRevision = existing.afterRevision ?? null;
      this.current.changes.delete(oldPath);
      this.current.changes.set(newPath, existing);
      this.current.changeVersion += 1;
      existing.version = (existing.version || 0) + 1;
      existing.reviewed = false;
      existing.reviewedVersion = null;
      this.refreshChangeStats(existing);
      this.current.reviewedDiff = false;
      this.current.globalDiffTruncated = false;
      this.current.reviewedChangedFiles = false;
      return existing;
    }
    const generated = {
      path: newPath,
      oldPath,
      originalPath: oldPath,
      currentPath: newPath,
      status: "renamed",
      beforeContent: result.beforeText ?? null,
      afterContent: result.afterText ?? result.verification?.content ?? null,
      beforeRevision: null,
      afterRevision: result.verification?.revision || null,
      created: false,
      modified: false,
      renamed: true,
      deleted: false,
      additions: 0,
      deletions: 0,
      originalContent: result.beforeText ?? null,
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
      this.current.reviewedDiff = false;
      this.current.globalDiffTruncated = false;
      this.current.reviewedChangedFiles = false;
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
    return this.getDiffStats(beforeText, afterText).additions;
  }

  countDeletedLines(beforeText, afterText) {
    return this.getDiffStats(beforeText, afterText).deletions;
  }

  getDiffStats(beforeText, afterText) {
    const result = this.computeLineDiff(beforeText, afterText);
    return {
      additions: result.lines.filter((line) => line.startsWith("+")).length,
      deletions: result.lines.filter((line) => line.startsWith("-")).length,
      diffTooLarge: result.diffTooLarge,
    };
  }

  markReviewChangedFiles() {
    if (!this.current) return false;
    this.current.reviewedChangedFiles = true;
    return true;
  }

  getUnreviewedPaths() {
    if (!this.current) return [];
    return [...this.current.changes.values()]
      .filter((change) => change.reviewedVersion !== change.version)
      .map((change) => change.path);
  }

  getCompletionDiagnostics() {
    const changes = [...(this.current?.changes.values() || [])];
    const unreviewedFiles = this.getUnreviewedPaths();
    return {
      changeVersion: this.current?.changeVersion ?? 0,
      changedFiles: changes.map((change) => change.path),
      reviewedFiles: changes
        .filter((change) => change.reviewedVersion === change.version)
        .map((change) => change.path),
      unreviewedFiles,
      globalDiffReviewed:
        this.current?.reviewedDiff === true &&
        this.current?.reviewedDiffVersion === this.current?.changeVersion,
      globalDiffTruncated: this.current?.globalDiffTruncated === true,
      pendingToolCalls: [...(this.current?.pendingToolCalls || [])],
      unresolvedFailures: [...(this.current?.unresolvedFailures.values() || [])]
        .filter((failure) => failure.blocking !== false)
        .map((failure) => ({
          code: failure.code,
          toolName: failure.toolName,
          path: failure.path,
          status: failure.status,
        })),
    };
  }

  markReviewDiff(path = null, result = null) {
    if (!this.current) return false;
    if (result?.success === false) return false;
    if (result?.truncated === true || result?.diffTooLarge === true) {
      if (!path) this.current.globalDiffTruncated = true;
      return false;
    }
    if (path) {
      const change = this.current.changes.get(this.normalizePath(path));
      if (!change) return false;
      change.reviewed = true;
      change.reviewedVersion = change.version;
      return true;
    }
    for (const change of this.current.changes.values()) {
      change.reviewed = true;
      change.reviewedVersion = change.version;
    }
    this.current.reviewedDiff = true;
    this.current.reviewedDiffVersion = this.current.changeVersion;
    this.current.globalDiffTruncated = false;
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
    let diffTooLarge = false;
    for (const entry of changes) {
      const rendered = this.renderDiff(entry);
      diff.push(rendered.text);
      diffTooLarge ||= rendered.diffTooLarge === true;
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
      diffTooLarge,
    };
    if (text.length > maxChars || diffTooLarge) {
      patch.truncated = true;
      patch.hasMore = true;
      patch.diff = `${text.slice(0, maxChars)}\n... [truncated]`;
    }
    patch.reviewComplete = !patch.truncated && !patch.diffTooLarge;
    patch.unreviewedPaths = this.getUnreviewedPaths();
    if (!requestedPath && patch.truncated) {
      patch.reviewInstruction =
        "The global diff was truncated. Review the remaining changed files with get_diff({ path }) before task_complete.";
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
      return {
        text: [
          `--- /dev/null`,
          `+++ b/${newPath}`,
          `@@ -0,0 +1,${this.countLines(after)} @@`,
          ...after.split(/\r?\n/).map((line) => `+${line}`),
        ].join("\n"),
        diffTooLarge: false,
      };
    }
    if (change.status === "deleted") {
      return {
        text: [
          `--- a/${oldPath}`,
          `+++ /dev/null`,
          `@@ -1,${this.countLines(before)} +0,0 @@`,
          ...before.split(/\r?\n/).map((line) => `-${line}`),
        ].join("\n"),
        diffTooLarge: false,
      };
    }
    if (change.status === "renamed" && before === after) {
      return {
        text: [`--- a/${oldPath}`, `+++ b/${newPath}`].join("\n"),
        diffTooLarge: false,
      };
    }
    const result = this.computeLineDiff(before, after);
    return {
      text: [`--- a/${oldPath}`, `+++ b/${newPath}`, ...result.lines].join(
        "\n",
      ),
      diffTooLarge: result.diffTooLarge,
    };
  }

  unifiedDiffLines(before, after) {
    return this.computeLineDiff(before, after).lines;
  }

  computeLineDiff(before, after) {
    const beforeLines = String(before || "").split(/\r?\n/);
    const afterLines = String(after || "").split(/\r?\n/);
    let prefix = 0;
    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    )
      prefix += 1;
    let suffix = 0;
    while (
      suffix < beforeLines.length - prefix &&
      suffix < afterLines.length - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] ===
        afterLines[afterLines.length - 1 - suffix]
    )
      suffix += 1;
    const oldMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
    const newMiddle = afterLines.slice(prefix, afterLines.length - suffix);
    const cells = oldMiddle.length * newMiddle.length;
    if (cells > 1_000_000) {
      return {
        lines: [
          `@@ -${prefix + 1},${oldMiddle.length} +${prefix + 1},${newMiddle.length} @@`,
          "... [diff too large]",
        ],
        diffTooLarge: true,
      };
    }
    const table = Array.from(
      { length: oldMiddle.length + 1 },
      () => new Uint32Array(newMiddle.length + 1),
    );
    for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
        table[i][j] =
          oldMiddle[i] === newMiddle[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const lines = [];
    let i = 0;
    let j = 0;
    while (i < oldMiddle.length || j < newMiddle.length) {
      if (
        i < oldMiddle.length &&
        j < newMiddle.length &&
        oldMiddle[i] === newMiddle[j]
      ) {
        i += 1;
        j += 1;
      } else if (
        j < newMiddle.length &&
        (i === oldMiddle.length || table[i][j + 1] >= table[i + 1][j])
      ) {
        lines.push(`+${newMiddle[j++]}`);
      } else {
        lines.push(`-${oldMiddle[i++]}`);
      }
    }
    return {
      lines: lines.length
        ? [
            `@@ -${prefix + 1},${oldMiddle.length} +${prefix + 1},${newMiddle.length} @@`,
            ...lines,
          ]
        : [`@@ -1,0 +1,0 @@`],
      diffTooLarge: false,
    };
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
      const unreviewedPaths = this.getUnreviewedPaths();
      if (unreviewedPaths.length) {
        return {
          success: false,
          error: {
            code: "CHANGES_NOT_REVIEWED",
            message: this.current.globalDiffTruncated
              ? "The global diff was truncated. Review the remaining changed files with get_diff({ path }) before task_complete."
              : "Review the remaining changed files with get_diff({ path }) before task_complete.",
            unreviewedPaths,
            globalDiffTruncated: this.current.globalDiffTruncated,
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
        classification:
          failure.classification || error.retryStrategy || "unresolved",
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
        (!normalizedPath ||
          !failure.path ||
          AgentPath.samePath(failure.path, normalizedPath))
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

  markFailuresRecoveryReady(path, codes = null) {
    if (!this.current) return 0;
    const normalizedPath = this.normalizePath(path || "");
    const allowed = Array.isArray(codes) ? new Set(codes) : null;
    let count = 0;
    for (const failure of this.current.unresolvedFailures.values()) {
      if (
        failure.path &&
        AgentPath.samePath(failure.path, normalizedPath) &&
        (!allowed || allowed.has(failure.code))
      ) {
        failure.status = "recovery_ready";
        failure.classification = "reread_completed";
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
