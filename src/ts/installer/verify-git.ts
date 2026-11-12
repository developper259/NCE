import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command";
import { InstallerError } from "./errors";

const PROBE_MESSAGE = "nce-install-verification";

export interface GitFunctionalOptions {
  executable: string;
  installDir: string;
  signal: AbortSignal;
  timeoutMs: number;
  tempRoot?: string;
}

async function isDirectory(target: string): Promise<boolean> {
  return fs.stat(target).then((stats) => stats.isDirectory(), () => false);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new InstallerError("CANCELLED", "Installation cancelled.");
}

/**
 * Prove the installed Git can do real repository work, not just print a version:
 * init a throwaway repo, commit a file, then confirm a clean status and the
 * recorded commit. dugite-native ships a broken compiled-in exec-path, so point
 * GIT_EXEC_PATH/GIT_TEMPLATE_DIR at the installed layout when it is present.
 * The probe repository is always removed, even on failure or cancellation.
 */
export async function verifyGitFunctional(options: GitFunctionalOptions): Promise<void> {
  const { executable, installDir, signal, timeoutMs } = options;
  throwIfAborted(signal);
  const env: NodeJS.ProcessEnv = {};
  const execPath = path.join(installDir, "libexec", "git-core");
  const templateDir = path.join(installDir, "share", "git-core", "templates");
  if (await isDirectory(execPath)) env.GIT_EXEC_PATH = execPath;
  if (await isDirectory(templateDir)) env.GIT_TEMPLATE_DIR = templateDir;

  const repo = await fs.mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "nce-git-verify-"));
  const run = (args: string[]) => runCommand(executable, args, { cwd: repo, timeoutMs, signal, env });
  try {
    await run(["init", "--initial-branch=main"]);
    throwIfAborted(signal);
    await fs.writeFile(path.join(repo, "probe.txt"), "nce install verification\n");
    await run(["add", "probe.txt"]);
    throwIfAborted(signal);
    await run(["-c", "user.name=NCE Installer", "-c", "user.email=installer@nce.local", "commit", "-m", PROBE_MESSAGE]);
    throwIfAborted(signal);
    const status = await run(["status", "--porcelain"]);
    if (status.stdout.trim() !== "")
      throw new InstallerError("VERIFICATION_FAILED", "Git functional verification failed: the probe repository is not clean after commit.");
    const log = await run(["log", "-1", "--format=%s"]);
    if (log.stdout.trim() !== PROBE_MESSAGE)
      throw new InstallerError("VERIFICATION_FAILED", "Git functional verification failed: the probe commit was not recorded.");
  } catch (error) {
    if (error instanceof InstallerError && (error.code === "CANCELLED" || error.code === "VERIFICATION_FAILED")) throw error;
    throw new InstallerError("VERIFICATION_FAILED", `Git functional verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  }
}