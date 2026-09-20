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
      failureHistory: [],
      validationRecords: [],
      reviewedChangedFiles: false,
      reviewedDiff: false,
      reviewedDiffVersion: null,
      globalDiffTruncated: false,
      reviewSessions: new Map(),
      reviewCursorSequence: 0,
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

  isInternalPath(path) {
    const normalized = this.normalizePath(path || "");
    return normalized === ".nce" || normalized.startsWith(".nce/");
  }

  changeKeyForPath(path) {
    const normalized = this.normalizePath(path);
    return normalized || path;
  }

  invalidateValidationsForPath(path) {
    const normalizedPath = this.normalizePath(path || "");
    if (!normalizedPath || !this.current) return;
    for (const validation of this.current.validationRecords) {
      if (validation.status !== "PASSED" || validation.fresh === false)
        continue;
      const scope = validation.scope || {};
      const target = this.normalizePath(
        scope.target || validation.target || "",
      );
      const projectRoot =
        this.normalizePath(
          scope.projectRoot || validation.projectRoot || ".",
        ) || ".";
      const covered =
        scope.mode === "target"
          ? Boolean(target) &&
            (normalizedPath === target ||
              AgentPath.isInside(normalizedPath, target))
          : projectRoot === "." ||
            normalizedPath === projectRoot ||
            AgentPath.isInside(normalizedPath, projectRoot);
      if (covered) validation.fresh = false;
    }
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
    if (
      this.isInternalPath(
        change?.path || change?.oldPath || change?.currentPath,
      )
    )
      return null;
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
      this.invalidateValidationsForPath(key);
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
    this.invalidateValidationsForPath(key);
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
    if (this.isInternalPath(relativePath)) return null;
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
    if (this.isInternalPath(relativePath)) return null;
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
    if (this.isInternalPath(oldPath) || this.isInternalPath(newPath))
      return null;
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
    if (this.isInternalPath(relativePath)) return null;
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

  validationCoversPath(validation, path) {
    if (!validation || validation.status !== "PASSED") return false;
    const normalizedPath = this.normalizePath(path);
    const scope = validation.scope || {};
    const target = this.normalizePath(scope.target || validation.target || "");
    if (scope.mode === "target") {
      return Boolean(
        target &&
        (normalizedPath === target ||
          AgentPath.isInside(normalizedPath, target)),
      );
    }
    const projectRoot =
      this.normalizePath(scope.projectRoot || validation.projectRoot || ".") ||
      ".";
    return (
      projectRoot === "." ||
      normalizedPath === projectRoot ||
      AgentPath.isInside(normalizedPath, projectRoot)
    );
  }

  getValidationState(changes = [...(this.current?.changes.values() || [])]) {
    const validations = this.current?.validationRecords || [];
    const freshPassed = validations.filter(
      (validation) =>
        validation.status === "PASSED" && validation.fresh !== false,
    );
    const stalePassed = validations.filter(
      (validation) =>
        validation.status === "PASSED" && validation.fresh === false,
    );
    const allCovered =
      changes.length > 0 &&
      changes.every((change) =>
        freshPassed.some((validation) =>
          this.validationCoversPath(validation, change.path),
        ),
      );
    const staleRelevant = stalePassed.filter((validation) =>
      changes.some((change) =>
        this.validationCoversPath(validation, change.path),
      ),
    );
    return {
      freshPassed,
      stalePassed,
      staleRelevant,
      allCovered,
      statuses: validations.map((validation) => ({
        id: validation.id,
        status: validation.status,
        target: validation.target,
        projectRoot: validation.projectRoot,
        fresh: validation.fresh !== false,
        changeVersion: validation.changeVersion,
      })),
    };
  }

  evaluateCompletionReviewRequirement() {
    const changes = [...(this.current?.changes.values() || [])];
    const changedFiles = changes.map((change) => change.path);
    if (!changes.length) {
      return {
        required: false,
        reasons: [],
        changedFiles,
        riskLevel: "safe",
        nextAction: { tool: "task_complete", arguments: {} },
      };
    }

    const reasons = [];
    const hasDeletion = changes.some((change) => change.deleted);
    const hasRename = changes.some((change) => change.renamed);
    const externalChangesDetected = this.detectAnyUserChangeAfterAgent();
    const validation = this.getValidationState(changes);
    if (hasDeletion) reasons.push("FILE_DELETED");
    if (hasRename) reasons.push("FILE_RENAMED");
    if (externalChangesDetected) reasons.push("EXTERNAL_CHANGE_DETECTED");
    if (!validation.allCovered) reasons.push("VALIDATION_REQUIRED");

    const required = reasons.length > 0;
    const nextPath = changedFiles[0] || null;
    return {
      required,
      reasons,
      changedFiles,
      riskLevel: required ? "review_required" : "safe",
      externalChangesDetected,
      validationFresh: validation.allCovered,
      nextAction: required
        ? {
            tool: "get_diff",
            arguments: nextPath ? { path: nextPath } : {},
          }
        : { tool: "task_complete", arguments: {} },
    };
  }

  getCompletionState() {
    const policy = this.evaluateCompletionReviewRequirement();
    const diagnostics = {
      policy,
      validation: this.getValidationState(),
    };
    if (!this.current) return { status: "SAFE", ...diagnostics };
    if (["aborted", "failed"].includes(this.current.status)) {
      return {
        status: "BLOCKED",
        reason: `RUN_${this.current.status.toUpperCase()}`,
        ...diagnostics,
      };
    }
    if (
      this.current.invalidated ||
      !this.workspaceMatches(this.agent.editor?.fileExplorer?.rootPath)
    ) {
      return { status: "BLOCKED", reason: "WORKSPACE_CHANGED", ...diagnostics };
    }
    if (this.current.pendingToolCalls?.size) {
      return { status: "BLOCKED", reason: "RUN_NOT_SETTLED", ...diagnostics };
    }
    if (this.getBlockingFailures().length) {
      return {
        status: "BLOCKED",
        reason: "UNRESOLVED_FAILURES",
        ...diagnostics,
      };
    }
    if (
      diagnostics.validation.staleRelevant.length &&
      !diagnostics.validation.allCovered
    ) {
      return { status: "BLOCKED", reason: "VALIDATION_STALE", ...diagnostics };
    }
    const reviewPending =
      policy.required && this.getUnreviewedPaths().length > 0;
    return {
      status: reviewPending ? "REVIEW_REQUIRED" : "SAFE",
      ...diagnostics,
    };
  }

  getCompletionDiagnostics() {
    const changes = [...(this.current?.changes.values() || [])];
    const unreviewedFiles = this.getUnreviewedPaths();
    const staleValidations = (this.current?.validationRecords || [])
      .filter(
        (validation) =>
          validation.status === "PASSED" && validation.fresh === false,
      )
      .map((validation) => ({
        id: validation.id,
        target: validation.target,
        projectRoot: validation.projectRoot,
        validationKind: validation.validationKind,
        changeVersion: validation.changeVersion,
      }));
    const completion = this.getCompletionState();
    return {
      changeVersion: this.current?.changeVersion ?? 0,
      changedFiles: changes.map((change) => change.path),
      reviewedFiles: changes
        .filter((change) => change.reviewedVersion === change.version)
        .map((change) => change.path),
      unreviewedFiles,
      reviewRequired: completion.policy.required,
      reviewReasons: completion.policy.reasons,
      completionState: completion.status,
      nextAction: completion.policy.nextAction,
      externalChangesDetected:
        completion.policy.externalChangesDetected === true,
      validationRecords: completion.validation.statuses,
      globalDiffReviewed:
        this.current?.reviewedDiff === true &&
        this.current?.reviewedDiffVersion === this.current?.changeVersion,
      globalDiffTruncated: this.current?.globalDiffTruncated === true,
      activeReviewSessions: [...(this.current?.reviewSessions?.entries() || [])]
        .filter(([, session]) => session.active === true)
        .map(([cursor, session]) => ({
          cursor,
          path: session.path,
          version: session.version,
          page: session.page,
          position: session.position,
          hasMore: true,
        })),
      pendingToolCalls: [...(this.current?.pendingToolCalls || [])],
      staleValidations,
      unresolvedFailures: [...(this.current?.unresolvedFailures.values() || [])]
        .filter(
          (failure) =>
            failure.blocking !== false &&
            ["unresolved", "recovery_ready"].includes(failure.status),
        )
        .map((failure) => ({
          code: failure.code,
          toolName: failure.toolName,
          path: failure.path,
          target: failure.target,
          projectRoot: failure.projectRoot,
          status: failure.status,
        })),
      supersededFailures: (this.current?.failureHistory || [])
        .filter((failure) =>
          ["resolved", "superseded"].includes(failure.status),
        )
        .map((failure) => ({
          code: failure.code,
          toolName: failure.toolName,
          path: failure.path,
          status: failure.status,
          resolvedBy: failure.resolvedBy || null,
        })),
    };
  }

  markReviewDiff(path = null, result = null) {
    if (!this.current) return false;
    if (result?.success === false) return false;
    if (result?.hasMore === true || result?.truncated === true) {
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
    const files = [...this.current.changes.values()]
      .filter((change) => !this.isInternalPath(change.path))
      .map((change) => ({
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

  createReviewCursor(path, version, position, page) {
    if (!this.current) return null;
    this.current.reviewCursorSequence += 1;
    const randomPart =
      globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const cursor = `nce-diff-${this.current.runId}-${this.current.reviewCursorSequence}-${randomPart}`;
    this.current.reviewSessions.set(cursor, {
      path,
      version,
      position,
      page,
      active: true,
    });
    return cursor;
  }

  getDiffPage(text, position, maxChars) {
    const start = Math.max(0, Math.min(position, text.length));
    if (start >= text.length) {
      return { diff: "", position: start, hasMore: false };
    }
    let cursor = start;
    let diff = "";
    while (cursor < text.length) {
      const newline = text.indexOf("\n", cursor);
      const lineEnd = newline === -1 ? text.length : newline + 1;
      const lineLength = lineEnd - cursor;
      if (diff && diff.length + lineLength > maxChars) break;
      if (!diff && lineLength > maxChars) {
        cursor += maxChars;
        diff = text.slice(start, cursor);
        break;
      }
      diff += text.slice(cursor, lineEnd);
      cursor = lineEnd;
      if (diff.length >= maxChars) break;
    }
    return { diff, position: cursor, hasMore: cursor < text.length };
  }

  buildReviewError(code, message, details = {}) {
    return { success: false, error: { code, message, ...details } };
  }

  getDiff(args = {}) {
    if (!this.current)
      return {
        success: false,
        error: { code: "NO_ACTIVE_RUN", message: "Aucun run Agent actif." },
      };
    const requestedPath =
      typeof args?.path === "string" ? this.normalizePath(args.path) : null;
    const cursor = typeof args?.cursor === "string" ? args.cursor : null;
    const cursorSession = cursor
      ? this.current.reviewSessions.get(cursor)
      : null;
    if (cursor && !cursorSession) {
      return this.buildReviewError(
        "INVALID_DIFF_CURSOR",
        "Le cursor de diff est inconnu ou a déjà été consommé.",
      );
    }
    if (cursorSession && !cursorSession.active) {
      return this.buildReviewError(
        "INVALID_DIFF_CURSOR",
        "Le cursor de diff a déjà été consommé.",
      );
    }
    if (
      cursorSession &&
      requestedPath &&
      requestedPath !== cursorSession.path
    ) {
      return this.buildReviewError(
        "INVALID_DIFF_CURSOR",
        "Le cursor ne correspond pas au chemin demandé.",
      );
    }
    const effectivePath = requestedPath || cursorSession?.path || null;
    const wanted = effectivePath
      ? this.current.changes.get(effectivePath)
      : null;
    if (
      cursorSession &&
      (!wanted || wanted.version !== cursorSession.version)
    ) {
      return this.buildReviewError(
        "STALE_DIFF_CURSOR",
        "Le fichier a changé depuis la création de ce cursor. Recommence la review depuis le début.",
        { path: cursorSession.path },
      );
    }
    if (effectivePath && !wanted) {
      return {
        success: false,
        error: {
          code: "PATH_NOT_CHANGED",
          message: "Le chemin demandé n appartient pas à ce run.",
        },
      };
    }
    const changes = effectivePath
      ? [wanted]
      : [...this.current.changes.values()].filter(
          (change) => !this.isInternalPath(change.path),
        );
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
      nextCursor: null,
      path: effectivePath,
      diff: text,
      diffTooLarge,
    };
    if (effectivePath) {
      const page = this.getDiffPage(
        text,
        cursorSession?.position || 0,
        maxChars,
      );
      patch.diff = page.diff;
      patch.truncated = page.hasMore;
      patch.hasMore = page.hasMore;
      patch.reviewProgress = {
        path: effectivePath,
        page: (cursorSession?.page || 0) + 1,
        complete: !page.hasMore,
      };
      if (cursorSession) this.current.reviewSessions.delete(cursor);
      if (page.hasMore) {
        patch.nextCursor = this.createReviewCursor(
          effectivePath,
          wanted.version,
          page.position,
          patch.reviewProgress.page,
        );
      }
    } else if (text.length > maxChars || diffTooLarge) {
      patch.truncated = true;
      patch.hasMore = true;
      patch.diff = text.slice(0, maxChars);
    }
    patch.reviewComplete = !patch.truncated && !patch.diffTooLarge;
    patch.unreviewedPaths = this.getUnreviewedPaths();
    if (!effectivePath && patch.truncated) {
      patch.reviewInstruction =
        "The global diff was truncated. Review the remaining changed files with get_diff({ path }) before task_complete.";
      const nextPath = patch.unreviewedPaths[0] || null;
      patch.nextReview = nextPath
        ? { tool: "get_diff", arguments: { path: nextPath } }
        : null;
    }

    console.info("[NCE Agent diff review]", {
      path: effectivePath,
      fileVersion: wanted?.version || null,
      page: patch.reviewProgress?.page || 1,
      returnedChars: patch.diff.length,
      hasMore: patch.hasMore,
      reviewComplete: patch.reviewComplete,
      nextCursor: Boolean(patch.nextCursor),
    });

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
          ...oldMiddle.map((line) => `-${line}`),
          ...newMiddle.map((line) => `+${line}`),
        ],
        diffTooLarge: false,
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

  getNextReviewAction(unreviewedPaths = this.getUnreviewedPaths()) {
    const path = unreviewedPaths[0] || null;
    if (!path) return null;
    const change = this.current?.changes.get(path);
    for (const [cursor, session] of this.current?.reviewSessions || []) {
      if (
        session.active === true &&
        session.path === path &&
        session.version === change?.version
      ) {
        return { tool: "get_diff", arguments: { path, cursor } };
      }
    }
    return { tool: "get_diff", arguments: { path } };
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
        (failure) =>
          failure.blocking !== false &&
          ["unresolved", "recovery_ready"].includes(failure.status),
      )
    ) {
      const diagnostics = this.getCompletionDiagnostics();
      return {
        success: false,
        error: {
          code: "UNRESOLVED_FAILURES",
          message: "Une erreur importante du run reste non résolue.",
          unresolvedFailures: diagnostics.unresolvedFailures,
          supersededFailures: diagnostics.supersededFailures,
          nextActions: diagnostics.unresolvedFailures.map((failure) =>
            failure.toolName === "run_tests"
              ? `Fix and retest ${failure.target || failure.path || "the relevant validation scope"}.`
              : `Resolve ${failure.toolName || "the failed tool"} (${failure.code}).`,
          ),
        },
      };
    }
    const policy = this.evaluateCompletionReviewRequirement();
    const validation = this.getValidationState();
    if (validation.staleRelevant.length && !validation.allCovered) {
      const diagnostics = this.getCompletionDiagnostics();
      return {
        success: false,
        error: {
          code: "VALIDATION_STALE",
          message:
            "Une validation PASSED est devenue obsolète après une mutation.",
          completionState: "BLOCKED",
          staleValidations: diagnostics.staleValidations,
          nextAction: {
            tool: "run_tests",
            arguments: {},
          },
        },
      };
    }
    if (this.hasEffectiveChanges() && policy.required) {
      const unreviewedPaths = this.getUnreviewedPaths();
      if (unreviewedPaths.length) {
        const nextAction = this.getNextReviewAction(unreviewedPaths);
        return {
          success: false,
          error: {
            code: "CHANGES_NOT_REVIEWED",
            completionState: "REVIEW_REQUIRED",
            reviewRequired: true,
            reviewReasons: policy.reasons,
            message: nextAction?.arguments?.cursor
              ? "Continue the current diff review with get_diff using the returned cursor before task_complete."
              : "Review the remaining changed files with get_diff({ path }) before task_complete.",
            unreviewedPaths,
            globalDiffTruncated: this.current.globalDiffTruncated,
            nextAction,
            nextReview: nextAction,
            retryTaskComplete: false,
          },
        };
      }
    }
    return {
      success: true,
      taskCompleteRequested: true,
      validation: "eligible",
      changedFiles: this.current.changes.size,
      completionState: "SAFE",
      reviewRequired: policy.required,
      reviewReasons: policy.reasons,
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
      const record = {
        identity,
        code,
        toolCallId: failure.toolCallId || previous?.toolCallId || null,
        toolName: failure.toolName || previous?.toolName || null,
        path: path || null,
        target: this.normalizePath(failure.target || path) || null,
        projectRoot: this.normalizePath(failure.projectRoot || ".") || ".",
        scope: failure.scope || null,
        category:
          failure.category ||
          (failure.toolName === "run_tests" ? "validation" : "tool"),
        recoverable: failure.recoverable !== false,
        message: error.message || previous?.message || "Tool failure",
        classification:
          failure.classification || error.retryStrategy || "unresolved",
        blocking: failure.blocking !== false,
        firstSeen: previous?.firstSeen || Date.now(),
        lastSeen: Date.now(),
        recoveryAction: failure.recoveryAction || null,
        status:
          previous?.status === "recovery_ready"
            ? "recovery_ready"
            : "unresolved",
        createdAtIteration:
          failure.iteration ?? previous?.createdAtIteration ?? null,
        createdAtChangeVersion:
          failure.changeVersion ??
          previous?.createdAtChangeVersion ??
          this.current.changeVersion,
        runId: this.current.runId,
        workspaceIdentity: this.current.workspaceIdentity,
        resolvedBy: null,
      };
      this.current.unresolvedFailures.set(identity, record);
      if (!previous) this.current.failureHistory.push(record);
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
        failure.resolvedBy = {
          toolName,
          changeVersion: this.current.changeVersion,
        };
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
        failure.resolvedBy = {
          toolName: "path-recovery",
          changeVersion: this.current.changeVersion,
        };
        this.current.unresolvedFailures.delete(identity);
        count += 1;
      }
    }
    return count;
  }

  resolveWriteFailuresForPath(path, classification = "recovered") {
    if (!this.current) return 0;
    const normalizedPath = this.normalizePath(path || "");
    if (!normalizedPath) return 0;
    let count = 0;
    for (const [identity, failure] of this.current.unresolvedFailures) {
      if (
        failure.category !== "validation" &&
        failure.path &&
        AgentPath.samePath(failure.path, normalizedPath)
      ) {
        failure.status = "resolved";
        failure.classification = classification;
        failure.resolvedBy = {
          toolName: "successful-write",
          changeVersion: this.current.changeVersion,
        };
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
        failure.resolvedBy = {
          toolName: "direct",
          changeVersion: this.current.changeVersion,
        };
        this.current.unresolvedFailures.delete(code);
      }
    }
  }

  canValidationSupersedeFailure(validation, failure) {
    if (!validation || !failure || failure.category !== "validation")
      return false;
    if (
      failure.runId !== this.current?.runId ||
      failure.workspaceIdentity !== this.current?.workspaceIdentity
    )
      return false;
    if (
      !["INVALID_TARGET", "MULTIPLE_PROJECTS", "FAILED", "TIMEOUT"].includes(
        failure.code,
      )
    )
      return false;
    const validationRoot =
      this.normalizePath(validation.projectRoot || ".") || ".";
    const failureRoot = this.normalizePath(failure.projectRoot || ".") || ".";
    if (validationRoot !== failureRoot) return false;
    if (
      failure.code === "INVALID_TARGET" ||
      failure.code === "MULTIPLE_PROJECTS"
    )
      return true;
    const validationTarget = this.normalizePath(validation.target || "");
    const failureTarget = this.normalizePath(
      failure.target || failure.path || "",
    );
    return (
      !failureTarget ||
      !validationTarget ||
      AgentPath.samePath(failureTarget, validationTarget)
    );
  }

  recordValidation(validation = {}) {
    if (
      !this.current ||
      (validation.runId !== undefined &&
        validation.runId !== this.current.runId)
    )
      return null;
    const record = {
      id:
        validation.toolCallId ||
        `${this.current.runId}:run_tests:${this.current.validationRecords.length + 1}`,
      tool: "run_tests",
      status: validation.status || "UNKNOWN",
      validationKind: validation.validationKind || "test",
      projectRoot: this.normalizePath(validation.projectRoot || ".") || ".",
      target: this.normalizePath(validation.target || "") || null,
      scope: validation.scope || null,
      changeVersion: this.current.changeVersion,
      iteration: validation.iteration ?? null,
      runId: this.current.runId,
      workspaceIdentity: this.current.workspaceIdentity,
      signature: validation.signature || null,
      fresh: true,
    };
    this.current.validationRecords.push(record);
    let resolvedFailureCount = 0;
    let supersededFailureCount = 0;
    if (
      [
        "PASSED",
        "FAILED",
        "TIMEOUT",
        "INVALID_TARGET",
        "MULTIPLE_PROJECTS",
      ].includes(record.status)
    ) {
      for (const failure of this.current.unresolvedFailures.values()) {
        if (
          record.status === "PASSED" &&
          this.canValidationSupersedeFailure(record, failure)
        ) {
          const superseded =
            failure.code === "INVALID_TARGET" ||
            failure.code === "MULTIPLE_PROJECTS";
          failure.status = superseded ? "superseded" : "resolved";
          failure.resolvedBy = {
            tool: "run_tests",
            status: record.status,
            changeVersion: record.changeVersion,
            iteration: record.iteration,
          };
          this.current.unresolvedFailures.delete(failure.identity);
          if (superseded) supersededFailureCount += 1;
          else resolvedFailureCount += 1;
        }
      }
    }
    if (
      ["INVALID_TARGET", "MULTIPLE_PROJECTS", "FAILED", "TIMEOUT"].includes(
        record.status,
      )
    ) {
      this.addUnresolvedFailure({
        toolName: "run_tests",
        target: record.target,
        path: record.target,
        projectRoot: record.projectRoot,
        scope: record.scope,
        category: "validation",
        recoverable: true,
        iteration: record.iteration,
        changeVersion: record.changeVersion,
        error: {
          code: record.status,
          message: validation.reason || record.status,
        },
      });
    }
    record.resolution = { resolvedFailureCount, supersededFailureCount };
    return record;
  }

  getBlockingFailures(category = null) {
    if (!this.current) return [];
    return [...this.current.unresolvedFailures.values()].filter(
      (failure) =>
        failure.blocking !== false &&
        ["unresolved", "recovery_ready"].includes(failure.status) &&
        (!category || failure.category === category),
    );
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
