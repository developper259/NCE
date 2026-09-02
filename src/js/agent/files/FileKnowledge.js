class FileKnowledge {
  constructor(agent) {
    this.agent = agent;
    this.maxContextFiles = 12;
    this.reset();
  }

  reset() {
    this.files = new Map();
    this.projectStructureRevision = 0;
    this.workspaceContentRevision = 0;
    this.projectMapCache = new Map();
    this.projectListCache = new Map();
    this.projectSearchCache = new Map();
    this.modelVisibleFiles = new Map();
    this.currentIteration = 0;
    this.consecutiveNoNewInformationToolCalls = 0;
    this.metrics = {
      readFileCalls: 0,
      actualFileReads: 0,
      actualDiskReads: 0,
      cachedFileReads: 0,
      duplicateReadAttempts: 0,
      newRangeReads: 0,
      revisionRereads: 0,
      actualFilesystemReads: 0,
      alreadyVisibleReads: 0,
      restoredReads: 0,
      restoredCharacters: 0,
      cacheHits: 0,
      cacheMisses: 0,
      projectMapCalls: 0,
      actualProjectMapBuilds: 0,
      cachedProjectMaps: 0,
      listProjectFilesCalls: 0,
      actualProjectListings: 0,
      cachedProjectListings: 0,
      searchProjectFilesCalls: 0,
      actualProjectSearches: 0,
      cachedProjectSearches: 0,
      noNewInformationToolCalls: 0,
      runtimeInterventions: 0,
    };
  }

  setIteration(iteration) {
    if (Number.isInteger(iteration) && iteration > 0) {
      this.currentIteration = iteration;
    }
  }

  normalizePath(path) {
    return typeof path === "string" ? AgentPath.normalize(path) : "";
  }

  normalizeRange(startLine, endLine) {
    const start = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
    const end =
      Number.isInteger(endLine) && endLine >= start ? endLine : start + 199;
    return { startLine: start, endLine: end };
  }

  mergeRanges(ranges = []) {
    const sorted = ranges
      .filter(
        (range) =>
          Number.isInteger(range?.startLine) &&
          Number.isInteger(range?.endLine) &&
          range.startLine > 0 &&
          range.endLine >= range.startLine,
      )
      .map((range) => ({
        startLine: range.startLine,
        endLine: range.endLine,
      }))
      .sort(
        (left, right) =>
          left.startLine - right.startLine || left.endLine - right.endLine,
      );
    const merged = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (!previous || range.startLine > previous.endLine + 1) {
        merged.push({ ...range });
      } else {
        previous.endLine = Math.max(previous.endLine, range.endLine);
      }
    }
    return merged;
  }

  isRangeCovered(entry, range) {
    if (!entry || entry.invalidated) return false;
    if (entry.fullRead) return true;
    return entry.ranges.some(
      (known) =>
        known.startLine <= range.startLine && known.endLine >= range.endLine,
    );
  }

  getEffectiveRange(entry, range) {
    const effectiveRange = {
      startLine: range.startLine,
      endLine: Number.isInteger(entry?.totalLines)
        ? Math.min(range.endLine, entry.totalLines)
        : range.endLine,
    };
    return effectiveRange.endLine >= effectiveRange.startLine
      ? effectiveRange
      : null;
  }

  getCachedRange(entry, range) {
    if (!(entry?.contentLines instanceof Map)) return null;
    const effectiveRange = this.getEffectiveRange(entry, range);
    if (!effectiveRange) return null;
    const lines = [];
    for (
      let lineNumber = effectiveRange.startLine;
      lineNumber <= effectiveRange.endLine;
      lineNumber += 1
    ) {
      if (!entry.contentLines.has(lineNumber)) return null;
      lines.push(entry.contentLines.get(lineNumber));
    }
    return {
      ...effectiveRange,
      content: lines.join("\n"),
    };
  }

  updateModelVisibility(ranges = []) {
    const visible = new Map();
    for (const item of ranges) {
      const normalizedPath = this.resolveVisiblePath(item?.path);
      if (!normalizedPath || typeof item?.revision !== "string") continue;
      const range = this.normalizeRange(item.startLine, item.endLine);
      const current = visible.get(normalizedPath);
      if (current && current.revision === item.revision) {
        current.ranges = this.mergeRanges([...current.ranges, range]);
      } else {
        visible.set(normalizedPath, {
          revision: item.revision,
          ranges: [range],
        });
      }
    }
    this.modelVisibleFiles = visible;
  }

  resolveVisiblePath(path) {
    if (typeof path !== "string" || !path.trim()) return "";
    if (AgentPath.isAbsolute(path)) return this.normalizePath(path);
    const root = this.agent.editor?.fileExplorer?.rootPath;
    return this.normalizePath(
      this.agent.resolveWorkspacePath(path, root) || "",
    );
  }

  isModelRangeVisible(path, revision, range) {
    const visible = this.modelVisibleFiles.get(this.normalizePath(path));
    if (!visible || visible.revision !== revision) return false;
    return visible.ranges.some(
      (known) =>
        known.startLine <= range.startLine && known.endLine >= range.endLine,
    );
  }

  formatCoverage(entry) {
    if (!entry) return "none";
    if (entry.fullRead) return "full";
    return entry.ranges
      .map((range) => `${range.startLine}-${range.endLine}`)
      .join(",");
  }

  logReadDecision(path, range, entry, decision, details = {}, event = "check") {
    console.info("[NCE Agent read knowledge]", {
      event,
      path: this.toRelativePath(path),
      revision: details.requestedRevision || entry?.revision || null,
      requestedRevision: details.requestedRevision || entry?.revision || null,
      knownRevision: entry?.revision || null,
      requestedRange: `${range.startLine}-${range.endLine}`,
      ...(event === "restore"
        ? { restoredRange: `${range.startLine}-${range.endLine}` }
        : {}),
      knownCoverage: this.formatCoverage(entry),
      decision,
    });
  }

  toRelativePath(path) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    return this.agent.toProjectRelativePath(path, root) || path;
  }

  checkRead(path, startLine, endLine, options = {}) {
    const normalizedPath = this.normalizePath(path);
    const range = this.normalizeRange(startLine, endLine);
    const entry = this.files.get(normalizedPath);
    this.metrics.readFileCalls += 1;

    if (options.forceRead === true) {
      this.metrics.cacheMisses += 1;
      this.logReadDecision(normalizedPath, range, entry, "invalidated");
      return { alreadyKnown: false, decision: "invalidated", range, entry };
    }

    const currentRevision =
      typeof options.currentRevision === "string"
        ? options.currentRevision
        : null;
    if (
      entry &&
      currentRevision &&
      entry.revision &&
      currentRevision !== entry.revision
    ) {
      entry.invalidated = true;
      this.metrics.cacheMisses += 1;
      this.logReadDecision(normalizedPath, range, entry, "new_revision", {
        requestedRevision: currentRevision,
      });
      return {
        alreadyKnown: false,
        decision: "new_revision",
        range,
        entry,
      };
    }

    if (entry?.invalidated) {
      this.metrics.cacheMisses += 1;
      const decision = entry.revision ? "new_revision" : "invalidated";
      this.logReadDecision(normalizedPath, range, entry, decision, {
        requestedRevision: entry.revision,
      });
      return { alreadyKnown: false, decision, range, entry };
    }

    if (entry?.revision && this.isRangeCovered(entry, range)) {
      entry.requestCount += 1;
      entry.lastReadIteration = this.currentIteration;
      this.metrics.cachedFileReads += 1;
      this.metrics.cacheHits += 1;
      const cachedRange = this.getCachedRange(entry, range);
      const effectiveRange = this.getEffectiveRange(entry, range);
      if (
        effectiveRange &&
        this.isModelRangeVisible(
          normalizedPath,
          entry.revision,
          effectiveRange,
        )
      ) {
        this.metrics.alreadyVisibleReads += 1;
        this.metrics.duplicateReadAttempts += 1;
        this.logReadDecision(normalizedPath, range, entry, "already_visible");
        return {
          alreadyKnown: true,
          decision: "already_visible",
          range,
          entry,
          cachedContext: cachedRange,
          result: {
            success: true,
            cached: true,
            alreadyKnown: true,
            noNewInformation: true,
            informationSource: "model_context",
            path: this.toRelativePath(normalizedPath),
            revision: entry.revision,
            requestedRange: range,
            coverage: this.formatCoverage(entry),
            message: "The requested range is already visible in model context.",
          },
        };
      }
      if (cachedRange) {
        this.metrics.restoredReads += 1;
        this.metrics.restoredCharacters += cachedRange.content.length;
        this.logReadDecision(
          normalizedPath,
          range,
          entry,
          "restore_from_cache",
        );
        this.logReadDecision(
          normalizedPath,
          cachedRange,
          entry,
          "restored",
          {},
          "restore",
        );
        return {
          alreadyKnown: true,
          decision: "restore_from_cache",
          range,
          entry,
          cachedContext: cachedRange,
          result: {
            success: true,
            cached: true,
            alreadyKnown: true,
            noNewInformation: false,
            restoredFromCache: true,
            informationSource: "runtime_cache",
            path: this.toRelativePath(normalizedPath),
            revision: entry.revision,
            startLine: cachedRange.startLine,
            endLine: cachedRange.endLine,
            contentEndLine: cachedRange.endLine,
            totalLines: entry.totalLines,
            truncated:
              Number.isInteger(entry.totalLines) &&
              cachedRange.endLine < entry.totalLines,
            content: cachedRange.content,
          },
        };
      }
      this.metrics.cacheHits -= 1;
      this.metrics.cachedFileReads -= 1;
      this.metrics.cacheMisses += 1;
      this.logReadDecision(normalizedPath, range, entry, "cache_miss");
      return {
        alreadyKnown: false,
        decision: "cache_miss",
        range,
        entry,
      };
    }

    const decision = entry?.revision ? "new_range" : "actual_read";
    if (decision === "new_range") this.metrics.newRangeReads += 1;
    this.metrics.cacheMisses += 1;
    this.logReadDecision(normalizedPath, range, entry, decision);
    return { alreadyKnown: false, decision, range, entry };
  }

  recordRead(path, details = {}) {
    const normalizedPath = this.normalizePath(path);
    if (!normalizedPath || typeof details.revision !== "string") return null;
    const range = this.normalizeRange(details.startLine, details.endLine);
    const hasCoverage =
      Number.isInteger(details.knowledgeEndLine) &&
      details.knowledgeEndLine >= range.startLine;
    const coverageRange = hasCoverage
      ? { startLine: range.startLine, endLine: details.knowledgeEndLine }
      : null;
    const previous = this.files.get(normalizedPath);
    const revisionChanged =
      (Boolean(previous?.revision) && previous.revision !== details.revision) ||
      (previous?.invalidated === true &&
        Boolean(previous?.previousRevision) &&
        previous.previousRevision !== details.revision);
    if (revisionChanged) this.metrics.revisionRereads += 1;
    const contentLines = revisionChanged
      ? new Map()
      : previous?.contentLines instanceof Map
        ? previous.contentLines
        : new Map();
    if (typeof details.content === "string" && coverageRange) {
      const lines = details.content.split("\n");
      const count = Math.min(
        lines.length,
        coverageRange.endLine - coverageRange.startLine + 1,
      );
      for (let index = 0; index < count; index += 1) {
        contentLines.set(coverageRange.startLine + index, lines[index]);
      }
    }
    const ranges = revisionChanged
      ? coverageRange
        ? [coverageRange]
        : []
      : this.mergeRanges([
          ...(previous?.ranges || []),
          ...(coverageRange ? [coverageRange] : []),
        ]);
    const totalLines = Number.isInteger(details.totalLines)
      ? details.totalLines
      : previous?.totalLines || null;
    const fullRead =
      !revisionChanged && previous?.fullRead === true
        ? true
        : details.truncated !== true &&
          range.startLine === 1 &&
          Number.isInteger(totalLines) &&
          range.endLine >= totalLines;
    const entry = {
      path: normalizedPath,
      revision: details.revision,
      fullRead,
      ranges: fullRead
        ? [{ startLine: 1, endLine: totalLines }]
        : this.mergeRanges(ranges),
      totalLines,
      lastReadIteration: this.currentIteration,
      readCount: (revisionChanged ? 0 : previous?.readCount || 0) + 1,
      requestCount: (previous?.requestCount || 0) + 1,
      changed: previous?.changed === true,
      invalidated: false,
      contentLines,
    };
    this.files.set(normalizedPath, entry);
    this.metrics.actualFileReads += 1;
    if (details.diskRead === true) this.metrics.actualDiskReads += 1;
    if (details.diskRead === true) this.metrics.actualFilesystemReads += 1;
    this.logReadDecision(
      normalizedPath,
      range,
      entry,
      "actual_read",
      { requestedRevision: details.revision },
      "record",
    );
    return entry;
  }

  invalidateFile(path, revision = null, reason = "write") {
    const normalizedPath = this.normalizePath(path);
    if (!normalizedPath) return;
    const previous = this.files.get(normalizedPath);
    this.files.set(normalizedPath, {
      path: normalizedPath,
      revision: typeof revision === "string" ? revision : null,
      fullRead: false,
      ranges: [],
      totalLines: null,
      lastReadIteration: this.currentIteration,
      readCount: previous?.readCount || 0,
      requestCount: previous?.requestCount || 0,
      changed: true,
      invalidated: true,
      invalidationReason: reason,
      previousRevision: previous?.revision || null,
      contentLines: new Map(),
    });
  }

  resolveToolPath(args = {}, result = {}, key = "path") {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const candidate = key === "newPath"
      ? result?.newAbsolutePath || args?.newPath || result?.newPath || ""
      : result?.absolutePath ||
        result?.oldAbsolutePath ||
        args?.path ||
        result?.path ||
        "";
    if (!candidate) return "";
    return AgentPath.isAbsolute(candidate)
      ? AgentPath.normalize(candidate)
      : this.agent.resolveWorkspacePath(candidate, root) || "";
  }

  observeWrite(toolName, args = {}, result = {}) {
    if (!result || result.success === false) return;
    const revision = result.revision || result.verification?.revision || null;
    const contentWrites = new Set([
      "modify_file",
      "modify_active_file",
      "replace_text",
      "create_file",
      "write_file_chunk",
      "rename_file",
      "delete_file",
    ]);
    if (!contentWrites.has(toolName)) return;
    this.workspaceContentRevision += 1;
    this.projectSearchCache.clear();

    if (toolName === "rename_file") {
      const oldPath = this.resolveToolPath(args, result, "path");
      const newPath = this.resolveToolPath(args, result, "newPath");
      if (oldPath) this.files.delete(oldPath);
      if (newPath) this.invalidateFile(newPath, revision, toolName);
      this.bumpProjectStructureRevision();
      return;
    }

    const path =
      toolName === "modify_active_file" || toolName === "replace_text"
        ? this.agent.editor?.tabManager?.activeFile?.path || ""
        : this.resolveToolPath(args, result);
    if (path) this.invalidateFile(path, revision, toolName);

    if (toolName === "create_file" && result.created !== false) {
      this.bumpProjectStructureRevision();
    } else if (toolName === "delete_file") {
      if (path) this.files.delete(this.normalizePath(path));
      this.bumpProjectStructureRevision();
    }
  }

  bumpProjectStructureRevision() {
    this.projectStructureRevision += 1;
    this.projectMapCache.clear();
    this.projectListCache.clear();
  }

  makeCacheKey(values) {
    return JSON.stringify(values);
  }

  getProjectMapDecision(path, options = {}) {
    this.metrics.projectMapCalls += 1;
    const key = this.makeCacheKey({
      revision: this.projectStructureRevision,
      path: this.normalizePath(path),
      maxDepth: options.maxDepth,
      maxFiles: options.maxFiles,
    });
    const cached = this.projectMapCache.get(key);
    if (cached) {
      this.metrics.cachedProjectMaps += 1;
      return {
        cached: true,
        result: {
          success: true,
          cached: true,
          alreadyKnown: true,
          noNewInformation: true,
          path: cached.path,
          structureRevision: this.projectStructureRevision,
          files: cached.files,
          directories: cached.directories,
          truncated: cached.truncated,
          message:
            "Project map already inspected at the current structure revision. No new information was produced.",
        },
      };
    }
    return { cached: false, key };
  }

  recordProjectMap(key, result) {
    this.metrics.actualProjectMapBuilds += 1;
    this.projectMapCache.set(key, {
      path: result.path || "",
      files: result.files,
      directories: result.directories,
      truncated: result.truncated === true,
    });
  }

  getProjectListDecision(path) {
    this.metrics.listProjectFilesCalls += 1;
    const key = this.makeCacheKey({
      revision: this.projectStructureRevision,
      path: this.normalizePath(path),
    });
    const cached = this.projectListCache.get(key);
    if (cached) {
      this.metrics.cachedProjectListings += 1;
      return {
        cached: true,
        result: {
          success: true,
          cached: true,
          alreadyKnown: true,
          noNewInformation: true,
          path: cached.path,
          total: cached.total,
          structureRevision: this.projectStructureRevision,
          message:
            "Project listing already inspected at the current structure revision. No new information was produced.",
        },
      };
    }
    return { cached: false, key };
  }

  recordProjectList(key, result) {
    this.metrics.actualProjectListings += 1;
    this.projectListCache.set(key, {
      path: result.path || "",
      total: result.total,
    });
  }

  getProjectSearchDecision(args = {}) {
    this.metrics.searchProjectFilesCalls += 1;
    const key = this.makeCacheKey({
      revision: this.workspaceContentRevision,
      query: args.query,
      path: args.path || "",
      offset: args.offset || 0,
      limit: args.limit || null,
      include: args.include || null,
      exclude: args.exclude || null,
      caseSensitive: args.caseSensitive === true,
      useRegex: args.useRegex === true,
      wholeWord: args.wholeWord === true,
    });
    const cached = this.projectSearchCache.get(key);
    if (cached) {
      this.metrics.cachedProjectSearches += 1;
      return {
        cached: true,
        result: {
          success: true,
          cached: true,
          alreadyKnown: true,
          noNewInformation: true,
          query: args.query,
          totalMatches: cached.totalMatches,
          contentRevision: this.workspaceContentRevision,
          message:
            "This search was already performed at the current workspace content revision. No new information was produced.",
        },
      };
    }
    return { cached: false, key };
  }

  recordProjectSearch(key, result) {
    this.metrics.actualProjectSearches += 1;
    this.projectSearchCache.set(key, {
      totalMatches: result?.totalMatches ?? result?.total ?? null,
    });
  }

  observeToolInformation(toolName, payload = {}) {
    if (payload?.alreadyKnown === true || payload?.noNewInformation === true) {
      this.consecutiveNoNewInformationToolCalls += 1;
      this.metrics.noNewInformationToolCalls += 1;
    } else {
      this.consecutiveNoNewInformationToolCalls = 0;
    }
    if (this.consecutiveNoNewInformationToolCalls >= 2) {
      this.consecutiveNoNewInformationToolCalls = 0;
      this.metrics.runtimeInterventions += 1;
      return true;
    }
    return false;
  }

  getContextState() {
    const entries = [...this.files.values()]
      .filter((entry) => entry.revision)
      .sort(
        (left, right) => right.lastReadIteration - left.lastReadIteration,
      );
    const files = entries.slice(0, this.maxContextFiles).map((entry) => ({
      path: this.toRelativePath(entry.path),
      revision: entry.revision,
      coverage: this.formatCoverage(entry),
      changed: entry.changed === true,
      invalidated: entry.invalidated === true,
      lastReadIteration: entry.lastReadIteration,
    }));
    return {
      files,
      omittedCount: Math.max(0, entries.length - files.length),
      projectStructureRevision: this.projectStructureRevision,
      workspaceContentRevision: this.workspaceContentRevision,
    };
  }

  getMetrics() {
    return {
      ...this.metrics,
      readRequests: this.metrics.readFileCalls,
      newRangeReads: this.metrics.newRangeReads,
      revisionReads: this.metrics.revisionRereads,
    };
  }

  clearTransientContent() {
    for (const entry of this.files.values()) {
      entry.contentLines = new Map();
    }
    this.modelVisibleFiles.clear();
  }
}

window.FileKnowledge = FileKnowledge;
