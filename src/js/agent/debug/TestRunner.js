class TestRunner {
  constructor(agent) {
    this.agent = agent;
    this.detector = new TestDetector(agent);
  }

  async run(request = {}) {
    const detection = await this.detector.detect(request);
    if (detection.status !== "READY") {
      return TestResultNormalizer.normalize(null, detection);
    }
    const limits = this.agent.toolLimits?.run_tests || {};
    const processResult = await this.agent.api.runAgentProcess({
      executable: detection.executable,
      args: detection.args,
      cwd: detection.cwd,
      workspaceRoot: this.agent.editor?.fileExplorer?.rootPath,
      timeoutMs: limits.timeoutMs,
      maxOutputCharacters: limits.outputCharacters,
    });
    return TestResultNormalizer.normalize(processResult, detection);
  }
}

window.TestRunner = TestRunner;