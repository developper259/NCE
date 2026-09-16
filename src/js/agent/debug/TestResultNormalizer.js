class TestResultNormalizer {
  static normalize(processResult, detection) {
    if (detection.status !== "READY") {
      return { success: true, status: detection.status, tests: [], output: "" };
    }
    const output = [processResult.stdout, processResult.stderr].filter(Boolean).join("\n");
    const normalized = {
      success: true,
      status: processResult.timedOut
        ? "TIMEOUT"
        : processResult.exitCode === 0
          ? "PASSED"
          : "FAILED",
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      durationMs: processResult.durationMs,
      output,
      truncated: processResult.truncated,
      runner: { executable: detection.executable, args: detection.args },
    };
    if (processResult.error) normalized.error = processResult.error;
    return normalized;
  }
}

window.TestResultNormalizer = TestResultNormalizer;