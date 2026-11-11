import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { downloadFile, isAllowedDownloadUrl } from "./download";
import { InstallerError, isCancelled } from "./errors";
import { extractArchive } from "./extract";
import { builtinPackages } from "./packages";
import { getPackageDefinition } from "./registry";
import type {
  InstallOptions,
  InstallProgress,
  InstallResult,
  InstallStep,
  InstallerArchitecture,
  InstallerOptions,
  InstallerPlatform,
  PackageDefinition,
  PlatformConfig,
} from "./types";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const CHECKSUM_LENGTH: Record<string, number> = { sha256: 64, sha512: 128 };
const ARCHITECTURES: InstallerArchitecture[] = ["x64", "arm64", "ia32", "arm"];

interface StepContext {
  definition: PackageDefinition;
  platformConfig: PlatformConfig;
  platform: InstallerPlatform;
  arch: InstallerArchitecture;
  stagingDir: string;
  installDir: string;
  downloadDir: string;
  archivePath: string | null;
  signal: AbortSignal;
  report: (partial: Partial<InstallProgress> & { message: string }) => void;
}

export class Installer {
  private readonly userDataPath: string;
  private readonly registry: Record<string, PackageDefinition>;
  private readonly platform: InstallerPlatform;
  private readonly arch: InstallerArchitecture;
  private active: AbortController | null = null;

  constructor(options: InstallerOptions) {
    this.userDataPath = options.userDataPath;
    this.registry = options.registry ?? builtinPackages;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? (process.arch as InstallerArchitecture);
  }

  cancel(): void {
    this.active?.abort();
  }

  async install(packageId: string, options: InstallOptions = {}): Promise<InstallResult> {
    if (this.active)
      return { success: false, packageId, code: "INSTALL_BUSY", error: "Another installation is already running." };
    const controller = new AbortController();
    this.active = controller;
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let stagingDir: string | null = null;
    try {
      const definition = getPackageDefinition(packageId, this.registry);
      validateDefinition(definition);
      const platformConfig = resolvePlatformConfig(definition, this.platform, this.arch);
      const destination = this.resolveDestination(definition);
      const steps = definition.install?.steps ?? [{ type: "download" }, { type: "extract" }];
      let stepIndex = 0;
      const report = (partial: Partial<InstallProgress> & { message: string }) => {
        const progress: InstallProgress = {
          packageId: definition.id,
          version: definition.version,
          step: steps[stepIndex]?.type ?? "finalize",
          stepIndex,
          stepCount: steps.length,
          ...partial,
        };
        try {
          options.onProgress?.(progress);
        } catch {
          // A broken progress consumer must never abort an installation.
        }
      };

      if (await pathExists(destination)) {
        const existing = await this.runVerification(definition, destination, controller.signal, {
          installDir: destination,
          stagingDir: destination,
          downloadDir: destination,
        }).catch(() => null);
        if (existing) {
          return {
            success: true,
            packageId: definition.id,
            version: definition.version,
            executable: path.resolve(destination, platformConfig.executable),
            installDir: destination,
            alreadyInstalled: true,
          };
        }
      }

      stagingDir = path.join(this.toolsRoot(), `.staging-${definition.id}-${randomUUID()}`);
      const installDir = path.join(stagingDir, "install");
      const downloadDir = path.join(stagingDir, "download");
      await fs.mkdir(installDir, { recursive: true });
      await fs.mkdir(downloadDir, { recursive: true });
      const context: StepContext = {
        definition,
        platformConfig,
        platform: this.platform,
        arch: this.arch,
        stagingDir,
        installDir,
        downloadDir,
        archivePath: null,
        signal: controller.signal,
        report,
      };
      report({ step: "prepare", message: `Preparing ${definition.name} ${definition.version}…` });

      for (const step of steps) {
        throwIfAborted(controller.signal);
        report({ message: describeStep(step, definition) });
        try {
          await this.runStep(step, context);
        } catch (error) {
          if (isCancelled(error)) throw error;
          if ((step as { required?: boolean }).required === false) {
            report({ message: `Optional step "${step.type}" failed; continuing.` });
            stepIndex++;
            continue;
          }
          throw error;
        }
        stepIndex++;
      }

      throwIfAborted(controller.signal);
      report({ step: "verify", message: `Verifying ${definition.name}…` });
      await this.runVerification(definition, installDir, controller.signal, context);

      throwIfAborted(controller.signal);
      report({ step: "commit", message: "Finalizing installation…" });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      let backup: string | null = null;
      if (await pathExists(destination)) {
        backup = path.join(stagingDir, "previous");
        await fs.rename(destination, backup);
      }
      try {
        await fs.rename(installDir, destination);
      } catch (error) {
        if (backup) await fs.rename(backup, destination).catch(() => {});
        throw new InstallerError("INSTALL_FAILED", `Could not move the validated installation into place: ${errorMessage(error)}`);
      }
      if (backup) await fs.rm(backup, { recursive: true, force: true });
      report({ step: "complete", message: `${definition.name} ${definition.version} installed.` });
      return {
        success: true,
        packageId: definition.id,
        version: definition.version,
        executable: path.resolve(destination, platformConfig.executable),
        installDir: destination,
      };
    } catch (error) {
      const code = error instanceof InstallerError ? error.code : "INSTALL_FAILED";
      return { success: false, packageId, code, error: errorMessage(error) };
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      this.active = null;
      if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private toolsRoot(): string {
    return path.join(this.userDataPath, "tools");
  }

  private resolveDestination(definition: PackageDefinition): string {
    const template = definition.install?.destination ?? "tools/{id}/{version}";
    const resolved = path.resolve(this.userDataPath, substitute(template, {
      installDir: "",
      stagingDir: "",
      downloadDir: "",
      archive: "",
      id: definition.id,
      version: definition.version,
      platform: this.platform,
      arch: this.arch,
    }));
    const toolsRoot = this.toolsRoot();
    if (resolved === toolsRoot || !resolved.startsWith(toolsRoot + path.sep))
      throw new InstallerError("INVALID_PACKAGE", `Install destination must stay inside ${toolsRoot}: ${template}`);
    return resolved;
  }

  private async runStep(step: InstallStep, context: StepContext): Promise<void> {
    switch (step.type) {
      case "download": {
        const { download } = context.platformConfig;
        const extension = context.platformConfig.archive.format === "zip" ? "zip" : "tar.gz";
        const archivePath = path.join(context.downloadDir, `${context.definition.id}-${context.definition.version}.${extension}`);
        const outcome = await downloadFile(download.url, archivePath, {
          algorithm: download.checksumAlgorithm,
          signal: context.signal,
          onBytes: (receivedBytes, totalBytes) => {
            context.report({
              message: `Downloading ${context.definition.name} ${context.definition.version}…`,
              receivedBytes,
              totalBytes,
              percent: totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : undefined,
            });
          },
        });
        if (outcome.checksum.toLowerCase() !== download.checksum.toLowerCase())
          throw new InstallerError("CHECKSUM_MISMATCH", `Checksum mismatch for ${download.url}: expected ${download.checksum}, got ${outcome.checksum}.`);
        if (download.size !== undefined && outcome.bytes !== download.size)
          throw new InstallerError("DOWNLOAD_FAILED", `Size mismatch for ${download.url}: expected ${download.size} bytes, got ${outcome.bytes}.`);
        context.archivePath = archivePath;
        return;
      }
      case "extract": {
        if (!context.archivePath)
          throw new InstallerError("STEP_FAILED", "The extract step requires a preceding download step.");
        await extractArchive(context.archivePath, context.installDir, context.platformConfig.archive, context.signal);
        return;
      }
      case "command": {
        const executable = await this.resolveInside(step.executable, context.installDir, context);
        const cwd = step.cwd ? await this.resolveInside(step.cwd, context.installDir, context) : context.installDir;
        await runCommand(executable, substituteArgs(step.args ?? [], context), {
          cwd,
          timeoutMs: step.timeoutMs ?? COMMAND_TIMEOUT_MS,
          signal: context.signal,
        });
        return;
      }
      case "copy": {
        const from = await this.resolveInside(step.from, context.stagingDir, context);
        const to = await this.resolveInside(step.to, context.stagingDir, context);
        await fs.cp(from, to, { recursive: true });
        return;
      }
      case "move": {
        const from = await this.resolveInside(step.from, context.stagingDir, context);
        const to = await this.resolveInside(step.to, context.stagingDir, context);
        await fs.rename(from, to);
        return;
      }
      case "delete": {
        const target = await this.resolveInside(step.path, context.stagingDir, context);
        await fs.rm(target, { recursive: true, force: true });
        return;
      }
      case "verify": {
        const executable = await this.resolveInside(step.executable, context.installDir, context);
        try {
          await runCommand(executable, substituteArgs(step.args ?? [], context), {
            cwd: context.installDir,
            timeoutMs: step.timeoutMs ?? COMMAND_TIMEOUT_MS,
            signal: context.signal,
          });
        } catch (error) {
          if (isCancelled(error)) throw error;
          throw new InstallerError("VERIFICATION_FAILED", errorMessage(error));
        }
        return;
      }
    }
  }

  private async resolveInside(value: string, root: string, context: StepContext): Promise<string> {
    const substituted = substitute(value, tokensFor(context));
    if (substituted.includes("\0"))
      throw new InstallerError("STEP_FAILED", "Step path contains a null byte.");
    const resolved = path.resolve(root, substituted);
    // The bundled Node runtime is the one executable trusted outside the install dir.
    if (resolved === process.execPath) return resolved;
    assertContained(resolved, root);
    const realRoot = await fs.realpath(root).catch(() => root);
    const real = await fs.realpath(resolved).catch(() => null);
    if (real) assertContained(real, realRoot);
    return resolved;
  }

  private async runVerification(
    definition: PackageDefinition,
    dir: string,
    signal: AbortSignal,
    context: Pick<StepContext, "installDir" | "stagingDir" | "downloadDir">,
  ): Promise<{ stdout: string; stderr: string }> {
    const verificationContext: StepContext = {
      ...context,
      definition,
      platformConfig: resolvePlatformConfig(definition, this.platform, this.arch),
      platform: this.platform,
      arch: this.arch,
      archivePath: null,
      signal,
      report: () => {},
    };
    const executable = await this.resolveInside(definition.verification.executable, dir, verificationContext);
    const stats = await fs.stat(executable).catch(() => null);
    if (!stats?.isFile())
      throw new InstallerError("VERIFICATION_FAILED", `Installed executable is missing: ${executable}`);
    if (this.platform !== "win32" && (stats.mode & 0o111) === 0)
      throw new InstallerError("VERIFICATION_FAILED", `Installed executable is not executable: ${executable}`);
    try {
      return await runCommand(executable, substituteArgs(definition.verification.args ?? [], verificationContext), {
        cwd: dir,
        timeoutMs: definition.verification.timeoutMs ?? COMMAND_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (isCancelled(error)) throw error;
      throw new InstallerError("VERIFICATION_FAILED", errorMessage(error));
    }
  }
}

function resolvePlatformConfig(
  definition: PackageDefinition,
  platform: InstallerPlatform,
  arch: InstallerArchitecture,
): PlatformConfig {
  const config = definition.platforms[platform]?.[arch];
  if (!config)
    throw new InstallerError("UNSUPPORTED_PLATFORM", `${definition.name} ${definition.version} has no verified distribution for ${platform}/${arch}.`);
  return config;
}

function validateDefinition(definition: PackageDefinition): void {
  const invalid = (reason: string) => {
    throw new InstallerError("INVALID_PACKAGE", `Invalid package definition "${definition.id}": ${reason}`);
  };
  if (!SAFE_TOKEN.test(definition.id)) invalid("id must be a simple path-safe token.");
  if (!SAFE_TOKEN.test(definition.version)) invalid("version must be a simple path-safe token.");
  if (typeof definition.name !== "string" || !definition.name.trim()) invalid("name is required.");
  const platforms = Object.entries(definition.platforms);
  if (platforms.length === 0) invalid("at least one platform is required.");
  for (const [platform, architectures] of platforms) {
    for (const [arch, config] of Object.entries(architectures ?? {})) {
      if (!ARCHITECTURES.includes(arch as InstallerArchitecture)) invalid(`unknown architecture ${arch}.`);
      if (!config) invalid(`missing configuration for ${platform}/${arch}.`);
      const { download, archive, executable } = config;
      if (!isAllowedDownloadUrl(download.url)) invalid(`download URL must use HTTPS: ${download.url}`);
      const expectedLength = CHECKSUM_LENGTH[download.checksumAlgorithm];
      if (!expectedLength) invalid(`unsupported checksum algorithm ${download.checksumAlgorithm}.`);
      if (!new RegExp(`^[0-9a-fA-F]{${expectedLength}}$`).test(download.checksum)) invalid("checksum must be hexadecimal with the algorithm's length.");
      if (download.size !== undefined && (!Number.isInteger(download.size) || download.size <= 0)) invalid("download size must be a positive integer.");
      if (archive.format !== "zip" && archive.format !== "tar.gz") invalid(`unsupported archive format ${archive.format}.`);
      if (archive.stripComponents !== undefined && (!Number.isInteger(archive.stripComponents) || archive.stripComponents < 0 || archive.stripComponents > 16)) invalid("stripComponents must be an integer between 0 and 16.");
      if (!isSafeRelativePath(executable)) invalid("executable must be a relative path inside the install directory.");
    }
  }
  for (const step of definition.install?.steps ?? []) {
    if (!["download", "extract", "command", "copy", "move", "delete", "verify"].includes(step.type)) invalid(`unknown step type ${String((step as { type: string }).type)}.`);
    if (step.type === "command" || step.type === "verify") {
      if (typeof step.executable !== "string" || !step.executable.trim()) invalid(`${step.type} step requires an executable.`);
      if (step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string" || arg.includes("\0")))) invalid("step args must be plain strings.");
      if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs <= 0 || step.timeoutMs > MAX_COMMAND_TIMEOUT_MS)) invalid("step timeoutMs is out of range.");
    }
    if (step.type === "copy" || step.type === "move") {
      if (typeof step.from !== "string" || typeof step.to !== "string") invalid(`${step.type} step requires from and to.`);
    }
    if (step.type === "delete" && typeof step.path !== "string") invalid("delete step requires a path.");
  }
  if (typeof definition.verification?.executable !== "string" || !definition.verification.executable.trim()) invalid("verification executable is required.");
}

function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  return value.split(/[\\/]+/).every((segment) => segment && segment !== "." && segment !== "..");
}

function tokensFor(context: StepContext): Record<string, string> {
  return {
    installDir: context.installDir,
    stagingDir: context.stagingDir,
    downloadDir: context.downloadDir,
    archive: context.archivePath ?? "",
    id: context.definition.id,
    version: context.definition.version,
    platform: context.platform,
    arch: context.arch,
  };
}

function substitute(value: string, tokens: Record<string, string>): string {
  return value.replace(/\{(installDir|stagingDir|downloadDir|archive|id|version|platform|arch)\}/g, (_match, token: string) => tokens[token]);
}

function substituteArgs(args: string[], context: StepContext): string[] {
  const tokens = tokensFor(context);
  return args.map((arg) => substitute(arg, tokens));
}

function assertContained(resolved: string, root: string): void {
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new InstallerError("STEP_FAILED", `Step path escapes its allowed directory: ${resolved}`);
}

function describeStep(step: InstallStep, definition: PackageDefinition): string {
  switch (step.type) {
    case "download": return `Downloading ${definition.name} ${definition.version}…`;
    case "extract": return `Extracting ${definition.name}…`;
    case "command": return "Running post-install command…";
    case "copy": return "Copying files…";
    case "move": return "Moving files…";
    case "delete": return "Cleaning temporary files…";
    case "verify": return "Verifying installation…";
  }
}

interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

function runCommand(executable: string, args: string[], options: CommandOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const kill = () => {
      if (process.platform === "win32") {
        try { child.kill("SIGKILL"); } catch {}
        return;
      }
      try { process.kill(-child.pid!, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    };
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
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new InstallerError("CANCELLED", "Installation cancelled.");
}

async function pathExists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}