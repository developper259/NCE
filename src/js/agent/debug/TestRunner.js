class TestRunner {
  constructor(agent) {
    this.agent = agent;
    this.detector = new TestDetector(agent);
    this.runtimeResolver = new RuntimeResolver(agent);
    this.requestCounter = 0;
  }

  relative(value) {
    const root = String(this.agent.editor?.fileExplorer?.rootPath || "")
      .replace(/\\/g, "/")
      .replace(/\/$/, "");
    const normalized = String(value || "").replace(/\\/g, "/");
    return normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length + 1)
      : normalized;
  }

  async dirtyPaths(detection) {
    const files = this.agent.editor?.tabManager?.files || [];
    const autoSave = this.agent.editor?.getAutoSaveState?.() === true;
    const relevant = [];
    for (const file of files) {
      if (!file?.path || file.isSaved === true) continue;
      const relative = this.relative(file.path);
      const inProject =
        !detection.projectRoot ||
        relative === detection.projectRoot ||
        relative.startsWith(`${detection.projectRoot}/`);
      const inTarget =
        !detection.target ||
        relative === detection.target ||
        relative.startsWith(`${detection.target}/`);
      if (inProject && inTarget) relevant.push({ file, relative });
    }
    if (autoSave)
      await Promise.all(
        relevant.map(({ file }) => file.saveQueue?.catch?.(() => false)),
      );
    const changed = [];
    for (const { file, relative } of relevant) {
      const absolute = this.agent.resolveWorkspacePath(
        relative,
        this.agent.editor?.fileExplorer?.rootPath,
      );
      const disk = await this.agent.api?.getFileContent?.([absolute]);
      const diskContent = disk?.[absolute];
      if (
        file.isSaved !== true ||
        typeof diskContent !== "string" ||
        diskContent !== file.serializeContent?.()
      )
        changed.push(relative);
    }
    return changed;
  }

  async run(request = {}) {
    const detection = await this.detector.detect(request);
    if (detection.status !== "READY")
      return TestResultNormalizer.normalize(
        null,
        detection,
        this.agent.toolLimits?.run_tests?.outputCharacters,
      );
    const dirty = await this.dirtyPaths(detection);
    if (dirty.length)
      return TestResultNormalizer.normalize(
        null,
        { ...detection, status: "UNSAVED_CHANGES", dirtyPaths: dirty },
        this.agent.toolLimits?.run_tests?.outputCharacters,
      );
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const limits = this.agent.toolLimits?.run_tests || {};
    const requestId = `${this.agent.runId || 0}:run-tests:${++this.requestCounter}`;
    this.agent.activeTestRequestId = requestId;
    try {
      const processResult = await this.agent.api.runAgentProcess({
        strategy: detection.strategy,
        projectRoot: this.agent.resolveWorkspacePath(
          detection.projectRoot || ".",
          root,
        ),
        cwd: this.agent.resolveWorkspacePath(
          detection.cwd || detection.projectRoot || ".",
          root,
        ),
        target: detection.target
          ? this.agent.resolveWorkspacePath(detection.target, root)
          : null,
        workspaceRoot: root,
        requestId,
        runId: this.agent.runId || null,
        timeoutMs: limits.timeoutMs,
        maxOutputCharacters: limits.outputCharacters,
      });
      return TestResultNormalizer.normalize(
        processResult,
        detection,
        limits.outputCharacters,
      );
    } finally {
      if (this.agent.activeTestRequestId === requestId)
        this.agent.activeTestRequestId = null;
    }
  }
}

window.TestRunner = TestRunner;
