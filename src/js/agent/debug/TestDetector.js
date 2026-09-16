class TestDetector {
  constructor(agent) {
    this.agent = agent;
  }

  async readWorkspaceFile(relativePath) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const absolute = this.agent.resolveWorkspacePath(relativePath, root);
    if (!absolute || typeof this.agent.api?.getFileContent !== "function") return null;
    const contents = await this.agent.api.getFileContent([absolute]);
    return typeof contents?.[absolute] === "string" ? contents[absolute] : null;
  }

  async detect(request = {}) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (!root) return { status: "NO_WORKSPACE", tests: [] };
    const packageText = await this.readWorkspaceFile("package.json");
    let packageJson = null;
    try {
      packageJson = packageText ? JSON.parse(packageText) : null;
    } catch {
      return { status: "INVALID_CONFIG", tests: [] };
    }
    const files = await this.agent.api?.listProjectFiles?.(root);
    const entries = Array.isArray(files?.entries) ? files.entries : [];
    const requestedPath = typeof request.path === "string" ? request.path.trim() : "";
    const cwd = requestedPath
      ? this.agent.resolveWorkspacePath(requestedPath, root)
      : root;
    if (!cwd) return { status: "INVALID_PATH", tests: [] };

    const scripts = packageJson?.scripts || {};
    const testScript = typeof scripts.test === "string" &&
      scripts.test.trim() && !/^echo\s+(Error|No test specified)/i.test(scripts.test.trim());
    if (testScript) {
      const manager = entries.some((entry) => /(^|\/)pnpm-lock\.yaml$/.test(entry.relativePath))
        ? "pnpm"
        : entries.some((entry) => /(^|\/)yarn\.lock$/.test(entry.relativePath))
          ? "yarn"
          : "npm";
      return { status: "READY", cwd, executable: manager === "npm" && this.agent.api.platform === "win32" ? "npm.cmd" : manager, args: ["run", "test"] };
    }
    const nodeTests = entries.filter((entry) => /\.(test|spec)\.(js|cjs|mjs|ts|tsx)$/.test(entry.relativePath));
    if (nodeTests.length) {
      return { status: "READY", cwd, executable: this.agent.api.platform === "win32" ? "node.exe" : "node", args: ["--test"] };
    }
    const pythonTests = entries.filter((entry) => /(^|\/)(test[^/]*|tests?\/).+\.py$/.test(entry.relativePath));
    if (pythonTests.length) {
      return { status: "READY", cwd, executable: this.agent.api.platform === "win32" ? "python.exe" : "python3", args: ["-m", "pytest"] };
    }
    const phpTests = entries.filter((entry) => /(^|\/)phpunit\.xml(?:\.dist)?$|(^|\/).*Test\.php$/.test(entry.relativePath));
    if (phpTests.length) {
      return { status: "READY", cwd, executable: "php", args: ["vendor/bin/phpunit"] };
    }
    return { status: "NO_TEST_RUNNER", cwd, tests: [] };
  }
}

window.TestDetector = TestDetector;