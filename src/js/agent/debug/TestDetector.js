class TestDetector {
  constructor(agent) {
    this.agent = agent;
  }

  normalize(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  }

  async readWorkspaceFile(relativePath) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const absolute = this.agent.resolveWorkspacePath(relativePath, root);
    if (!absolute || typeof this.agent.api?.getFileContent !== "function")
      return null;
    const contents = await this.agent.api.getFileContent([absolute]);
    return typeof contents?.[absolute] === "string" ? contents[absolute] : null;
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
    if (exact)
      return {
        relativePath: requested,
        file: exact.type === "file" || exact.isDirectory !== true,
        explicit: true,
      };
    return entries.some((entry) => this.isInside(entry.relativePath, requested))
      ? { relativePath: requested, file: false, explicit: true }
      : null;
  }

  getCandidates(requestedPath, entries) {
    const requested = this.normalize(requestedPath).toLowerCase();
    const requestedBase = requested.split("/").pop() || "";
    const extension = requestedBase.includes(".")
      ? requestedBase.slice(requestedBase.lastIndexOf("."))
      : "";
    const activePath = this.normalize(
      this.agent.editor?.tabManager?.activeFile?.path || "",
    ).toLowerCase();
    const modified = new Set(
      [...(this.agent.runChangeTracker?.current?.changes?.keys?.() || [])].map(
        (path) => this.normalize(path).toLowerCase(),
      ),
    );
    return entries
      .filter((entry) => entry.type === "file" || entry.isDirectory !== true)
      .map((entry) => {
        const path = entry.relativePath;
        const lower = path.toLowerCase();
        const base = lower.split("/").pop() || "";
        let score = 0;
        if (lower === requested) score += 100;
        if (modified.has(lower)) score += 80;
        if (activePath.endsWith(`/${lower}`) || activePath === lower)
          score += 70;
        if (
          /(^|\/)(test|tests|spec)[^/]*\./.test(lower) ||
          /\.(test|spec)\./.test(lower)
        )
          score += 30;
        if (extension && lower.endsWith(extension)) score += 20;
        if (
          requestedBase &&
          (base.includes(requestedBase) || requestedBase.includes(base))
        )
          score += 25;
        return { path, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.path.localeCompare(right.path),
      )
      .slice(0, 5)
      .map((candidate) => candidate.path);
  }

  marker(relativePath) {
    return [
      "package.json",
      "pyproject.toml",
      "pytest.ini",
      "setup.cfg",
      "tox.ini",
      "composer.json",
      "phpunit.xml",
      "phpunit.xml.dist",
    ].includes(relativePath);
  }

  findProjectRoots(entries) {
    const roots = new Set();
    for (const entry of entries) {
      const parts = entry.relativePath.split("/");
      for (let index = 0; index < parts.length; index += 1) {
        if (this.marker(parts.slice(index).join("/")))
          roots.add(parts.slice(0, index).join("/"));
      }
    }
    return [...roots].sort((a, b) => a.split("/").length - b.split("/").length);
  }

  findNearestRoot(target, roots) {
    const directory = target.file
      ? target.relativePath.split("/").slice(0, -1).join("/")
      : target.relativePath;
    return (
      roots
        .filter((root) => this.isInside(directory, root))
        .sort((a, b) => b.length - a.length)[0] || ""
    );
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

  localLock(entries, projectRoot) {
    const names = [
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "npm-shrinkwrap.json",
    ];
    return (
      names.find((name) =>
        entries.some(
          (entry) =>
            entry.relativePath ===
            `${projectRoot ? `${projectRoot}/` : ""}${name}`,
        ),
      ) || null
    );
  }

  ready(strategy, projectRoot, target, explicit) {
    return {
      status: "READY",
      strategy,
      runner: strategy,
      projectRoot,
      cwd: projectRoot,
      target: target || null,
      scope: {
        mode: explicit ? "target" : "project",
        projectRoot,
        target: target || null,
      },
    };
  }

  async detect(request = {}) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (!root) return { status: "NO_WORKSPACE", tests: [] };
    const entries = this.getEntries(
      await this.agent.api?.listProjectFiles?.(root),
    );
    const target = this.getTarget(request.path, entries);
    if (!target) {
      const candidates = this.getCandidates(request.path, entries);
      return {
        status: "INVALID_TARGET",
        requestedTarget: this.normalize(request.path),
        candidates,
        suggestion: candidates[0]
          ? { tool: "run_tests", path: candidates[0] }
          : null,
        reason: "Target does not exist in the workspace.",
        tests: [],
      };
    }
    const roots = this.findProjectRoots(entries);
    let projectRoot = target.explicit
      ? this.findNearestRoot(target, roots)
      : "";
    if (!target.explicit) {
      const rootPackage = await this.packageInfo("");
      if (
        rootPackage?.scripts?.test &&
        !this.isPlaceholder(rootPackage.scripts.test)
      )
        projectRoot = "";
      else if (roots.length === 1) projectRoot = roots[0];
      else if (roots.length > 1)
        return { status: "MULTIPLE_PROJECTS", projects: roots };
    }
    const prefix = projectRoot ? `${projectRoot}/` : "";
    const scoped = entries.filter((entry) =>
      this.isInside(entry.relativePath, projectRoot),
    );
    const packageJson = await this.packageInfo(projectRoot);
    if (packageJson?.__invalid)
      return { status: "INVALID_CONFIG", projectRoot };
    const targetPath = target.relativePath;
    const extension = targetPath.split(".").pop()?.toLowerCase();
    const script = packageJson?.scripts?.test;
    if (typeof script === "string" && !this.isPlaceholder(script)) {
      const lock = this.localLock(entries, projectRoot);
      const strategy =
        lock === "pnpm-lock.yaml"
          ? "pnpm-test"
          : lock === "yarn.lock"
            ? "yarn-test"
            : lock?.startsWith("bun.")
              ? "bun-test"
              : "npm-test";
      return this.ready(strategy, projectRoot, targetPath, target.explicit);
    }
    const nodeTests = scoped.some((entry) =>
      /\.(test|spec)\.(js|cjs|mjs)$/.test(entry.relativePath),
    );
    if (
      (target.explicit && /\.(test|spec)\.(js|cjs|mjs)$/.test(targetPath)) ||
      (!target.explicit && nodeTests)
    )
      return this.ready("node-test", projectRoot, targetPath, target.explicit);
    if (extension === "ts" || extension === "tsx")
      return {
        status: "NO_TEST_RUNNER",
        projectRoot,
        target: targetPath,
        reason: "TYPESCRIPT_RUNNER_UNAVAILABLE",
      };
    const pythonTests = scoped.some((entry) =>
      /(^|\/)(test[^/]*|tests?\/).+\.py$/.test(entry.relativePath),
    );
    if (
      (target.explicit && extension === "py") ||
      pythonTests ||
      scoped.some((entry) =>
        ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].includes(
          entry.relativePath.slice(prefix.length),
        ),
      )
    ) {
      const text = targetPath ? await this.readWorkspaceFile(targetPath) : "";
      const unittest = /(?:^|\n)\s*(?:import|from)\s+unittest\b/.test(
        text || "",
      );
      const pytest = scoped.some((entry) =>
        ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].includes(
          entry.relativePath.slice(prefix.length),
        ),
      );
      return this.ready(
        unittest
          ? "python-unittest"
          : pytest
            ? "python-pytest"
            : target.explicit
              ? "python-script"
              : "python-unittest",
        projectRoot,
        targetPath,
        target.explicit,
      );
    }
    const phpTests = scoped.some((entry) =>
      /(?:phpunit\.xml(?:\.dist)?|Test\.php)$/.test(entry.relativePath),
    );
    if (
      (target.explicit && extension === "php") ||
      phpTests ||
      packageJson?.require?.phpunit
    ) {
      const strategy =
        target.explicit && extension === "php"
          ? "php-script"
          : scoped.some(
                (entry) => entry.relativePath === `${prefix}vendor/bin/phpunit`,
              )
            ? "phpunit"
            : "composer-test";
      return this.ready(strategy, projectRoot, targetPath, target.explicit);
    }
    return {
      status: "NO_TEST_RUNNER",
      projectRoot,
      target: targetPath || null,
      tests: [],
    };
  }
}

window.TestDetector = TestDetector;
