class TestResultNormalizer {
  static normalize(processResult, detection, outputLimit = 12000) {
    const status =
      detection.status !== "READY"
        ? detection.status
        : processResult?.timedOut
          ? "TIMEOUT"
          : ["ENOENT", "RUNTIME_UNAVAILABLE"].includes(
                processResult?.error?.code,
              )
            ? "RUNTIME_UNAVAILABLE"
            : processResult?.success === false
              ? "EXECUTION_ERROR"
              : processResult?.exitCode === 0
                ? "PASSED"
                : "FAILED";
    const raw = [processResult?.stdout, processResult?.stderr]
      .filter(Boolean)
      .join("\n");
    const parsed = TestOutputParser.summarize(raw, status);
    const bounded = TestOutputParser.headTail(raw, outputLimit);
    const available =
      ["PASSED", "FAILED", "TIMEOUT"].includes(status) ||
      status === "EXECUTION_ERROR";
    const result = {
      success: true,
      status,
      validationKind:
        detection.validationKind ||
        (["python-script", "php-script"].includes(detection.strategy)
          ? "smoke"
          : "test"),
      validation: {
        attempted:
          status !== "UNSAVED_CHANGES" &&
          status !== "NO_TEST_RUNNER" &&
          status !== "NO_TEST_ENVIRONMENT" &&
          status !== "NO_TESTS" &&
          status !== "MULTIPLE_PROJECTS" &&
          status !== "RUNTIME_UNAVAILABLE" &&
          status !== "DEPENDENCIES_UNAVAILABLE",
        available,
        passed: status === "PASSED",
        blocking: status !== "PASSED",
      },
      ecosystem: detection.ecosystem || null,
      runner: detection.runner
        ? { name: detection.runner, strategy: detection.strategy }
        : detection.strategy
          ? {
              name: detection.runner || detection.strategy,
              strategy: detection.strategy,
            }
          : null,
      strategy: detection.strategy || null,
      projectRoot: detection.projectRoot || ".",
      cwd: detection.cwd || detection.projectRoot || ".",
      target: detection.target || null,
      scope: {
        ...(detection.scope || {}),
        mode:
          detection.scope?.mode || (detection.target ? "target" : "project"),
        projectRoot:
          detection.scope?.projectRoot || detection.projectRoot || ".",
        target: detection.scope?.target || detection.target || null,
      },
      runtime: processResult?.runtime || null,
      exitCode: processResult?.exitCode ?? null,
      signal: processResult?.signal ?? null,
      durationMs: processResult?.durationMs ?? 0,
      summary: parsed.summary,
      failures: parsed.failures,
      output: bounded.text,
      outputHead: bounded.head,
      outputTail: bounded.tail,
      truncated: Boolean(processResult?.truncated || bounded.truncated),
      reason:
        detection.reason ||
        (status === "UNSAVED_CHANGES"
          ? "Files have unsaved editor changes."
          : null),
    };
    if (detection.dirtyPaths) result.dirtyPaths = detection.dirtyPaths;
    if (Array.isArray(detection.projects)) result.projects = detection.projects;
    if (detection.requestedTarget)
      result.requestedTarget = detection.requestedTarget;
    if (Array.isArray(detection.candidates))
      result.candidates = detection.candidates;
    if (detection.suggestion) result.suggestion = detection.suggestion;
    if (Array.isArray(detection.detectedLanguages))
      result.detectedLanguages = detection.detectedLanguages;
    if (Array.isArray(detection.standalone))
      result.standalone = detection.standalone;
    if (detection.suggestedAction)
      result.suggestedAction = detection.suggestedAction;
    if (processResult?.error) result.error = processResult.error;
    console.info("[NCE Agent run_tests]", {
      status,
      runner: result.runner?.name || null,
      strategy: result.strategy,
      projectRoot: result.projectRoot,
      target: result.target,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      passed: result.summary.passed,
      failed: result.summary.failed,
      truncated: result.truncated,
    });
    return result;
  }
}

window.TestResultNormalizer = TestResultNormalizer;
