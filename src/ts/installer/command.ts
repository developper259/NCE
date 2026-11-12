import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { killProcessTree } from "../manager/GitProcess";
import { InstallerError } from "./errors";

const MAX_COMMAND_OUTPUT = 64 * 1024;

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Never inherit repository/object/config redirections from the launch
 * environment: a stray GIT_DIR or GIT_EXEC_PATH would make the installed Git
 * operate on the wrong repository or fail to find its own helpers.
 */
function commandEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  Object.assign(env, extra);
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new InstallerError("CANCELLED", "Installation cancelled."));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: commandEnv(options.env),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new InstallerError("STEP_FAILED", `Could not run ${executable}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const kill = () => killProcessTree(child, "SIGKILL");
    const finish = (error: InstallerError | null, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      kill();
      finish(new InstallerError("STEP_FAILED", `Command timed out after ${options.timeoutMs}ms: ${executable}`));
    }, options.timeoutMs);
    const onAbort = () => {
      kill();
      finish(new InstallerError("CANCELLED", "Installation cancelled."));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(new InstallerError("STEP_FAILED", `Could not run ${executable}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new InstallerError("STEP_FAILED", `${path.basename(executable)} exited with code ${code}: ${(stderr || stdout).trim().slice(0, 400)}`));
    });
  });
}