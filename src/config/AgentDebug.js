/*
 * Declarative debug configuration.
 * To add an interpreted language: add extensions, runtime candidates,
 * a standalone strategy, and its test-environment markers/strategies.
 * Strategy execution remains in the main process; this file contains no
 * executable shell commands or functions sent over IPC.
 */
const AgentDebug = Object.freeze({
  version: 1,
  executionTypes: Object.freeze(["interpreted", "compiled", "project"]),
  languages: Object.freeze({
    javascript: Object.freeze({
      id: "javascript",
      extensions: Object.freeze([".js", ".mjs", ".cjs"]),
      executionType: "interpreted",
      runtime: Object.freeze({
        candidates: Object.freeze([
          Object.freeze({
            id: "node",
            executable: "node",
            probeArgs: Object.freeze(["--version"]),
            source: "system",
          }),
        ]),
      }),
      standalone: Object.freeze({
        strategy: "node-script",
        validationKind: "standalone-test",
        recommendation:
          "Create a standalone JavaScript validation script using Node standard libraries such as node:assert. Exit non-zero on failure.",
      }),
      testEnvironment: Object.freeze({
        markers: Object.freeze(["package.json"]),
        directories: Object.freeze(["test", "tests", "__tests__"]),
        files: Object.freeze([
          "package.json",
          "package-lock.json",
          "npm-shrinkwrap.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "bun.lock",
          "bun.lockb",
        ]),
        filePatterns: Object.freeze([
          "*.test.js",
          "*.spec.js",
          "*.test.mjs",
          "*.spec.mjs",
          "*.test.cjs",
          "*.spec.cjs",
        ]),
        packageManagers: Object.freeze([
          Object.freeze({
            id: "npm",
            lockfiles: Object.freeze([
              "package-lock.json",
              "npm-shrinkwrap.json",
            ]),
            strategy: "npm-test",
          }),
          Object.freeze({
            id: "pnpm",
            lockfiles: Object.freeze(["pnpm-lock.yaml"]),
            strategy: "pnpm-test",
          }),
          Object.freeze({
            id: "yarn",
            lockfiles: Object.freeze(["yarn.lock"]),
            strategy: "yarn-test",
          }),
          Object.freeze({
            id: "bun",
            lockfiles: Object.freeze(["bun.lock", "bun.lockb"]),
            strategy: "bun-test",
          }),
        ]),
      }),
      projectStrategies: Object.freeze([
        Object.freeze({
          id: "npm-test",
          kind: "package-script",
          packageManagers: Object.freeze(["npm", "pnpm", "yarn", "bun"]),
        }),
        Object.freeze({
          id: "node-test",
          kind: "file-conventions",
          validationKind: "project-test",
        }),
      ]),
    }),
    python: Object.freeze({
      id: "python",
      extensions: Object.freeze([".py"]),
      executionType: "interpreted",
      runtime: Object.freeze({
        candidates: Object.freeze([
          Object.freeze({
            id: "project-venv",
            executable: "python",
            paths: Object.freeze([
              ".venv/bin/python",
              "venv/bin/python",
              ".venv/Scripts/python.exe",
              "venv/Scripts/python.exe",
            ]),
            source: "project",
          }),
          Object.freeze({
            id: "python3",
            executable: "python3",
            probeArgs: Object.freeze(["--version"]),
            source: "system",
          }),
          Object.freeze({
            id: "python",
            executable: "python",
            probeArgs: Object.freeze(["--version"]),
            source: "system",
          }),
          Object.freeze({
            id: "py",
            executable: "py",
            prefix: Object.freeze(["-3"]),
            probeArgs: Object.freeze(["--version"]),
            source: "system",
            platforms: Object.freeze(["win32"]),
          }),
        ]),
      }),
      standalone: Object.freeze({
        strategy: "python-script",
        validationKind: "standalone-test",
        recommendation:
          "Create a standalone Python validation script using assert or unittest from the standard library. Exit non-zero on failure.",
      }),
      testEnvironment: Object.freeze({
        markers: Object.freeze([
          "pyproject.toml",
          "pytest.ini",
          "setup.cfg",
          "tox.ini",
        ]),
        directories: Object.freeze(["tests", "test"]),
        files: Object.freeze([
          "pyproject.toml",
          "pytest.ini",
          "setup.cfg",
          "tox.ini",
        ]),
        filePatterns: Object.freeze(["test_*.py", "*_test.py"]),
      }),
      projectStrategies: Object.freeze([
        Object.freeze({
          id: "python-pytest",
          kind: "python-marker",
          validationKind: "project-test",
        }),
        Object.freeze({
          id: "python-unittest",
          kind: "python-conventions",
          validationKind: "project-test",
        }),
      ]),
    }),
    php: Object.freeze({
      id: "php",
      extensions: Object.freeze([".php"]),
      executionType: "interpreted",
      runtime: Object.freeze({
        candidates: Object.freeze([
          Object.freeze({
            id: "php",
            executable: "php",
            probeArgs: Object.freeze(["--version"]),
            source: "system",
          }),
        ]),
      }),
      standalone: Object.freeze({
        strategy: "php-script",
        validationKind: "standalone-test",
        recommendation:
          "Create a standalone PHP validation script using assertions or explicit checks and exit non-zero on failure.",
      }),
      testEnvironment: Object.freeze({
        markers: Object.freeze([
          "composer.json",
          "phpunit.xml",
          "phpunit.xml.dist",
        ]),
        directories: Object.freeze(["tests"]),
        files: Object.freeze([
          "composer.json",
          "phpunit.xml",
          "phpunit.xml.dist",
        ]),
        filePatterns: Object.freeze(["*Test.php"]),
      }),
      projectStrategies: Object.freeze([
        Object.freeze({
          id: "phpunit",
          kind: "phpunit",
          validationKind: "project-test",
        }),
        Object.freeze({
          id: "composer-test",
          kind: "composer-script",
          validationKind: "project-test",
        }),
      ]),
    }),
  }),
  strategies: Object.freeze({
    "node-script": Object.freeze({
      id: "node-script",
      language: "javascript",
      kind: "standalone",
    }),
    "python-script": Object.freeze({
      id: "python-script",
      language: "python",
      kind: "standalone",
    }),
    "php-script": Object.freeze({
      id: "php-script",
      language: "php",
      kind: "standalone",
    }),
    "npm-test": Object.freeze({
      id: "npm-test",
      language: "javascript",
      kind: "project",
    }),
    "pnpm-test": Object.freeze({
      id: "pnpm-test",
      language: "javascript",
      kind: "project",
    }),
    "yarn-test": Object.freeze({
      id: "yarn-test",
      language: "javascript",
      kind: "project",
    }),
    "bun-test": Object.freeze({
      id: "bun-test",
      language: "javascript",
      kind: "project",
    }),
    "node-test": Object.freeze({
      id: "node-test",
      language: "javascript",
      kind: "project",
    }),
    "python-pytest": Object.freeze({
      id: "python-pytest",
      language: "python",
      kind: "project",
    }),
    "python-unittest": Object.freeze({
      id: "python-unittest",
      language: "python",
      kind: "project",
    }),
    phpunit: Object.freeze({ id: "phpunit", language: "php", kind: "project" }),
    "composer-test": Object.freeze({
      id: "composer-test",
      language: "php",
      kind: "project",
    }),
  }),
});

if (typeof window !== "undefined") window.AgentDebug = AgentDebug;
if (typeof module !== "undefined" && module.exports)
  module.exports = AgentDebug;
