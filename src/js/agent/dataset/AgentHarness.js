const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

class AgentHarness {
  constructor(options = {}) {
    this.appRoot = path.resolve(
      options.appRoot || path.join(__dirname, "../../../.."),
    );
    this.transport = options.transport || null;
  }
  async create(workspaceRoot, config = {}) {
    const api = this.createApi(
      workspaceRoot,
      config.transport || this.transport,
    );
    class LineNode {
      constructor(text = "") {
        this.text = text;
        this.diffState = null;
        this.diffSegments = [];
      }
      getText() {
        return this.text;
      }
    }
    const tabManager = {
      activeFile: null,
      files: [],
      getFileByPath(candidate) {
        const target = path.resolve(candidate);
        return this.files.find((file) => path.resolve(file.path) === target) || null;
      },
      async openFileWithPath(candidate) {
        const target = path.resolve(candidate);
        let file = this.getFileByPath(target);
        if (!file) {
          const content = await fsp.readFile(target, "utf8");
          file = {
            path: target,
            name: path.basename(target),
            lines: content.replace(/\r\n?/g, "\n").split("\n").map((line) => new LineNode(line)),
            isLoaded: true,
            isSaved: true,
            editVersion: 0,
            setIsSaved(value) {
              this.isSaved = value;
            },
          };
          this.files.push(file);
        }
        this.activeFile = file;
        return file;
      },
      async setFocusFile(file) {
        this.activeFile = file;
        return file;
      },
      async reloadFileFromDisk(candidate) {
        const file = this.getFileByPath(candidate);
        if (!file) return null;
        const content = await fsp.readFile(file.path, "utf8");
        file.lines = content.replace(/\r\n?/g, "\n").split("\n").map((line) => new LineNode(line));
        file.isLoaded = true;
        return file;
      },
    };
    const editor = {
      api,
      fileExplorer: { rootPath: workspaceRoot, async refreshFolder() {} },
      tabManager,
      lineController: {
        loadContent() {},
        refresh() {},
        markDirtyAll() {},
      },
      getAutoSaveState() {
        return true;
      },
      highlightController: {
        async detectLanguage() {
          return "unknown";
        },
      },
    };
    const quietConsole = {
      ...console,
      debug() {},
      info() {},
      log() {},
      warn() {},
    };
    const context = {
      window: {},
      console: quietConsole,
      setTimeout,
      clearTimeout,
      AbortController,
      AbortSignal,
      DOMException,
      TextDecoder,
      TextEncoder,
      LineNode,
      fetch,
    };
    vm.createContext(context);
    const html = await fsp.readFile(
      path.join(this.appRoot, "src/html/index.html"),
      "utf8",
    );
    const scripts = [
      ...html.matchAll(
        /src="\.\.\/(config\/[^"\n]+|js\/(?:agent\/[^"\n]+|core\/Agent\.js))"/g,
      ),
    ].map((match) => match[1]);
    for (const script of scripts)
      vm.runInContext(
        await fsp.readFile(path.join(this.appRoot, "src", script), "utf8"),
        context,
        { filename: script },
      );
    context.editor = editor;
    const agent = vm.runInContext("new Agent(editor)", context);
    const provider = config.provider || {
      id: config.providerId || "openai-compatible",
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      requiresApiKey: Boolean(config.apiKey),
      supportsTools: true,
    };
    agent.setProvider(provider).setModel(config.model || "unknown-model");
    agent.permissions = config.permissions || "code";
    if (config.maxIterations)
      agent.setConfig({ maxIterations: config.maxIterations });
    return agent;
  }
  createApi(root, transport) {
    const inside = (candidate) => {
      const target = path.resolve(candidate);
      if (target !== root && !target.startsWith(root + path.sep))
        throw Object.assign(new Error("path outside workspace"), {
          code: "OUTSIDE_WORKSPACE",
        });
      return target;
    };
    const exists = async (candidate) => {
      try {
        await fsp.access(candidate);
        return true;
      } catch {
        return false;
      }
    };
    const operation = async (_root, name, args) => {
      try {
        if (name === "saveFile") {
          const target = inside(args[0]);
          await fsp.writeFile(target, args[1], "utf8");
          return { success: true, path: target };
        }
        if (name === "createFile") {
          const target = inside(path.join(args[0], args[1]));
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, args[2] || "", {
            encoding: "utf8",
            flag: args[3] ? "w" : "wx",
          });
          return { success: true, path: target };
        }
        if (name === "createFolder") {
          const target = inside(path.join(args[0], args[1]));
          await fsp.mkdir(target);
          return { success: true, path: target };
        }
        if (name === "deleteEntry") {
          const target = inside(args[0]);
          await fsp.rm(target, { recursive: true, force: false });
          return { success: true, path: target };
        }
        if (name === "renameEntry" || name === "moveEntry") {
          const from = inside(args[0]),
            to = inside(args[1]);
          await fsp.rename(from, to);
          return { success: true, path: to };
        }
        if (name === "copyEntry" || name === "duplicateEntry") {
          const from = inside(args[0]),
            to = inside(args[1] || `${args[0]}.copy`);
          await fsp.cp(from, to, { recursive: true, errorOnExist: true });
          return { success: true, path: to };
        }
        return { success: false, error: "unsupported operation" };
      } catch (error) {
        return { success: false, code: error.code, error: error.message };
      }
    };
    const list = async (dir = root) => {
      const output = [];
      const walk = async (current) => {
        for (const entry of await fsp.readdir(current, {
          withFileTypes: true,
        })) {
          if ([".git", ".nce"].includes(entry.name)) continue;
          const absolute = path.join(current, entry.name),
            relativePath = path
              .relative(root, absolute)
              .split(path.sep)
              .join("/");
          if (entry.isDirectory()) await walk(absolute);
          else if (entry.isFile())
            output.push({
              name: entry.name,
              path: absolute,
              relativePath,
              type: "file",
            });
        }
      };
      await walk(inside(dir));
      return output;
    };
    return {
      agentFileOperation: operation,
      aiChat: transport ? (request) => transport(request) : undefined,
      pathExists: async (candidate) => exists(inside(candidate)),
      pathStatus: async (candidate) => {
        const target = inside(candidate);
        try {
          const stat = await fsp.stat(target);
          return {
            exists: true,
            isDirectory: stat.isDirectory(),
            readable: true,
          };
        } catch (error) {
          return { exists: false, code: error.code };
        }
      },
      getFileContent: async (paths) =>
        Object.fromEntries(
          await Promise.all(
            paths.map(async (candidate) => {
              const target = inside(candidate);
              try {
                return [candidate, await fsp.readFile(target, "utf8")];
              } catch (error) {
                if (error?.code === "ENOENT") return [candidate, null];
                throw error;
              }
            }),
          ),
        ),
      getFolderContent: async (candidate) =>
        (await fsp.readdir(inside(candidate), { withFileTypes: true })).map(
          (entry) => ({
            name: entry.name,
            path: path.join(candidate, entry.name),
            isDirectory: entry.isDirectory(),
          }),
        ),
      listProjectFiles: async () => ({ success: true, entries: await list() }),
      getProjectMap: async (_workspace, target, options = {}) => {
        const entries = await list(target);
        return {
          success: true,
          root: target,
          entries,
          files: entries.length,
          directories: 0,
          truncated: false,
          maxDepth: options.maxDepth,
          maxFiles: options.maxFiles,
        };
      },
      searchInFiles: async (_workspace, query, options = {}) => {
        const entries = await list();
        const offset = Math.max(0, Math.floor(options.offset || 0));
        const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
        const needle = options.matchCase ? String(query) : String(query).toLowerCase();
        const matches = [];
        for (const entry of entries) {
          let content;
          try {
            content = await fsp.readFile(entry.path, "utf8");
          } catch {
            continue;
          }
          const lines = content.replace(/\r\n?/g, "\n").split("\n");
          lines.forEach((line, index) => {
            const haystack = options.matchCase ? line : line.toLowerCase();
            const column = haystack.indexOf(needle);
            if (column >= 0) {
              matches.push({
                path: entry.relativePath,
                line: index + 1,
                column: column + 1,
                preview: line,
              });
            }
          });
        }
        return {
          success: true,
          results: matches.slice(offset, offset + limit),
          totalMatches: matches.length,
          filesSearched: entries.length,
          offset,
          limit,
          hasMore: offset + limit < matches.length,
        };
      },
      runAgentProcess: (request) => this.runProcess(request),
      resolveAgentRuntime: async () => ({
        success: true,
        command: process.execPath,
      }),
    };
  }
  runProcess(request) {
    return new Promise((resolve) => {
      const commands = {
        "npm-test": [
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["test"],
        ],
        "node-test": [
          process.execPath,
          ["--test", ...(request.target ? [request.target] : [])],
        ],
      };
      const [command, args] = commands[request.strategy] || [
        process.execPath,
        ["--test"],
      ];
      const startedAt = Date.now(),
        child = spawn(command, args, {
          cwd: request.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      let stdout = "",
        stderr = "",
        timedOut = false;
      const limit = request.maxStoredOutputCharacters || 50000;
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(0, limit);
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(0, limit);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs || 120000);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          success: true,
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          truncated: stdout.length >= limit || stderr.length >= limit,
        });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: error.message,
          exitCode: null,
          timedOut: false,
          stdout,
          stderr,
        });
      });
    });
  }
}
module.exports = { AgentHarness };
