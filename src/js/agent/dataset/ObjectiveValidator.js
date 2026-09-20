const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

class ObjectiveValidator {
  constructor(options = {}) {
    this.maxOutputChars = options.maxValidationOutputChars || 50000;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
  }
  resolve(root, candidate) {
    if (
      typeof candidate !== "string" ||
      !candidate ||
      path.isAbsolute(candidate)
    )
      throw new Error("validation path must be relative");
    const target = path.resolve(root, candidate);
    if (target !== root && !target.startsWith(root + path.sep))
      throw new Error("validation path escapes workspace");
    return target;
  }
  async validate({ task, workspaceRoot, diff }) {
    const startedAt = Date.now(),
      checks = [],
      validation = task.validation || {};
    for (const assertion of validation.assertions || [])
      checks.push(await this.check(assertion, workspaceRoot));
    const changed = [...diff.created, ...diff.modified, ...diff.deleted].map(
      (item) => item.path,
    );
    const matches = (candidate, rule) =>
      rule.endsWith("/") ? candidate.startsWith(rule) : candidate === rule;
    if (Array.isArray(validation.allowedChangedPaths)) {
      const invalid = changed.filter(
        (candidate) =>
          !validation.allowedChangedPaths.some((rule) =>
            matches(candidate, rule),
          ),
      );
      checks.push({
        type: "allowed_changed_paths",
        passed: invalid.length === 0,
        status: invalid.length ? "FAIL" : "PASS",
        details: { invalid, allowed: validation.allowedChangedPaths },
      });
    }
    if (Array.isArray(validation.forbiddenChangedPaths)) {
      const invalid = changed.filter((candidate) =>
        validation.forbiddenChangedPaths.some((rule) =>
          matches(candidate, rule),
        ),
      );
      checks.push({
        type: "forbidden_changed_paths",
        passed: invalid.length === 0,
        status: invalid.length ? "FAIL" : "PASS",
        details: { invalid, forbidden: validation.forbiddenChangedPaths },
      });
    }
    const failedChecks = checks.filter((check) => !check.passed).length;
    return {
      passed: failedChecks === 0,
      checks,
      failedChecks,
      durationMs: Date.now() - startedAt,
    };
  }
  async check(assertion, root) {
    const startedAt = Date.now();
    try {
      if (!assertion || typeof assertion.type !== "string")
        throw new Error("assertion.type is required");
      if (assertion.type === "command")
        return await this.command(assertion, root);
      const target = this.resolve(root, assertion.path);
      const realRoot = await fs.realpath(root);
      let exists = true;
      try {
        const real = await fs.realpath(target);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep))
          throw new Error("validation symlink escapes workspace");
      } catch (error) {
        if (error.code === "ENOENT") exists = false;
        else throw error;
      }
      let passed;
      if (assertion.type === "file_exists") passed = exists;
      else if (assertion.type === "file_not_exists") passed = !exists;
      else if (
        assertion.type === "file_contains" ||
        assertion.type === "file_not_contains"
      ) {
        if (typeof assertion.text !== "string")
          throw new Error("assertion.text is required");
        const content = exists ? await fs.readFile(target, "utf8") : "";
        passed =
          exists &&
          (assertion.type === "file_contains"
            ? content.includes(assertion.text)
            : !content.includes(assertion.text));
      } else throw new Error(`unsupported assertion type: ${assertion.type}`);
      return {
        type: assertion.type,
        path: assertion.path,
        passed,
        status: passed ? "PASS" : "FAIL",
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        type: assertion?.type || "unknown",
        passed: false,
        status: "ERROR",
        error: { message: error.message, code: error.code || null },
        durationMs: Date.now() - startedAt,
      };
    }
  }
  command(assertion, root) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      if (
        typeof assertion.command !== "string" ||
        !assertion.command ||
        !Array.isArray(assertion.args || [])
      )
        return resolve({
          type: "command",
          passed: false,
          status: "ERROR",
          error: { message: "command and structured args are required" },
          durationMs: 0,
        });
      const timeoutMs = Number.isFinite(assertion.timeoutMs)
        ? assertion.timeoutMs
        : this.defaultTimeoutMs;
      const child = spawn(assertion.command, assertion.args || [], {
        cwd: root,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        timedOut = false,
        settled = false;
      const collect = (current, chunk) =>
        (current + chunk).slice(0, this.maxOutputChars);
      child.stdout.on("data", (chunk) => {
        stdout = collect(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = collect(stderr, chunk);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      const finish = (exitCode, signal, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const passed = !error && !timedOut && exitCode === 0;
        resolve({
          type: "command",
          command: assertion.command,
          args: assertion.args || [],
          passed,
          status: error ? "ERROR" : passed ? "PASS" : "FAIL",
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          truncated:
            stdout.length >= this.maxOutputChars ||
            stderr.length >= this.maxOutputChars,
          durationMs: Date.now() - startedAt,
          ...(error
            ? { error: { message: error.message, code: error.code || null } }
            : {}),
        });
      };
      child.on("error", (error) => finish(null, null, error));
      child.on("close", (code, signal) => finish(code, signal));
    });
  }
}
module.exports = { ObjectiveValidator };
