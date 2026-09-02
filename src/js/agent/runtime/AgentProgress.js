class AgentProgress {
  constructor(agent) {
    this.agent = agent;
    this.noInformationThreshold = 2;
    this.maxStagnationRecoveries = 2;
    this.reset();
  }

  reset(options = {}) {
    this.requiresModification = options.requiresModification === true;
    this.phase = "discover";
    this.consecutiveNoNewInformation = 0;
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
    this.recentInformationEvents = [];
    this.metrics = {
      modelRequests: 0,
      modelAttempts: 0,
      toolCalls: 0,
      newInformationToolCalls: 0,
      noNewInformationToolCalls: 0,
      stateChangedToolCalls: 0,
      stagnationEvents: 0,
      stagnationRecoveries: 0,
      writeToolCalls: 0,
      validationCalls: 0,
      validationFailures: 0,
      fixIterations: 0,
      taskCompleteCalls: 0,
      totalIterations: 0,
      model429s: 0,
      modelRetries: 0,
      modelFallbacks: 0,
    };
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
    this.metrics.toolCalls += 1;
    if (category === "write") this.metrics.writeToolCalls += 1;
    if (category === "validation") this.metrics.validationCalls += 1;

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
      this.resetStagnation();
      this.setPhase("implement", {
        iteration,
        lastTool: toolName,
        informationStatus,
      });
      this.logTool(iteration, toolName, informationStatus, "progress");
      return { action: "progress", clearDirectives: true };
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
      this.resetStagnation();
      if (["read", "navigation", "search"].includes(category)) {
        this.usefulInspectionCount += 1;
        this.setPhase("understand", {
          iteration,
          lastTool: toolName,
          informationStatus,
        });
      } else if (category === "validation") {
        this.setPhase("verify", {
          iteration,
          lastTool: toolName,
          informationStatus,
        });
      }
      this.logTool(iteration, toolName, informationStatus, "progress");
      return { action: "progress", clearDirectives: true };
    }

    if (informationStatus === "already_known") {
      this.metrics.noNewInformationToolCalls += 1;
      this.consecutiveNoNewInformation += 1;
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

  triggerStagnation(iteration, toolName, informationStatus) {
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
          reason: "repeated_no_new_information",
        });
      }
      return { action: "none", reason: "recovery_observing" };
    }
    this.stagnationRecoveryLevel += 1;
    this.metrics.stagnationRecoveries += 1;
    this.consecutiveNoNewInformation = 0;
    this.awaitingProgress = true;
    const level = this.stagnationRecoveryLevel;
    this.log({
      event: "recovery",
      iteration,
      lastTool: toolName,
      informationStatus,
      reason: "repeated_no_new_information",
      level,
    });
    return {
      action: "directive",
      level,
      content: this.getDirective(level),
    };
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
      cachedReads: readMetrics.cachedFileReads || 0,
      duplicateReadRequests: readMetrics.duplicateReadAttempts || 0,
      projectMapRequests: readMetrics.projectMapCalls || 0,
      actualProjectMapBuilds: readMetrics.actualProjectMapBuilds || 0,
      cachedProjectMaps: readMetrics.cachedProjectMaps || 0,
      readCalls: readMetrics.readFileCalls || 0,
      writes: this.metrics.writeToolCalls,
      progressRecoveries: this.metrics.stagnationRecoveries,
    };
  }
}

window.AgentProgress = AgentProgress;
