class RunChangeTracker {
  constructor(agent) {
    this.agent = agent;
    this.current = null;
  }

  beginRun(runId, workspaceIdentity = null) {
    const root =
      this.agent?.editor?.fileExplorer?.rootPath || workspaceIdentity || null;
    const identity =
      typeof root === "string" && root.trim()
        ? AgentPath.normalize(root.trim())
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

  setRunStatus(status) {
    if (!this.current) return null;
    if (status === "completed") this.current.status = "completed";
    if (status === "aborted") this.current.status = "aborted";
    if (status === "failed") this.current.status = "failed";
    if (status === "running") this.current.status = "running";
    return this.current;
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
      AgentPath.normalize(this.current.workspaceIdentity) ===
        AgentPath.normalize(identity)
    );
  }

  normalizePath(path) {
    if (typeof path !== "string" || !path.trim()) return "";
    const relative = path.trim().replace(/\\/g, "/");
    return relative.startsWith("/")
      ? AgentPath.toProjectRelativePath(
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
          change.originalPath ||
          existing.originalPath ||
          existing.oldPath ||
          existing.path ||
          key,
        originalContent:
          change.originalContent ??
          existing.originalContent ??
          existing.beforeContent ??
          null,
        beforeContent: change.beforeContent ?? existing.beforeContent ?? null,
        afterContent: change.afterContent ?? existing.afterContent ?? null,
        beforeRevision:
          change.beforeRevision ?? existing.beforeRevision ?? null,
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
    const change = {
      path: relativePath,
      originalPath: relativePath,
      currentPath: relativePath,
      status: "modified",
      beforeContent: before,
      afterContent: after,
      beforeRevision: result.previousRevision || null,
      afterRevision: result.revision || null,
      created: false,
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
      return null;
    }
    const deletion = {
      path: relativePath,
      originalPath: relativePath,
      currentPath: relativePath,
      status: "deleted",
      beforeContent,
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
    return typeof content === "string"
      ? Math.max(0, content.split(/\r?\n/).length - 1)
      : 0;
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
    return true;
  }

  markReviewDiff() {
    if (!this.current) return false;
    this.current.reviewedDiff = true;
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
    const patch = {
      success: true,
      runId: this.current.runId,
      truncated: false,
      path: requestedPath || null,
      diff: text,
    };
    if (text.length > 12000) {
      patch.truncated = true;
      patch.diff = `${text.slice(0, 12000)}\n... [truncated]`;
    }
    return patch;
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
    const max = Math.max(beforeLines.length, afterLines.length);
    const lines = [];
    for (let i = 0; i < max; i++) {
      if (beforeLines[i] === afterLines[i]) continue;
      if (i < beforeLines.length && i < afterLines.length) {
        lines.push(`-${beforeLines[i]}`);
        lines.push(`+${afterLines[i]}`);
      } else if (i < beforeLines.length) {
        lines.push(`-${beforeLines[i]}`);
      } else if (i < afterLines.length) {
        lines.push(`+${afterLines[i]}`);
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
      this.current.unresolvedFailures.size
    ) {
      return {
        success: false,
        error: {
          code: "UNRESOLVED_FAILURES",
          message: "Une erreur importante du run reste non résolue.",
        },
      };
    }
    if (
      this.hasEffectiveChanges() &&
      !this.current.reviewedChangedFiles &&
      !this.current.reviewedDiff
    ) {
      return {
        success: false,
        error: {
          code: "CHANGES_NOT_REVIEWED",
          message: "Revoyez get_changed_files ou get_diff avant task_complete.",
        },
      };
    }
    this.current.status = "completed";
    this.current.reviewedChangedFiles = true;
    this.current.reviewedDiff = true;
    return {
      success: true,
      taskCompleteRequested: true,
      validation: "accepted",
      changedFiles: this.current.changes.size,
    };
  }

  markPending(toolCallId) {
    if (!this.current) return;
    if (typeof toolCallId === "string" && toolCallId.trim()) {
      this.current.pendingToolCalls.add(toolCallId);
    }
  }

  clearPending(toolCallId) {
    if (!this.current) return;
    if (typeof toolCallId === "string" && toolCallId.trim()) {
      this.current.pendingToolCalls.delete(toolCallId);
    }
  }

  addUnresolvedFailure(code, message) {
    if (!this.current) return;
    this.current.unresolvedFailures.set(code, { code, message });
  }

  resolveFailure(code) {
    if (!this.current) return;
    if (typeof code === "string") this.current.unresolvedFailures.delete(code);
  }
}

window.RunChangeTracker = RunChangeTracker;
