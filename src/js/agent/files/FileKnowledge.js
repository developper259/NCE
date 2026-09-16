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
    this.transientSources = new Map();
    this.readSignatureCounts = new Map();
    this.currentIteration = 0;
    this.consecutiveRedundantReads = 0;
    this.consecutiveNoNewInformationToolCalls = 0;
    this.metrics = {
      readFileCalls: 0,
      actualFileReads: 0,
      actualDiskReads: 0,
      cachedFileReads: 0,
      duplicateReadAttempts: 0,
      repeatedDuplicateReads: 0,
      newRangeReads: 0,
      revisionRereads: 0,
      revisionInvalidations: 0,
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
      newContentReads: 0,
      partialContentReads: 0,
      cacheRestores: 0,
      redundantReads: 0,
      hardBlockedRedundantReads: 0,
      charactersDelivered: 0,
      charactersAvoidedByDedup: 0,
      completeLinesDelivered: 0,
      partialSegmentsDelivered: 0,
      proactiveRedundantExchangesRemoved: 0,
      redundantContextTokensAvoided: 0,
      overlappingCharactersAvoided: 0,
      columnRangeReductions: 0,
      sourceCacheHits: 0,
      sourceCacheMisses: 0,
    };
  }

  setIteration(iteration) {
    if (Number.isInteger(iteration) && iteration > 0) {
      this.currentIteration = iteration;
    }
  }

  normalizePath(path) {
    return typeof path === "string" ? AgentPath.comparisonKey(path) : "";
  }

  normalizeRange(startLine, endLine) {
    const start = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
    const defaultLines = this.agent.toolLimits?.read_file?.defaultLines || 200;
    const end =
      Number.isInteger(endLine) && endLine >= start
        ? endLine
        : start + defaultLines - 1;
    return { startLine: start, endLine: end };
  }

  getReadSignature(toolName, path, revision, range, options = {}) {
    const relevantOptions = Object.fromEntries(
      Object.entries(options)
        .filter(([, value]) => value !== undefined && value !== null)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    return JSON.stringify({
      tool: toolName || "read_file",
      path: this.normalizePath(path),
      revision: revision || null,
      range: {
        startLine: range.startLine,
        endLine: range.endLine,
      },
      options: relevantOptions,
    });
  }

  resetDuplicateReadSequence() {
    this.readSignatureCounts.clear();
    this.consecutiveRedundantReads = 0;
  }

  mergeSegments(segments = []) {
    const sorted = segments
      .filter(
        (segment) =>
          Number.isInteger(segment?.line) &&
          Number.isInteger(segment?.startColumn) &&
          Number.isInteger(segment?.endColumn) &&
          segment.endColumn > segment.startColumn,
      )
      .sort((a, b) => a.line - b.line || a.startColumn - b.startColumn);
    const merged = [];
    for (const segment of sorted) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.line === segment.line &&
        segment.startColumn <= previous.endColumn
      ) {
        previous.endColumn = Math.max(previous.endColumn, segment.endColumn);
      } else
        merged.push({
          line: segment.line,
          startColumn: segment.startColumn,
          endColumn: segment.endColumn,
        });
    }
    return merged;
  }

  getColumnCoverage(segments = [], line) {
    return this.mergeSegments(
      segments.filter((segment) => segment?.line === line),
    ).map(({ startColumn, endColumn }) => ({ startColumn, endColumn }));
  }

  getFirstUncoveredColumn(segments = [], startColumn = 0, lineLength = null) {
    let cursor = Math.max(0, startColumn);
    for (const segment of this.mergeSegments(segments)) {
      if (segment.endColumn <= cursor) continue;
      if (segment.startColumn > cursor) return cursor;
      cursor = Math.max(cursor, segment.endColumn);
      if (Number.isInteger(lineLength) && cursor >= lineLength) return null;
    }
    return Number.isInteger(lineLength) && cursor >= lineLength ? null : cursor;
  }

  getCachedPartialSegment(entry, line, startColumn) {
    const candidate = (entry?.partialSegments || [])
      .filter(
        (segment) => segment.line === line && segment.endColumn > startColumn,
      )
      .sort((left, right) => left.startColumn - right.startColumn)[0];
    if (!candidate) return null;
    const offset = Math.max(0, startColumn - candidate.startColumn);
    return {
      ...candidate,
      startColumn: candidate.startColumn + offset,
      content: candidate.content.slice(offset),
    };
  }

  getTransientSource(path, revision) {
    const normalizedPath = this.normalizePath(path);
    const cached = this.transientSources.get(normalizedPath);
    if (!cached || cached.revision !== revision) {
      this.metrics.sourceCacheMisses += 1;
      return null;
    }
    this.metrics.sourceCacheHits += 1;
    return cached.content;
  }

  setTransientSource(path, revision, content) {
    const normalizedPath = this.normalizePath(path);
    if (
      !normalizedPath ||
      typeof revision !== "string" ||
      typeof content !== "string"
    )
      return;
    this.transientSources.delete(normalizedPath);
    this.transientSources.set(normalizedPath, { revision, content });
    while (this.transientSources.size > Math.max(1, this.maxContextFiles)) {
      this.transientSources.delete(this.transientSources.keys().next().value);
    }
  }

  isModelSegmentVisible(path, revision, line, startColumn, endColumn) {
    const visible = this.modelVisibleFiles.get(this.normalizePath(path));
    if (visible?.revision !== revision) return false;
    if (
      visible.ranges?.some(
        (range) => range.startLine <= line && range.endLine >= line,
      )
    )
      return true;
    return (
      this.getFirstUncoveredColumn(
        visible.partialSegments?.filter((segment) => segment.line === line) ||
          [],
        startColumn,
        endColumn,
      ) === null
    );
  }

  recordPartialSegment(path, details = {}) {
    const normalizedPath = this.normalizePath(path);
    if (
      !normalizedPath ||
      typeof details.revision !== "string" ||
      typeof details.content !== "string"
    )
      return null;
    const previous = this.files.get(normalizedPath);
    const revisionChanged =
      previous?.revision !== details.revision || previous?.invalidated === true;
    const entry =
      revisionChanged || !previous
        ? {
            path: normalizedPath,
            revision: details.revision,
            ranges: [],
            partialSegments: [],
            contentLines: new Map(),
            servedRequests: new Map(),
            totalLines: details.totalLines,
            fullRead: false,
            readCount: 0,
            requestCount: 0,
            invalidated: false,
          }
        : previous;
    const segment = {
      line: details.line,
      startColumn: details.startColumn,
      endColumn: details.endColumn,
      lineLength: details.lineLength,
      content: details.content,
    };
    entry.partialSegments.push(segment);
    entry.readCount++;
    entry.requestCount++;
    entry.lastReadIteration = this.currentIteration;
    entry.revision = details.revision;
    entry.invalidated = false;
    entry.totalLines = details.totalLines;
    const coverage = this.mergeSegments(
      entry.partialSegments.filter((part) => part.line === details.line),
    );
    if (
      coverage.length === 1 &&
      coverage[0].startColumn === 0 &&
      coverage[0].endColumn >= details.lineLength
    ) {
      const parts = entry.partialSegments
        .filter((part) => part.line === details.line)
        .sort((a, b) => a.startColumn - b.startColumn);
      let reconstructed = "";
      for (const part of parts) {
        if (part.startColumn > reconstructed.length) break;
        reconstructed += part.content.slice(
          Math.max(0, reconstructed.length - part.startColumn),
        );
      }
      if (reconstructed.length === details.lineLength) {
        entry.contentLines.set(details.line, reconstructed);
        entry.ranges = this.mergeRanges([
          ...entry.ranges,
          { startLine: details.line, endLine: details.line },
        ]);
      }
    }
    this.files.set(normalizedPath, entry);
    this.resetDuplicateReadSequence();
    this.metrics.actualFileReads++;
    if (details.diskRead) {
      this.metrics.actualDiskReads++;
      this.metrics.actualFilesystemReads++;
    }
    this.metrics.partialContentReads++;
    this.metrics.partialSegmentsDelivered++;
    this.metrics.charactersDelivered += details.content.length;
    this.logReadDecision(
      normalizedPath,
      { startLine: details.line, endLine: details.line },
      entry,
      "partial_segment",
      {
        requestedRevision: details.revision,
        charactersDelivered: details.content.length,
      },
      "record",
    );
    return entry;
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

  getFirstUncoveredRange(entry, range) {
    if (!entry || entry.invalidated) return range;
    let startLine = range.startLine;
    for (const known of this.mergeRanges(entry.ranges || [])) {
      if (known.endLine < startLine) continue;
      if (known.startLine > range.endLine) break;
      if (known.startLine > startLine) {
        return {
          startLine,
          endLine: Math.min(range.endLine, known.startLine - 1),
        };
      }
      startLine = Math.max(startLine, known.endLine + 1);
      if (startLine > range.endLine) return null;
    }
    return startLine <= range.endLine
      ? { startLine, endLine: range.endLine }
      : null;
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

  getFirstCachedRange(entry, range, maxChars = null, visibleRanges = []) {
    if (
      !(entry?.contentLines instanceof Map) ||
      !entry.contentLines.has(range.startLine)
    )
      return null;
    const outputLimit =
      maxChars || this.agent.toolLimits?.read_file?.outputCharacters || 4000;
    const lines = [];
    let chars = 0;
    for (let line = range.startLine; line <= range.endLine; line++) {
      if (
        visibleRanges.some(
          (visible) => visible.startLine <= line && visible.endLine >= line,
        )
      )
        break;
      if (!entry.contentLines.has(line)) break;
      const value = entry.contentLines.get(line);
      const required = value.length + (lines.length ? 1 : 0);
      if (chars + required > outputLimit) break;
      lines.push(value);
      chars += required;
    }
    return lines.length
      ? {
          startLine: range.startLine,
          endLine: range.startLine + lines.length - 1,
          content: lines.join("\n"),
        }
      : null;
  }

  planReadDelivery(path, requestedRange, entry, startColumn = 0) {
    const visible =
      entry?.revision &&
      this.modelVisibleFiles.get(this.normalizePath(path))?.revision ===
        entry.revision
        ? this.modelVisibleFiles.get(this.normalizePath(path))
        : null;
    const effective =
      this.getEffectiveRange(entry, requestedRange) || requestedRange;
    const lineLength = entry?.partialSegments?.find(
      (part) => part.line === effective.startLine,
    )?.lineLength;
    if (
      effective.startLine === effective.endLine &&
      (startColumn > 0 ||
        Number.isInteger(lineLength) ||
        visible?.partialSegments?.some(
          (part) => part.line === effective.startLine,
        ))
    ) {
      const exactVisibleSegment = visible?.partialSegments?.find(
        (part) =>
          part.line === effective.startLine && part.startColumn === startColumn,
      );
      if (
        exactVisibleSegment &&
        startColumn === 0 &&
        entry?.partialSegments?.some(
          (part) =>
            part.line === effective.startLine &&
            part.startColumn === 0 &&
            part.endColumn >= exactVisibleSegment.endColumn,
        )
      ) {
        return {
          kind: "ALREADY_VISIBLE",
          range: effective,
          segment: exactVisibleSegment,
        };
      }
      if (this.isModelRangeVisible(path, entry.revision, effective)) {
        return { kind: "ALREADY_VISIBLE", range: effective };
      }
      const effectiveStart = this.getFirstUncoveredColumn(
        visible?.partialSegments?.filter(
          (part) => part.line === effective.startLine,
        ) || [],
        startColumn,
        lineLength,
      );
      if (effectiveStart === null)
        return { kind: "ALREADY_VISIBLE", range: effective };
      if (effectiveStart > startColumn) this.metrics.columnRangeReductions += 1;
      const segment = this.getCachedPartialSegment(
        entry,
        effective.startLine,
        effectiveStart,
      );
      if (segment) {
        this.metrics.overlappingCharactersAvoided += Math.max(
          0,
          effectiveStart - startColumn,
        );
        return {
          kind: "RESTORE_SEGMENT",
          range: {
            startLine: effective.startLine,
            endLine: effective.endLine,
            startColumn: effectiveStart,
          },
          segment,
        };
      }
      return {
        kind:
          effectiveStart !== startColumn
            ? "PARTIAL_NEW_CONTENT"
            : "READ_NEW_CONTENT",
        range: { ...effective, startColumn: effectiveStart },
      };
    }
    const missing = this.getFirstUncoveredRange(
      { ranges: visible?.ranges || [] },
      effective,
    );
    if (!missing) return { kind: "ALREADY_VISIBLE", range: effective };
    const cached = this.getFirstCachedRange(
      entry,
      missing,
      null,
      visible?.ranges || [],
    );
    if (cached) return { kind: "RESTORE_FROM_CACHE", range: cached };
    let endLine = missing.endLine;
    for (let line = missing.startLine + 1; line <= missing.endLine; line++) {
      if (
        entry?.contentLines?.has(line) ||
        visible?.ranges?.some(
          (range) => range.startLine <= line && range.endLine >= line,
        )
      ) {
        endLine = line - 1;
        break;
      }
    }
    return {
      kind:
        missing.startLine !== requestedRange.startLine ||
        endLine !== requestedRange.endLine
          ? "PARTIAL_NEW_CONTENT"
          : "READ_NEW_CONTENT",
      range: { startLine: missing.startLine, endLine },
    };
  }

  updateModelVisibility(ranges = []) {
    const visible = new Map();
    for (const item of ranges) {
      const normalizedPath = this.resolveVisiblePath(item?.path);
      if (!normalizedPath || typeof item?.revision !== "string") continue;
      const current = visible.get(normalizedPath);
      const state =
        current?.revision === item.revision
          ? current
          : { revision: item.revision, ranges: [], partialSegments: [] };
      const complete =
        item.completeLineRange ||
        (Number.isInteger(item.startLine) && Number.isInteger(item.endLine)
          ? { startLine: item.startLine, endLine: item.endLine }
          : null);
      if (complete)
        state.ranges = this.mergeRanges([...state.ranges, complete]);
      if (item.partialSegment)
        state.partialSegments = this.mergeSegments([
          ...state.partialSegments,
          item.partialSegment,
        ]);
      visible.set(normalizedPath, state);
    }
    for (const [path, state] of visible) {
      const entry = this.files.get(path);
      if (entry?.revision !== state.revision) continue;
      for (const [line, content] of entry.contentLines || []) {
        const segments = state.partialSegments.filter(
          (segment) => segment.line === line,
        );
        if (
          segments.length === 1 &&
          segments[0].startColumn === 0 &&
          segments[0].endColumn >= content.length
        ) {
          state.ranges = this.mergeRanges([
            ...state.ranges,
            { startLine: line, endLine: line },
          ]);
        }
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
    return (
      this.getFirstUncoveredRange({ ranges: visible.ranges }, range) === null
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
    const coveredRange = details.coveredRange;
    console.info("[NCE Agent read knowledge]", {
      event,
      path: this.toRelativePath(path),
      revision: details.requestedRevision || entry?.revision || null,
      requestedRevision: details.requestedRevision || entry?.revision || null,
      knownRevision: entry?.revision || null,
      requestedRange: `${range.startLine}-${range.endLine}`,
      coveredRange: coveredRange
        ? `${coveredRange.startLine}-${coveredRange.endLine}`
        : this.formatCoverage(entry),
      visible: details.visible === true,
      ...(event === "restore"
        ? { restoredRange: `${range.startLine}-${range.endLine}` }
        : {}),
      knownCoverage: this.formatCoverage(entry),
      decision,
      charactersDelivered: details.charactersDelivered || 0,
      currentlyVisibleCoverage:
        details.visible === true
          ? (this.modelVisibleFiles.get(this.normalizePath(path))?.ranges || [])
              .map((item) => `${item.startLine}-${item.endLine}`)
              .join(",")
          : null,
      ...(Number.isInteger(details.duplicateCount)
        ? { duplicateCount: details.duplicateCount }
        : {}),
    });
  }

  toRelativePath(path) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (AgentPath.isInside(path, root)) {
      const relative = this.normalizePath(path).slice(this.normalizePath(root).length);
      return relative.replace(/^\//, "") || "";
    }
    return this.agent.toProjectRelativePath(path, root) || path;
  }

  checkRead(path, startLine, endLine, options = {}) {
    const normalizedPath = this.normalizePath(path);
    const range = this.normalizeRange(startLine, endLine);
    const entry = this.files.get(normalizedPath);
    this.metrics.readFileCalls += 1;

    if (options.forceRead === true) {
      this.resetDuplicateReadSequence();
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
      this.resetDuplicateReadSequence();
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
      this.resetDuplicateReadSequence();
      this.metrics.cacheMisses += 1;
      const decision = entry.revision ? "new_revision" : "invalidated";
      this.logReadDecision(normalizedPath, range, entry, decision, {
        requestedRevision: entry.revision,
      });
      return { alreadyKnown: false, decision, range, entry };
    }

    const readSignature = entry?.revision
      ? this.getReadSignature(
          options.toolName,
          normalizedPath,
          entry.revision,
          range,
          {
            ...(options.signatureOptions || {}),
            ...(Number.isInteger(options.startColumn)
              ? { startColumn: options.startColumn }
              : {}),
          },
        )
      : null;
    const plan = entry?.revision
      ? this.planReadDelivery(
          normalizedPath,
          range,
          entry,
          options.startColumn || 0,
        )
      : { kind: "READ_NEW_CONTENT", range };
    if (plan.kind === "ALREADY_VISIBLE")
      return this.createAlreadyAvailableRead(
        normalizedPath,
        range,
        plan.range,
        entry,
        readSignature,
        {
          nextStartLine: plan.segment?.line || null,
          nextStartColumn: plan.segment?.endColumn || null,
          avoidedChars: plan.segment?.content?.length || 0,
        },
      );
    if (plan.kind === "RESTORE_SEGMENT")
      return this.createRestoredSegmentRead(
        normalizedPath,
        range,
        plan.segment,
        entry,
      );
    if (plan.kind === "RESTORE_FROM_CACHE")
      return this.createRestoredRead(normalizedPath, range, plan.range, entry);
    const decision = entry?.revision ? "new_range" : "actual_read";
    this.resetDuplicateReadSequence();
    if (decision === "new_range") this.metrics.newRangeReads += 1;
    this.metrics.cacheMisses += 1;
    this.logReadDecision(normalizedPath, range, entry, decision);
    return {
      alreadyKnown: false,
      decision,
      range: plan.range,
      informationGain: plan.kind,
      requestedRange: range,
      entry,
    };
  }

  createAlreadyAvailableRead(
    path,
    requestedRange,
    coveredRange,
    entry,
    signature,
    options = {},
  ) {
    entry.requestCount += 1;
    entry.lastReadIteration = this.currentIteration;
    this.metrics.cachedFileReads += 1;
    this.metrics.cacheHits += 1;
    const duplicateCount = (this.readSignatureCounts.get(signature) || 0) + 1;
    this.readSignatureCounts.set(signature, duplicateCount);
    this.consecutiveRedundantReads += 1;
    const repeatedRedundant = true;
    const hardBlocked = this.consecutiveRedundantReads >= 3;
    this.metrics.alreadyVisibleReads += 1;
    this.metrics.duplicateReadAttempts += 1;
    this.metrics.redundantReads += 1;
    const cached = this.getCachedRange(entry, coveredRange);
    if (cached) this.metrics.charactersAvoidedByDedup += cached.content.length;
    else if (options.avoidedChars)
      this.metrics.charactersAvoidedByDedup += options.avoidedChars;
    if (hardBlocked) this.metrics.hardBlockedRedundantReads += 1;
    if (repeatedRedundant) this.metrics.repeatedDuplicateReads += 1;
    console.debug("[NCE Agent redundant tool]", {
      tool: "read_file",
      path: this.toRelativePath(path),
      requestedRevision: entry.revision,
      knownRevision: entry.revision,
      requestedRange,
      coveredBy: coveredRange,
      reason: "same_revision_range_already_known",
    });
    this.logReadDecision(
      path,
      requestedRange,
      entry,
      hardBlocked
        ? "redundant_hard_block"
        : repeatedRedundant
          ? "repeated_redundant"
          : "already_available",
      {
        requestedRevision: entry.revision,
        duplicateCount,
        coveredRange,
        visible: true,
      },
    );
    return {
      alreadyKnown: true,
      decision: repeatedRedundant ? "repeated_redundant" : "already_available",
      range: requestedRange,
      entry,
      result: {
        success: true,
        cached: true,
        alreadyKnown: true,
        noNewInformation: true,
        informationGain: "ZERO_NEW_INFORMATION",
        repeatedRedundantAction: repeatedRedundant,
        readDecision: hardBlocked
          ? "REDUNDANT_READ_HARD_BLOCK"
          : repeatedRedundant
            ? "REPEATED_REDUNDANT_READ"
            : "ALREADY_AVAILABLE",
        readSignature: signature,
        duplicateCount,
        informationSource: "model_context",
        path: this.toRelativePath(path),
        revision: entry.revision,
        requestedRange,
        knownRevision: entry.revision,
        reason: "same_revision_range_already_known",
        coverage: this.formatCoverage(entry),
        visibleCoverage:
          this.modelVisibleFiles.get(this.normalizePath(path))?.ranges || [],
        nextStartLine: options.nextStartLine || null,
        nextStartColumn: options.nextStartColumn,
        message: hardBlocked
          ? "[NCE READ RECOVERY] The requested content is already available in your current context. Do not reread currently visible content. You may still freely read an unseen range, another file, a newer revision, content removed by compaction, or a long-line continuation using nextStartLine/nextStartColumn."
          : repeatedRedundant
            ? "Inspect only a currently missing range or perform the next useful action. Repeating visible content cannot provide new information."
            : "Requested content is already present in the current model context. Use the existing context.",
      },
    };
  }

  createRestoredRead(path, requestedRange, cachedRange, entry) {
    entry.requestCount += 1;
    entry.lastReadIteration = this.currentIteration;
    this.metrics.cachedFileReads += 1;
    this.metrics.cacheHits += 1;
    this.resetDuplicateReadSequence();
    this.metrics.restoredReads += 1;
    this.metrics.cacheRestores += 1;
    this.metrics.restoredCharacters += cachedRange.content.length;
    this.metrics.charactersDelivered += cachedRange.content.length;
    this.metrics.completeLinesDelivered +=
      cachedRange.endLine - cachedRange.startLine + 1;
    this.logReadDecision(path, requestedRange, entry, "restore_from_cache", {
      requestedRevision: entry.revision,
      coveredRange: cachedRange,
      visible: false,
    });
    this.logReadDecision(
      path,
      cachedRange,
      entry,
      "restored",
      { coveredRange: cachedRange, visible: false },
      "restore",
    );
    return {
      alreadyKnown: true,
      decision: "restore_from_cache",
      range: requestedRange,
      entry,
      cachedContext: cachedRange,
      result: {
        success: true,
        cached: true,
        alreadyKnown: true,
        noNewInformation: false,
        informationGain: "RESTORED_CONTENT",
        restoredFromCache: true,
        readDecision: "RESTORED",
        informationSource: "runtime_cache",
        path: this.toRelativePath(path),
        revision: entry.revision,
        startLine: cachedRange.startLine,
        endLine: cachedRange.endLine,
        requestedStartLine: requestedRange.startLine,
        requestedEndLine: requestedRange.endLine,
        requestedRange,
        deliveredRange: {
          startLine: cachedRange.startLine,
          endLine: cachedRange.endLine,
        },
        contentStartLine: cachedRange.startLine,
        contentEndLine: cachedRange.endLine,
        completeLineRange: {
          startLine: cachedRange.startLine,
          endLine: cachedRange.endLine,
        },
        nextStartLine:
          cachedRange.endLine < requestedRange.endLine
            ? cachedRange.endLine + 1
            : null,
        nextStartColumn: null,
        totalLines: entry.totalLines,
        truncated:
          Number.isInteger(entry.totalLines) &&
          cachedRange.endLine < entry.totalLines,
        content: cachedRange.content,
      },
    };
  }

  createRestoredSegmentRead(path, requestedRange, segment, entry) {
    this.metrics.cachedFileReads++;
    this.metrics.cacheHits++;
    this.metrics.restoredReads++;
    this.metrics.cacheRestores++;
    this.metrics.restoredCharacters += segment.content.length;
    this.metrics.charactersDelivered += segment.content.length;
    this.metrics.partialSegmentsDelivered++;
    this.resetDuplicateReadSequence();
    return {
      alreadyKnown: true,
      decision: "restore_from_cache",
      range: requestedRange,
      entry,
      result: {
        success: true,
        cached: true,
        alreadyKnown: true,
        restoredFromCache: true,
        noNewInformation: false,
        informationGain: "RESTORED_CONTENT",
        readDecision: "RESTORED",
        path: this.toRelativePath(path),
        revision: entry.revision,
        requestedStartLine: requestedRange.startLine,
        requestedEndLine: requestedRange.endLine,
        requestedRange,
        deliveredRange: {
          startLine: segment.line,
          endLine: segment.line,
          startColumn: segment.startColumn,
          endColumn: segment.endColumn,
        },
        contentStartLine: segment.line,
        contentEndLine: segment.line,
        contentStartColumn: segment.startColumn,
        contentEndColumn: segment.endColumn,
        partialSegment: {
          line: segment.line,
          startColumn: segment.startColumn,
          endColumn: segment.endColumn,
          lineLength: segment.lineLength,
        },
        completeLineRange: null,
        lineTruncated: true,
        hasMore:
          segment.endColumn < segment.lineLength ||
          segment.line < requestedRange.endLine,
        nextStartLine:
          segment.endColumn < segment.lineLength
            ? segment.line
            : segment.line + 1,
        nextStartColumn:
          segment.endColumn < segment.lineLength ? segment.endColumn : 0,
        content: segment.content,
      },
    };
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
    const servedRequests = revisionChanged
      ? new Map()
      : previous?.servedRequests instanceof Map
        ? previous.servedRequests
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
        : coverageRange?.startLine === 1 &&
          Number.isInteger(totalLines) &&
          coverageRange.endLine >= totalLines;
    const requestedRange = this.normalizeRange(
      details.requestedStartLine ?? range.startLine,
      details.requestedEndLine ?? range.endLine,
    );
    if (coverageRange && coverageRange.startLine === requestedRange.startLine) {
      const signature = this.getReadSignature(
        details.toolName,
        normalizedPath,
        details.revision,
        requestedRange,
        details.signatureOptions,
      );
      servedRequests.set(signature, coverageRange);
    }
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
      partialSegments: revisionChanged ? [] : previous?.partialSegments || [],
      servedRequests,
    };
    this.files.set(normalizedPath, entry);
    this.resetDuplicateReadSequence();
    this.metrics.actualFileReads += 1;
    this.metrics.newContentReads += 1;
    if (
      coverageRange &&
      (coverageRange.startLine !== requestedRange.startLine ||
        coverageRange.endLine !== requestedRange.endLine)
    ) {
      this.metrics.partialContentReads += 1;
    }
    this.metrics.charactersDelivered +=
      typeof details.content === "string" ? details.content.length : 0;
    this.metrics.completeLinesDelivered += coverageRange
      ? coverageRange.endLine - coverageRange.startLine + 1
      : 0;
    if (details.diskRead === true) this.metrics.actualDiskReads += 1;
    if (details.diskRead === true) this.metrics.actualFilesystemReads += 1;
    this.logReadDecision(
      normalizedPath,
      requestedRange,
      entry,
      "actual_read",
      {
        requestedRevision: details.revision,
        coveredRange: coverageRange,
        charactersDelivered:
          typeof details.content === "string" ? details.content.length : 0,
        visible: false,
      },
      "record",
    );
    return entry;
  }

  invalidateFile(path, revision = null, reason = "write") {
    const normalizedPath = this.normalizePath(path);
    if (!normalizedPath) return;
    const previous = this.files.get(normalizedPath);
    const entry = {
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
      partialSegments: [],
      servedRequests: new Map(),
    };
    this.files.set(normalizedPath, entry);
    this.transientSources.delete(normalizedPath);
    this.modelVisibleFiles.delete(normalizedPath);
    this.resetDuplicateReadSequence();
    this.metrics.revisionInvalidations += 1;
    this.logReadDecision(
      normalizedPath,
      { startLine: 1, endLine: 1 },
      entry,
      "invalidated",
      { requestedRevision: entry.revision, visible: false },
      "invalidate",
    );
  }

  resolveToolPath(args = {}, result = {}, key = "path") {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const candidate =
      key === "newPath"
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
      "create_file",
      "write_file_chunk",
      "rename_file",
      "delete_file",
      "create_folder",
      "delete_folder",
    ]);
    if (!contentWrites.has(toolName)) return;
    this.resetDuplicateReadSequence();
    this.workspaceContentRevision += 1;
    this.projectSearchCache.clear();

    if (toolName === "create_folder" || toolName === "delete_folder") {
      this.bumpProjectStructureRevision();
      return;
    }

    if (toolName === "rename_file") {
      const oldPath = this.resolveToolPath(args, result, "path");
      const newPath = this.resolveToolPath(args, result, "newPath");
      if (oldPath) this.files.delete(oldPath);
      if (newPath) this.invalidateFile(newPath, revision, toolName);
      this.bumpProjectStructureRevision();
      return;
    }

    const path = this.resolveToolPath(args, result);
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
      path: this.normalizePath(args.path || ""),
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
    if (
      payload?.noNewInformation === true ||
      (payload?.alreadyKnown === true && payload?.restoredFromCache !== true)
    ) {
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
      .sort((left, right) => right.lastReadIteration - left.lastReadIteration);
    const files = entries.slice(0, this.maxContextFiles).map((entry) => ({
      path: this.toRelativePath(entry.path),
      revision: entry.revision,
      coverage: this.formatCoverage(entry),
      partialSegments: (entry.partialSegments || []).map((part) => ({
        line: part.line,
        startColumn: part.startColumn,
        endColumn: part.endColumn,
      })),
      visibleRanges:
        this.modelVisibleFiles.get(entry.path)?.revision === entry.revision
          ? this.modelVisibleFiles.get(entry.path).ranges
          : [],
      visiblePartialSegments:
        this.modelVisibleFiles.get(entry.path)?.revision === entry.revision
          ? this.modelVisibleFiles.get(entry.path).partialSegments
          : [],
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
      actualReads: this.metrics.actualFileReads,
      newRangeReads: this.metrics.newRangeReads,
      revisionReads: this.metrics.revisionRereads,
    };
  }

  clearTransientContent() {
    for (const entry of this.files.values()) {
      entry.contentLines = new Map();
      entry.partialSegments = [];
    }
    this.modelVisibleFiles.clear();
    this.transientSources.clear();
  }
}

window.FileKnowledge = FileKnowledge;
