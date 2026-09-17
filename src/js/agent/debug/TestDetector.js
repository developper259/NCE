class TestDetector {
  constructor(agent) {
    this.agent = agent;
  }

  config() {
    return typeof AgentDebug !== "undefined" ? AgentDebug : { languages: {} };
  }

  normalize(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  }

  getEntries(files) {
    return (Array.isArray(files?.entries) ? files.entries : [])
      .map((entry) => ({
        ...entry,
        relativePath: this.normalize(entry.relativePath),
      }))
      .filter((entry) => entry.relativePath);
  }

  isInside(candidate, parent) {
    return (
      !parent || candidate === parent || candidate.startsWith(`${parent}/`)
    );
  }

  getTarget(requestedPath, entries) {
    const requested = this.normalize(requestedPath);
    if (!requested) return { relativePath: "", file: false, explicit: false };
    if (
      requested.startsWith("/") ||
      requested === ".." ||
      requested.includes("../")
    )
      return null;
    const exact = entries.find((entry) => entry.relativePath === requested);
    if (exact) {
      return {
        relativePath: requested,
        file: exact.type === "file" || exact.isDirectory !== true,
        explicit: true,
      };
    }
    return entries.some((entry) => this.isInside(entry.relativePath, requested))
      ? { relativePath: requested, file: false, explicit: true }
      : null;
  }

  findLanguageForFile(filePath) {
    const lower = this.normalize(filePath).toLowerCase();
    return (
      Object.values(this.config().languages || {}).find((language) =>
        (language.extensions || []).some((extension) =>
          lower.endsWith(String(extension).toLowerCase()),
        ),
      ) || null
    );
  }

  patternMatches(filePath, pattern) {
    const value = this.normalize(filePath).split("/").pop() || "";
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(value);
  }

  relativeToRoot(filePath, projectRoot) {
    const path = this.normalize(filePath);
    if (!projectRoot) return path;
    return path === projectRoot
      ? ""
      : path.startsWith(`${projectRoot}/`)
        ? path.slice(projectRoot.length + 1)
        : path;
  }

  async readWorkspaceFile(relativePath) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const absolute = this.agent.resolveWorkspacePath(relativePath, root);
    if (!absolute || typeof this.agent.api?.getFileContent !== "function")
      return null;
    const contents = await this.agent.api.getFileContent([absolute]);
    return typeof contents?.[absolute] === "string" ? contents[absolute] : null;
  }

  async packageInfo(projectRoot) {
    const text = await this.readWorkspaceFile(
      `${projectRoot ? `${projectRoot}/` : ""}package.json`,
    );
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { __invalid: true };
    }
  }

  isPlaceholder(script) {
    return (
      typeof script !== "string" ||
      !script.trim() ||
      (/echo/i.test(script) && /no test specified|error:/i.test(script))
    );
  }

  localLock(entries, projectRoot, language) {
    const scoped = entries.map((entry) =>
      this.relativeToRoot(entry.relativePath, projectRoot),
    );
    return (language.testEnvironment?.packageManagers || []).find((manager) =>
      (manager.lockfiles || []).some((lockfile) => scoped.includes(lockfile)),
    );
  }

  languageHasEnvironment(language, entries, projectRoot, packageJson) {
    const environment = language.testEnvironment || {};
    const scoped = entries
      .map((entry) => this.relativeToRoot(entry.relativePath, projectRoot))
      .filter(Boolean);
    const hasLanguageFile = entries.some(
      (entry) =>
        this.findLanguageForFile(entry.relativePath)?.id === language.id,
    );
    if (scoped.some((entry) => (environment.markers || []).includes(entry)))
      return true;
    if (
      hasLanguageFile &&
      scoped.some((entry) =>
        (environment.directories || []).some(
          (directory) =>
            entry === directory || entry.startsWith(`${directory}/`),
        ),
      )
    )
      return true;
    if (
      scoped.some((entry) =>
        (environment.filePatterns || []).some((pattern) =>
          this.patternMatches(entry, pattern),
        ),
      )
    )
      return true;
    if (language.id === "javascript")
      return Boolean(
        packageJson?.scripts?.test &&
        !this.isPlaceholder(packageJson.scripts.test),
      );
    if (language.id === "php")
      return Boolean(
        packageJson?.require?.phpunit ||
        packageJson?.requireDev?.phpunit ||
        (packageJson?.scripts?.test &&
          (packageJson?.require?.php || packageJson?.requireDev?.php)),
      );
    return false;
  }

  findProjectRoots(entries) {
    const roots = new Set();
    for (const entry of entries) {
      const parts = entry.relativePath.split("/");
      const base = parts[parts.length - 1];
      for (const language of Object.values(this.config().languages || {})) {
        const environment = language.testEnvironment || {};
        if ((environment.markers || []).includes(base))
          roots.add(parts.slice(0, -1).join("/"));
        const hasConfiguredDirectory = parts.some((part) =>
          (environment.directories || []).includes(part),
        );
        if (
          !hasConfiguredDirectory &&
          (environment.filePatterns || []).some((pattern) =>
            this.patternMatches(base, pattern),
          )
        )
          roots.add(parts.slice(0, -1).join("/"));
        for (let index = 0; index < parts.length; index += 1) {
          if ((environment.directories || []).includes(parts[index]))
            roots.add(parts.slice(0, index).join("/"));
        }
      }
    }
    return [...roots].sort((left, right) => left.length - right.length);
  }

  findNearestRoot(target, roots) {
    const directory = target.file
      ? target.relativePath.split("/").slice(0, -1).join("/")
      : target.relativePath;
    return (
      roots
        .filter((root) => this.isInside(directory, root))
        .sort((left, right) => right.length - left.length)[0] || ""
    );
  }

  getLanguagesInScope(entries, projectRoot) {
    return Object.values(this.config().languages || {})
      .filter((language) =>
        entries.some(
          (entry) =>
            this.isInside(entry.relativePath, projectRoot) &&
            this.findLanguageForFile(entry.relativePath)?.id === language.id,
        ),
      )
      .map((language) => language.id);
  }

  standaloneInfo(entries, projectRoot) {
    return Object.values(this.config().languages || {})
      .filter((language) =>
        entries.some(
          (entry) =>
            this.isInside(entry.relativePath, projectRoot) &&
            this.findLanguageForFile(entry.relativePath)?.id === language.id,
        ),
      )
      .map((language) => ({
        language: language.id,
        strategy: language.standalone.strategy,
        available: true,
        runtimes: (language.runtime?.candidates || []).map((candidate) => ({
          id: candidate.id,
          executable: candidate.executable,
          source: candidate.source || "system",
        })),
        recommendation: language.standalone.recommendation,
      }));
  }

  noEnvironment(
    entries,
    projectRoot,
    reason = "No configured test environment was found.",
  ) {
    const standalone = this.standaloneInfo(entries, projectRoot);
    return {
      status: "NO_TEST_ENVIRONMENT",
      projectRoot: projectRoot || ".",
      target: null,
      detectedLanguages: this.getLanguagesInScope(entries, projectRoot),
      standalone,
      suggestedAction: {
        type: "CREATE_STANDALONE_TEST",
        message: `${reason} Create a standalone validation file with an available runtime, then call run_tests with its path. Use create_file; do not install dependencies.`,
        examples: standalone.map((entry) => ({
          language: entry.language,
          strategy: entry.strategy,
        })),
      },
      reason,
      tests: [],
    };
  }

  ready(strategy, projectRoot, target, explicit, language, validationKind) {
    return {
      status: "READY",
      strategy,
      runner: strategy,
      language: language?.id || null,
      validationKind: validationKind || "project-test",
      projectRoot: projectRoot || ".",
      cwd: projectRoot || ".",
      target: target || null,
      scope: {
        mode: explicit ? "target" : "project",
        projectRoot: projectRoot || ".",
        target: target || null,
      },
    };
  }

  async projectDetection(entries, projectRoot) {
    const scoped = entries.filter((entry) =>
      this.isInside(entry.relativePath, projectRoot),
    );
    const packageJson = await this.packageInfo(projectRoot);
    if (packageJson?.__invalid)
      return { status: "INVALID_CONFIG", projectRoot: projectRoot || "." };
    const javascript = this.config().languages?.javascript;
    if (
      javascript &&
      this.languageHasEnvironment(javascript, entries, projectRoot, packageJson)
    ) {
      const script = packageJson?.scripts?.test;
      const hasPackageMarker = scoped.some(
        (entry) =>
          this.relativeToRoot(entry.relativePath, projectRoot) ===
          "package.json",
      );
      if (!packageJson && hasPackageMarker)
        return this.ready(
          "npm-test",
          projectRoot,
          null,
          false,
          javascript,
          "project-test",
        );
      if (script && !this.isPlaceholder(script)) {
        const manager = packageJson.packageManager?.split?.("@")[0];
        const selected =
          (javascript.testEnvironment.packageManagers || []).find(
            (candidate) => candidate.id === manager,
          ) || this.localLock(entries, projectRoot, javascript);
        return this.ready(
          selected?.strategy || "npm-test",
          projectRoot,
          null,
          false,
          javascript,
          "project-test",
        );
      }
      if (
        scoped.some((entry) =>
          (javascript.testEnvironment.filePatterns || []).some((pattern) =>
            this.patternMatches(entry.relativePath, pattern),
          ),
        )
      )
        return this.ready(
          "node-test",
          projectRoot,
          null,
          false,
          javascript,
          "project-test",
        );
    }
    const php = this.config().languages?.php;
    if (
      php &&
      this.languageHasEnvironment(php, entries, projectRoot, packageJson)
    ) {
      const hasPhpUnit =
        scoped.some((entry) =>
          ["phpunit.xml", "phpunit.xml.dist"].includes(
            this.relativeToRoot(entry.relativePath, projectRoot),
          ),
        ) ||
        packageJson?.require?.phpunit ||
        packageJson?.requireDev?.phpunit;
      return this.ready(
        hasPhpUnit ? "phpunit" : "composer-test",
        projectRoot,
        null,
        false,
        php,
        "project-test",
      );
    }
    const python = this.config().languages?.python;
    if (
      python &&
      this.languageHasEnvironment(python, entries, projectRoot, null)
    ) {
      const hasMarker = scoped.some((entry) =>
        (python.testEnvironment.markers || []).includes(
          this.relativeToRoot(entry.relativePath, projectRoot),
        ),
      );
      return this.ready(
        hasMarker ? "python-pytest" : "python-unittest",
        projectRoot,
        null,
        false,
        python,
        "project-test",
      );
    }
    return this.noEnvironment(entries, projectRoot);
  }

  async detect(request = {}) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (!root) return { status: "NO_WORKSPACE", tests: [] };
    const entries = this.getEntries(
      await this.agent.api?.listProjectFiles?.(root),
    );
    const target = this.getTarget(request.path, entries);
    if (!target)
      return {
        status: "INVALID_TARGET",
        requestedTarget: this.normalize(request.path),
        candidates: [],
        suggestion: null,
        reason: "Target does not exist in the workspace.",
        tests: [],
      };
    const roots = this.findProjectRoots(entries);
    if (target.explicit && target.file) {
      const language = this.findLanguageForFile(target.relativePath);
      if (!language)
        return {
          status: "UNSUPPORTED_TARGET",
          projectRoot: this.findNearestRoot(target, roots) || ".",
          target: target.relativePath,
          reason: "No configured language supports this file extension.",
          tests: [],
        };
      return this.ready(
        language.standalone.strategy,
        this.findNearestRoot(target, roots),
        target.relativePath,
        true,
        language,
        language.standalone.validationKind,
      );
    }
    if (target.explicit && !target.file)
      return this.projectDetection(entries, target.relativePath);
    const candidates = [];
    for (const projectRoot of roots) {
      const detection = await this.projectDetection(entries, projectRoot);
      if (detection.status === "READY") candidates.push(detection);
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1)
      return {
        status: "MULTIPLE_PROJECTS",
        projects: candidates.map((item) => item.projectRoot),
      };
    const rootDetection = await this.projectDetection(entries, "");
    if (rootDetection.status !== "NO_TEST_ENVIRONMENT") return rootDetection;
    return rootDetection;
  }
}

window.TestDetector = TestDetector;
