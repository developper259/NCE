import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type GitCommandFailureCode = "GIT_INDEX_LOCKED" | "GIT_COMMAND_FAILED";

const INDEX_LOCK_STDERR = /index\.lock/i;
const INDEX_LOCK_CREATE = /file exists|unable to create|cannot create/i;

function windowsGitRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  for (const value of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]) {
    if (value) roots.push(value);
  }
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, "Programs"));
  return [...new Set(roots)];
}

/** Absolute Git locations trusted ahead of a potentially hostile PATH. */
export function trustedGitCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    return windowsGitRoots(env)
      .map((root) => path.win32.join(root, "Git", "cmd", "git.exe"));
  }
  if (platform === "darwin")
    return ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
  return ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/snap/bin/git"];
}

/** Resolve Git without consulting PATH when a trusted install exists. */
export async function resolveGitExecutable(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  explicit?: string;
  candidates?: string[];
} = {}): Promise<string> {
  if (options.explicit) return options.explicit;
  const platform = options.platform ?? process.platform;
  const candidates = options.candidates ??
    trustedGitCandidates(platform, options.env ?? process.env);
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) continue;
      if (platform !== "win32" && (stats.mode & 0o111) === 0) continue;
      return candidate;
    } catch {
      continue;
    }
  }
  return "git";
}

/** Map Git stderr to an actionable failure without touching repository state. */
export function classifyGitFailure(detail?: string): {
  code: GitCommandFailureCode;
  message: string;
} {
  if (detail && INDEX_LOCK_STDERR.test(detail) && INDEX_LOCK_CREATE.test(detail)) {
    return {
      code: "GIT_INDEX_LOCKED",
      message: "Git is already running in this repository, or a previous operation was interrupted. Wait for it to finish, then retry.",
    };
  }
  return { code: "GIT_COMMAND_FAILED", message: "The Git command failed." };
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; stdio: "ignore" },
) => Pick<ChildProcess, "on" | "unref">;

/**
 * Terminate Git and its children. The lock file is deliberately left in place:
 * deleting a lock another Git process owns would corrupt the repository.
 */
export function killProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: SpawnProcess = spawn,
): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform === "win32") {
    try { child.kill(signal); } catch {}
    if (signal !== "SIGKILL") return;
    try {
      const killer = spawnProcess(
        path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => {});
      killer.unref();
    } catch {}
    return;
  }
  try { process.kill(-pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}
