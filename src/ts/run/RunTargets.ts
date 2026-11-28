import { spawn } from "child_process";
import { promises as fs, constants as fsConstants } from "fs";
import path from "path";

/**
 * What NCE can actually run, and how it finds the runtime to run it with.
 *
 * This module is the single source of truth shared by the Run supervisor and
 * the agent process runner. It exists so the two cannot drift: a file the UI
 * offers to run is a file the engine can resolve a runtime for, and a runtime
 * the engine refuses is a runtime the UI refuses too.
 *
 * Two rules are deliberate and load-bearing:
 *
 * - TypeScript is absent. Node cannot execute `.ts` without a loader, so
 *   advertising it would promise something the engine cannot deliver.
 * - Node is resolved from PATH only, never from NCE's embedded runtime. The
 *   embedded runtime belongs to the language servers; borrowing it here would
 *   run the user's program on a private Node they cannot see or upgrade.
 */

/** Languages NCE can run as a single file. */
export type RunLanguage = "python" | "javascript";

/** The runtime family a language needs. */
export type RunRuntime = "python" | "node";

export interface RunTarget {
  /** Strategy name understood by the process runner. */
  strategy: "python-script" | "node-script";
  language: RunLanguage;
  runtime: RunRuntime;
  /** Human label used in messages, e.g. "Python". */
  label: string;
}

export const RUN_TARGETS: Readonly<Record<RunLanguage, RunTarget>> = Object.freeze({
  python: {
    strategy: "python-script",
    language: "python",
    runtime: "python",
    label: "Python",
  },
  javascript: {
    strategy: "node-script",
    language: "javascript",
    runtime: "node",
    label: "Node.js",
  },
});

/** Extensions each runnable language may use. */
export const RUN_EXTENSIONS: Readonly<Record<RunLanguage, readonly string[]>> =
  Object.freeze({
    python: [".py"],
    javascript: [".js", ".mjs", ".cjs"],
  });

/** Languages NCE knows about but cannot run, with the reason to show. */
export const UNRUNNABLE_LANGUAGES: Readonly<Record<string, string>> =
  Object.freeze({
    typescript:
      "TypeScript needs a build step. Run the compiled JavaScript, or use the terminal.",
  });

export interface ResolvedRuntime {
  executable: string;
  /** Arguments that must precede the script, e.g. `py -3` on Windows. */
  prefix: string[];
  /** Where the runtime came from, so the UI can say it precisely. */
  source: "project-venv" | "path";
}

export interface RunTargetDescription {
  runnable: boolean;
  reason?: string;
  target?: RunTarget;
}

/**
 * Decide whether a file is runnable, and why not when it is not.
 *
 * Returning a reason rather than a bare boolean keeps the Run button honest:
 * it can be disabled with a tooltip that says what is missing instead of
 * silently doing nothing.
 */
export function describeRunTarget(input: {
  language?: unknown;
  name?: unknown;
  path?: unknown;
  isSaved?: unknown;
  isPicture?: unknown;
  type?: unknown;
} | null | undefined): RunTargetDescription {
  if (!input) return { runnable: false, reason: "Open a file to run it." };
  if (input.isPicture === true || input.type === "picture")
    return { runnable: false, reason: "Images cannot be run." };
  if (!input.path) return { runnable: false, reason: "Save the file before running it." };
  if (input.isSaved === false)
    return { runnable: false, reason: "Save the file before running it." };

  const language = String(input.language || "").toLowerCase();
  const target = RUN_TARGETS[language as RunLanguage];
  if (!target) {
    const known = UNRUNNABLE_LANGUAGES[language];
    return {
      runnable: false,
      reason:
        known ||
        `Running ${language || "this file type"} is not supported yet.`,
    };
  }

  const name = String(input.name || input.path || "").toLowerCase();
  const extensions = RUN_EXTENSIONS[target.language];
  if (!extensions.some((extension) => name.endsWith(extension)))
    return {
      runnable: false,
      reason: `Only ${extensions.join(", ")} files run as ${target.label}.`,
    };

  return { runnable: true, target };
}

/** True when a strategy name is one of the single-file run strategies. */
export function isRunStrategy(value: unknown): value is RunTarget["strategy"] {
  return value === "python-script" || value === "node-script";
}

/**
 * Filesystem and PATH probing for runtimes.
 *
 * Kept as a class so tests can substitute the two filesystem primitives
 * without spawning anything, and so the version cache is per-instance rather
 * than global state that outlives a window.
 */
/**
 * Where a project virtual environment keeps its interpreter.
 *
 * Windows puts executables in Scripts and requires the .exe suffix; POSIX
 * layouts use bin/python. Exported so the candidate list can be asserted on
 * every platform without depending on the host one.
 */
export function pythonVenvCandidates(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const segments = platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  return [
    pathApi.join(projectRoot, ".venv", ...segments),
    pathApi.join(projectRoot, "venv", ...segments),
  ];
}

export class RuntimeProbe {
  private readonly versions = new Map<string, string | null>();

  async executableExists(candidate: string): Promise<boolean> {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) return false;
      await fs.access(
        candidate,
        process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
      );
      return true;
    } catch {
      return false;
    }
  }

  async executableOnPath(name: string): Promise<boolean> {
    if (!name || name.includes("\0")) return false;
    const pathApi = process.platform === "win32" ? path.win32 : path.posix;
    if (pathApi.isAbsolute(name) || name.includes("/") || name.includes("\\"))
      return this.executableExists(name);

    const directories = (process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean);
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
        : [""];
    const suffixes =
      process.platform === "win32" && pathApi.extname(name) ? [""] : extensions;

    for (const directory of directories)
      for (const extension of suffixes)
        if (await this.executableExists(pathApi.join(directory, `${name}${extension}`)))
          return true;
    return false;
  }

  /**
   * Resolve the runtime for a language inside a project.
   *
   * Python prefers the project's own virtual environment, because that is the
   * interpreter the project's dependencies were installed into. Node has no
   * project-local equivalent, so it comes from PATH.
   */
  async resolve(
    runtime: RunRuntime,
    projectRoot: string,
    platform: NodeJS.Platform = process.platform,
  ): Promise<ResolvedRuntime | null> {
    if (runtime === "python") {
      for (const candidate of pythonVenvCandidates(projectRoot, platform))
        if (await this.executableExists(candidate))
          return { executable: candidate, prefix: [], source: "project-venv" };

      for (const name of platform === "win32"
        ? ["python", "python3", "py"]
        : ["python3", "python"])
        if (await this.executableOnPath(name))
          return {
            executable: name,
            prefix: name === "py" ? ["-3"] : [],
            source: "path",
          };
      return null;
    }

    return (await this.executableOnPath("node"))
      ? { executable: "node", prefix: [], source: "path" }
      : null;
  }

  /**
   * Ask the runtime for its version, once per executable.
   *
   * A runtime that cannot answer is not an error: the run still proceeds and
   * the UI simply omits the version.
   */
  async version(executable: string, prefix: string[] = []): Promise<string | null> {
    const key = [executable, ...prefix].join(" ");
    if (this.versions.has(key)) return this.versions.get(key) ?? null;

    const reported = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn(executable, [...prefix, "--version"], {
          shell: false,
          windowsHide: true,
          timeout: 5000,
        });
      } catch {
        finish(null);
        return;
      }
      let output = "";
      const collect = (chunk: Buffer | string) => {
        if (output.length < 4096) output += String(chunk);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", () => finish(null));
      child.on("close", () => finish(output.trim() || null));
    });

    const version = normalizeVersion(reported);
    this.versions.set(key, version);
    return version;
  }
}

/**
 * Reduce a `--version` line to just the number.
 *
 * Python prints "Python 3.12.1", Node prints "v20.11.0", and `py -3` may print
 * a launcher banner first. The UI only wants the number.
 */
export function normalizeVersion(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return match ? match[0] : null;
}
