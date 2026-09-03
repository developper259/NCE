class AgentProgress {
  constructor(agent) {
    this.agent = agent;
    this.noInformationThreshold = 2;
    this.maxStagnationRecoveries = 2;
    this.reset();
  }

  reset(options = {}) {
    this.overExplorationThreshold = Math.max(
      1,
      Number(this.agent?.progressGuidance?.overExplorationThreshold) || 6,
    );
    this.overExplorationEscalationInterval = Math.max(
      1,
      Number(
        this.agent?.progressGuidance?.overExplorationEscalationInterval,
      ) || 4,
    );
    this.requiresModification = options.requiresModification === true;
    this.phase = "discover";
    this.consecutiveNoNewInformation = 0;
    this.consecutiveExplorationActions = 0;
    this.consecutiveExplorationPeak = 0;
    this.overExplorationLevel = 0;
    this.stagnationRecoveryLevel = 0;
    this.awaitingProgress = false;
    this.stagnationDetected = false;
    this.recoveryObservationLogged = false;
    this.usefulInspectionCount = 0;
    this.writeOccurred = false;
    this.blockingError = false;
    this.awaitingFix = false;
    this.activeErrorCategory = null;
    this.observedInformationSignatures = new Set();
    this.unavailableToolAttempts = new Map();
    this.recentInformationEvents = [];
    this.metrics = {
      modelRequests: 0,
      modelAttempts: 0,
      toolCalls: 0,
      newInformationToolCalls: 0,
      explorationActions: 0,
      taskProgressActions: 0,
      overExplorationSignals: 0,
      recoveryDirectives: 0,
      repeatedRedundantActions: 0,
      restoredInformationToolCalls: 0,
      noNewInformationToolCalls: 0,
      stateChangedToolCalls: 0,
      stagnationEvents: 0,
      stagnationRecoveries: 0,
      writeToolCalls: 0,
      successfulWriteToolCalls: 0,
      validationCalls: 0,
      validationFailures: 0,
      fixIterations: 0,
      taskCompleteCalls: 0,
      createFileCalls: 0,
      createFileOversizeRejected: 0,
      chunkWriteCalls: 0,
      chunkWriteCharacters: 0,
      toolArgumentsTruncated: 0,
      largeWriteRecoveries: 0,
      duplicateOversizedRetries: 0,
      unknownToolCalls: 0,
      toolUnavailableRecoveries: 0,
      staticValidationActions: 0,
      commandExecutionAvailable:
        this.agent?.getToolCapabilities?.().commandExecution === true,
      taskCompleteWithoutCommandExecution: 0,
      totalIterations: 0,
      model429s: 0,
      modelRetries: 0,
      modelFallbacks: 0,
      agenticWorkStarted: false,
      taskCompleteRequired: false,
      normalConversationalFinish: 0,
      agenticContinuation: 0,
      taskCompleteFinish: 0,
    };
  }

  recordAgenticWorkStarted(taskCompleteRequired = false) {
    this.metrics.agenticWorkStarted = true;
    this.metrics.taskCompleteRequired = taskCompleteRequired === true;
  }

  recordCompletionDecision(reason, state = {}) {
    const agenticWorkStarted = state.agenticWorkStarted === true;
    const taskCompleteRequired = state.taskCompleteRequired === true;
    this.metrics.agenticWorkStarted = agenticWorkStarted;
    this.metrics.taskCompleteRequired = taskCompleteRequired;
    if (reason === "normal_response") {
      this.metrics.normalConversationalFinish += 1;
    } else if (reason === "continue_agentic_task") {
      this.metrics.agenticContinuation += 1;
    } else if (reason === "task_complete") {
      this.metrics.taskCompleteFinish += 1;
      if (!this.metrics.commandExecutionAvailable) {
        this.metrics.taskCompleteWithoutCommandExecution += 1;
      }
    }
    console.info("[NCE Agent completion]", {
      reason,
      agenticWorkStarted,
      taskCompleteRequired,
      commandExecutionAvailable: this.metrics.commandExecutionAvailable,
      validationMode: this.metrics.commandExecutionAvailable
        ? "registered_validation_tool"
        : "repository_static",
    });
  }

  setPhase(phase, details = {}) {
    if (!phase || phase === this.phase) return;
    const previous = this.phase;
    this.phase = phase;
    this.log({
      event: "phase_change",
      iteration: details.iteration ?? null,
      lastTool: details.lastTool || null,
      informationStatus: details.informationStatus || null,
      previousPhase: previous,
    });
  }

  addEvent(event) {
    this.recentInformationEvents.push(event);
    if (this.recentInformationEvents.length > 20) {
      this.recentInformationEvents.shift();
    }
  }

  recordModelRequest() {
    this.metrics.modelRequests += 1;
    this.metrics.totalIterations += 1;
  }

  recordModelAttempt() {
    this.metrics.modelAttempts += 1;
  }

  recordModel429() {
    this.metrics.model429s += 1;
  }

  recordModelRetry() {
    this.metrics.modelRetries += 1;
  }

  recordModelFallback() {
    this.metrics.modelFallbacks += 1;
  }

  recordFileWriteRequest(toolName, contentChars = 0) {
    if (toolName === "create_file") this.metrics.createFileCalls += 1;
    if (toolName === "write_file_chunk") {
      this.metrics.chunkWriteCalls += 1;
      this.metrics.chunkWriteCharacters += Math.max(0, contentChars);
    }
  }

  recordFileWriteOversizeRejected(toolName) {
    if (toolName === "create_file") {
      this.metrics.createFileOversizeRejected += 1;
    }
    this.metrics.largeWriteRecoveries += 1;
  }

  recordToolProtocolFailure(toolName, details = {}) {
    this.metrics.toolArgumentsTruncated += 1;
    this.metrics.largeWriteRecoveries += 1;
    if (details.repeated === true) {
      this.metrics.duplicateOversizedRetries += 1;
    }
    this.consecutiveNoNewInformation = 0;
    this.addEvent({
      iteration: details.iteration ?? null,
      tool: toolName,
      informationStatus: "tool_protocol_failure",
      category: "write_protocol",
    });
    this.log({
      event: "tool_protocol_failure",
      iteration: details.iteration ?? null,
      lastTool: toolName,
      informationStatus: "tool_protocol_failure",
      reason: details.repeated
        ? "duplicate_oversized_retry"
        : "tool_arguments_truncated",
    });
  }

  recordDuplicateOversizedRetry(toolName, details = {}) {
    this.metrics.duplicateOversizedRetries += 1;
    this.log({
      event: "large_write_retry_rejected",
      iteration: details.iteration ?? null,
      lastTool: toolName,
      informationStatus: "tool_protocol_failure",
      reason: "duplicate_oversized_retry",
    });
  }

  recordTaskCompletion(iteration, accepted, reason = null) {
    this.log({
      event: accepted ? "task_complete" : "task_complete_rejected",
      iteration,
      lastTool: "task_complete",
      informationStatus: "task_complete",
      reason,
    });
  }

  consumeTool(toolName, meta = {}, iteration = null) {
    let informationStatus = meta.informationStatus || "neutral";
    const category = meta.toolCategory || "other";
    const isExploration = ["read", "navigation", "search"].includes(category);
    this.metrics.toolCalls += 1;
    if (category === "write") this.metrics.writeToolCalls += 1;
    if (category === "write" && meta.succeeded === true) {
      this.metrics.successfulWriteToolCalls += 1;
    }
    if (category === "validation") this.metrics.validationCalls += 1;

    if (informationStatus === "tool_unavailable") {
      const attempts = (this.unavailableToolAttempts.get(toolName) || 0) + 1;
      this.unavailableToolAttempts.set(toolName, attempts);
      if (meta.errorCode === "UNKNOWN_TOOL") this.metrics.unknownToolCalls += 1;
      this.metrics.toolUnavailableRecoveries += 1;
      this.addEvent({
        iteration,
        tool: toolName,
        informationStatus,
        category: "capability",
      });
      console.info("[NCE Agent capability]", {
        tool: toolName || null,
        available: false,
        action:
          attempts > 1
            ? "reject_repeated_request"
            : "request_registered_tool",
      });
      this.logTool(
        iteration,
        toolName,
        informationStatus,
        "capability_recovery",
      );
      return {
        action: "directive",
        level: attempts > 1 ? 2 : 1,
        content: this.getUnavailableToolDirective(toolName, attempts),
      };
    }

    if (
      ["error", "error_discovered"].includes(informationStatus) &&
      meta.informationSignature
    ) {
      if (this.observedInformationSignatures.has(meta.informationSignature)) {
        informationStatus = "already_known";
      } else {
        this.observedInformationSignatures.add(meta.informationSignature);
        informationStatus = "error_discovered";
      }
    }
    if (
      informationStatus === "validation_progress" &&
      this.activeErrorCategory === "validation"
    ) {
      informationStatus = "error_resolved";
    }
    this.addEvent({
      iteration,
      tool: toolName,
      informationStatus,
      category,
    });

    if (informationStatus === "task_complete") {
      this.metrics.taskCompleteCalls += 1;
      this.recordTaskProgress();
      return { action: "task_complete" };
    }

    if (informationStatus === "state_changed") {
      this.metrics.stateChangedToolCalls += 1;
      if (this.awaitingFix) this.metrics.fixIterations += 1;
      const validationRetestPending =
        this.activeErrorCategory === "validation";
      this.writeOccurred = true;
      this.blockingError = validationRetestPending;
      this.awaitingFix = false;
      this.activeErrorCategory = validationRetestPending
        ? "validation"
        : null;
      this.recordTaskProgress();
      this.setPhase("implement", {
        iteration,
        lastTool: toolName,
        informationStatus,
      });
      this.logTool(iteration, toolName, informationStatus, "progress");
      return { action: "progress", clearDirectives: true };
    }

    if (informationStatus === "restored") {
      this.metrics.restoredInformationToolCalls += 1;
      this.consecutiveNoNewInformation = 0;
      const exploration = this.observeExploration(
        iteration,
        toolName,
        informationStatus,
      );
      this.logTool(iteration, toolName, informationStatus, "information_gain");
      return exploration;
    }

    if (
      [
        "new",
        "validation_progress",
        "error_discovered",
        "error_resolved",
      ].includes(informationStatus)
    ) {
      this.metrics.newInformationToolCalls += 1;
      if (this.writeOccurred && isExploration) {
        this.metrics.staticValidationActions += 1;
      }
      if (informationStatus === "error_discovered") {
        this.blockingError = true;
        this.activeErrorCategory = category;
        this.awaitingFix = ["write", "validation"].includes(category);
        if (category === "validation") this.metrics.validationFailures += 1;
      } else if (category === "validation") {
        this.blockingError = false;
        this.awaitingFix = false;
        this.activeErrorCategory = null;
      } else if (this.activeErrorCategory === category) {
        this.blockingError = false;
        this.activeErrorCategory = null;
      }
      if (isExploration) {
        this.consecutiveNoNewInformation = 0;
        this.usefulInspectionCount += 1;
        this.setPhase("understand", {
          iteration,
          lastTool: toolName,
          informationStatus,
        });
        const exploration = this.observeExploration(
          iteration,
          toolName,
          informationStatus,
        );
        this.logTool(
          iteration,
          toolName,
          informationStatus,
          "information_gain",
        );
        return exploration;
      }
      this.recordTaskProgress();
      if (category === "validation") {
        this.setPhase("verify", {
          iteration,
          lastTool: toolName,
          informationStatus,
        });
      }
      this.logTool(iteration, toolName, informationStatus, "progress");
      return { action: "progress", clearDirectives: true };
    }

    if (informationStatus === "repeated_redundant") {
      this.metrics.noNewInformationToolCalls += 1;
      this.metrics.repeatedRedundantActions += 1;
      this.consecutiveNoNewInformation += 1;
      if (isExploration) this.recordExplorationAction();
      this.logTool(iteration, toolName, informationStatus, "recovery");
      return this.triggerStagnation(
        iteration,
        toolName,
        informationStatus,
        "repeated_redundant_action",
      );
    }

    if (informationStatus === "already_known") {
      this.metrics.noNewInformationToolCalls += 1;
      this.consecutiveNoNewInformation += 1;
      if (isExploration) this.recordExplorationAction();
      this.logTool(iteration, toolName, informationStatus, "observe");
      if (
        this.awaitingProgress ||
        this.consecutiveNoNewInformation >= this.noInformationThreshold
      ) {
        return this.triggerStagnation(iteration, toolName, informationStatus);
      }
      return { action: "none" };
    }

    this.consecutiveNoNewInformation = 0;
    this.logTool(iteration, toolName, informationStatus, "neutral");
    return { action: "none" };
  }

  recordExplorationAction() {
    this.metrics.explorationActions += 1;
    this.consecutiveExplorationActions += 1;
    this.consecutiveExplorationPeak = Math.max(
      this.consecutiveExplorationPeak,
      this.consecutiveExplorationActions,
    );
  }

  observeExploration(iteration, toolName, informationStatus) {
    this.recordExplorationAction();
    const nextSignalAt =
      this.overExplorationThreshold +
      this.overExplorationLevel * this.overExplorationEscalationInterval;
    if (
      this.overExplorationLevel >= 2 ||
      this.consecutiveExplorationActions < nextSignalAt
    ) {
      return { action: "information", informationGain: true };
    }
    this.overExplorationLevel += 1;
    this.metrics.overExplorationSignals += 1;
    this.metrics.recoveryDirectives += 1;
    this.log({
      event: "over_exploration",
      iteration,
      lastTool: toolName,
      informationStatus,
      reason: "exploration_without_task_progress",
      level: this.overExplorationLevel,
    });
    return {
      action: "directive",
      level: this.overExplorationLevel,
      content: this.getOverExplorationDirective(this.overExplorationLevel),
    };
  }

  recordTaskProgress() {
    this.metrics.taskProgressActions += 1;
    this.consecutiveExplorationActions = 0;
    this.overExplorationLevel = 0;
    this.resetStagnation();
  }

  handleModelNoAction(details = {}) {
    if (!this.awaitingProgress || details.hasToolCalls) {
      return { action: "none" };
    }
    const needsAction =
      details.hasReasoning ||
      (this.requiresModification && !this.writeOccurred && details.hasText);
    if (!needsAction) return { action: "none" };
    return this.triggerStagnation(
      details.iteration ?? null,
      null,
      "no_action",
    );
  }

  triggerStagnation(
    iteration,
    toolName,
    informationStatus,
    reason = "repeated_no_new_information",
  ) {
    if (!this.stagnationDetected) {
      this.stagnationDetected = true;
      this.metrics.stagnationEvents += 1;
    }
    if (this.stagnationRecoveryLevel >= this.maxStagnationRecoveries) {
      if (!this.recoveryObservationLogged) {
        this.recoveryObservationLogged = true;
        this.log({
          event: "recovery_observation",
          iteration,
          lastTool: toolName,
          informationStatus,
          reason,
        });
      }
      return { action: "none", reason: "recovery_observing" };
    }
    this.stagnationRecoveryLevel += 1;
    this.metrics.stagnationRecoveries += 1;
    this.metrics.recoveryDirectives += 1;
    this.consecutiveNoNewInformation = 0;
    this.awaitingProgress = true;
    const level = this.stagnationRecoveryLevel;
    this.log({
      event: "recovery",
      iteration,
      lastTool: toolName,
      informationStatus,
      reason,
      level,
    });
    return {
      action: "directive",
      level,
      content:
        reason === "repeated_redundant_action"
          ? this.getRepeatedRedundantDirective(level)
          : this.getDirective(level),
    };
  }

  getRepeatedRedundantDirective(level) {
    const strategy =
      level >= 2
        ? " Choose the most plausible implementation and validate it; if it fails, use the concrete failure to guide the next investigation."
        : " If you have a plausible implementation path, make the smallest coherent attempt and validate it.";
    return (
      "[NCE PROGRESS DIRECTIVE] This exact inspection is redundant and cannot provide new information. Do not repeat it. Use the project information already available." +
      strategy +
      " Otherwise inspect only a specific missing piece of information."
    );
  }

  getUnavailableToolDirective(toolName, attempts = 1) {
    const available = this.agent?.getAvailableToolNames?.() || [];
    const registered = available.length
      ? ` Registered tools: ${available.join(", ")}.`
      : " No tools are currently registered for this run.";
    if (attempts > 1) {
      return (
        `[NCE CAPABILITY] ${toolName || "The requested tool"} is not available and retrying it cannot succeed. ` +
        "Do not request it again in this run. Complete the task using the available repository tools and reasonable static verification." +
        registered
      );
    }
    return (
      `[NCE CAPABILITY] ${toolName || "The requested tool"} is unavailable. ` +
      "Use the registered tools instead and adapt validation to the capabilities of this environment." +
      registered
    );
  }

  getOverExplorationDirective(level) {
    if (level >= 2) {
      return (
        "[NCE PROGRESS DIRECTIVE] You are continuing broad exploration " +
        "without attempting the requested work. Choose the most plausible " +
        "implementation based on the information already available and try " +
        "it. Do not eliminate every uncertainty before acting. If it fails, " +
        "use the actual failure to guide further investigation."
      );
    }
    return (
      "[NCE PROGRESS DIRECTIVE] You have gathered substantial project " +
      "context. Do not continue broad exploration merely to increase " +
      "confidence. Unless a concrete unresolved question blocks " +
      "implementation, make the smallest coherent implementation attempt " +
      "now and validate it."
    );
  }

  getDirective(level) {
    if (level >= 2) {
      return (
        "[NCE PROGRESS DIRECTIVE] You are repeating actions that do not " +
        "provide new information. Change strategy: implement a plausible " +
        "solution, run validation, inspect one specific missing area, or " +
        "diagnose a concrete blocker. Do not repeat unchanged inspections."
      );
    }
    return (
      "[NCE PROGRESS DIRECTIVE] The recent actions did not add new " +
      "information. Use the project knowledge already available and try a " +
      "different useful action."
    );
  }

  resetStagnation() {
    this.consecutiveNoNewInformation = 0;
    this.stagnationRecoveryLevel = 0;
    this.awaitingProgress = false;
    this.stagnationDetected = false;
    this.recoveryObservationLogged = false;
  }

  logTool(iteration, lastTool, informationStatus, action) {
    this.log({
      event: "tool_result",
      iteration,
      lastTool,
      informationStatus,
      action,
    });
  }

  log(details = {}) {
    console.info("[NCE Agent progress]", {
      event: details.event || "observation",
      iteration: details.iteration ?? null,
      phase: this.phase,
      lastTool: details.lastTool || null,
      informationStatus: details.informationStatus || null,
      consecutiveNoNewInformation: this.consecutiveNoNewInformation,
      consecutiveExplorationActions: this.consecutiveExplorationActions,
      consecutiveExplorationPeak: this.consecutiveExplorationPeak,
      overExplorationLevel: this.overExplorationLevel,
      recovery: this.stagnationRecoveryLevel,
      action: details.action || "observe",
      ...(details.reason ? { reason: details.reason } : {}),
      ...(Number.isInteger(details.level) ? { level: details.level } : {}),
      ...(details.previousPhase
        ? { previousPhase: details.previousPhase }
        : {}),
    });
  }

  getContextState() {
    return {
      phase: this.phase,
      consecutiveNoNewInformation: this.consecutiveNoNewInformation,
      consecutiveExplorationActions: this.consecutiveExplorationActions,
      consecutiveExplorationPeak: this.consecutiveExplorationPeak,
      overExplorationLevel: this.overExplorationLevel,
      stagnationRecoveryLevel: this.stagnationRecoveryLevel,
      awaitingProgress: this.awaitingProgress,
      blockingError: this.blockingError,
      awaitingFix: this.awaitingFix,
      activeErrorCategory: this.activeErrorCategory,
    };
  }

  getMetrics() {
    const readMetrics = this.agent.fileKnowledge?.getMetrics?.() || {};
    return {
      ...this.metrics,
      readRequests: readMetrics.readFileCalls || 0,
      actualReads: readMetrics.actualFileReads || 0,
      actualDiskReads: readMetrics.actualDiskReads || 0,
      actualFilesystemReads: readMetrics.actualFilesystemReads || 0,
      cachedReads: readMetrics.cachedFileReads || 0,
      alreadyVisibleReads: readMetrics.alreadyVisibleReads || 0,
      restoredReads: readMetrics.restoredReads || 0,
      restoredCharacters: readMetrics.restoredCharacters || 0,
      cacheHits: readMetrics.cacheHits || 0,
      cacheMisses: readMetrics.cacheMisses || 0,
      newRangeReads: readMetrics.newRangeReads || 0,
      revisionReads: readMetrics.revisionRereads || 0,
      duplicateReadRequests: readMetrics.duplicateReadAttempts || 0,
      duplicateReads: readMetrics.duplicateReadAttempts || 0,
      repeatedDuplicateReads: readMetrics.repeatedDuplicateReads || 0,
      consecutiveExplorationPeak: this.consecutiveExplorationPeak,
      projectMapRequests: readMetrics.projectMapCalls || 0,
      projectMapCalls: readMetrics.projectMapCalls || 0,
      searchCalls: readMetrics.searchProjectFilesCalls || 0,
      actualProjectMapBuilds: readMetrics.actualProjectMapBuilds || 0,
      cachedProjectMaps: readMetrics.cachedProjectMaps || 0,
      readCalls: readMetrics.readFileCalls || 0,
      writes: this.metrics.writeToolCalls,
      successfulWrites: this.metrics.successfulWriteToolCalls,
      progressRecoveries: this.metrics.stagnationRecoveries,
      estimatedPromptTokens: this.agent.lastContextMetrics?.estimatedModelTokens || 0,
      actualPromptTokens: this.agent.lastContextMetrics?.actualPromptTokens || 0,
      cumulativeEstimatedPromptTokens:
        this.agent.cumulativeEstimatedPromptTokens || 0,
      cumulativeActualPromptTokens:
        this.agent.cumulativeActualPromptTokens || 0,
      contextCompactions:
        this.agent.contextManager?.compactionState?.compactionGeneration || 0,
    };
  }
}

window.AgentProgress = AgentProgress;
