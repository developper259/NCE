import path from "node:path";
import { promises as fs } from "node:fs";
import type { LspCommandCandidate, LspServerDefinition } from "./LspServerRegistry";
import type { LspServerConfiguration } from "./LspTypes";
import type { ManagedToolResolver } from "../packages/ManagedToolResolver";

export type LspExecutableSource = "configured" | "managed" | "path" | null;

export interface LspExecutableResolution {
  available: boolean;
  command: string | null;
  args: string[];
  source: LspExecutableSource;
  error: string | null;
  /**
   * Extra initialization options produced during resolution (for example the
   * resolved `tsserver.path`). Merged over the definition's own options.
   */
  initializationOptions?: Record<string, unknown>;
}

/**
 * Optional managed-tool resolution port. Only the two methods the LSP engine
 * needs are required, so callers can inject a real `ManagedToolResolver` or a
 * lightweight stub in tests.
 */
export interface ManagedToolPort {
  resolve(packageId: string, entryPoint?: string): ReturnType<ManagedToolResolver["resolve"]>;
}

export interface ResolveServerOptions {
  definition: LspServerDefinition;
  configuration: LspServerConfiguration | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** When provided, NCE-owned installations are preferred over PATH discovery. */
  managed?: ManagedToolPort | null;
}

function isExecutableFile(stats: { isFile(): boolean; mode: number }, platform: NodeJS.Platform): boolean {
  if (!stats.isFile()) return false;
  if (platform === "win32") return true;
  return (stats.mode & 0o111) !== 0;
}

async function checkCandidate(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  try {
    const stats = await fs.stat(candidate);
    return isExecutableFile(stats, platform) ? candidate : null;
  } catch {
    return null;
  }
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = String(env.PATHEXT || "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => /^\.[a-z0-9]+$/i.test(value));
  return configured.length ? configured : [".EXE", ".CMD", ".BAT", ".COM"];
}

async function resolveFromPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (command.includes("\0") || !command.trim()) return null;
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\"))
    return checkCandidate(path.resolve(command), platform);

  const separator = platform === "win32" ? ";" : ":";
  const directories = String(env.PATH || "")
    .split(separator)
    .map((value) => value.trim())
    .filter(Boolean);
  const extensions = platform === "win32" ? windowsExtensions(env) : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const resolved = await checkCandidate(
        path.join(directory, command.endsWith(extension.toLowerCase()) ? command : `${command}${extension}`),
        platform,
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Replace `{tsserver}` placeholders with the absolute `tsserver.js` of the
 * managed TypeScript package. Returns `null` when a placeholder is present but
 * the TypeScript SDK cannot be resolved, so the caller can report the real
 * reason instead of launching a server that will exit immediately.
 *
 * The substitution walks the object instead of splicing into serialized JSON: a
 * Windows path such as `C:\managed\...` contains backslashes that are not legal
 * JSON escapes, so splicing produced a SyntaxError and the server could never
 * launch on Windows.
 */
async function expandPlaceholders(
  options: Record<string, unknown> | undefined,
  managed: ManagedToolPort | null | undefined,
): Promise<{ options: Record<string, unknown> | undefined; error: string | null }> {
  if (!options) return { options, error: null };
  if (!containsPlaceholder(options)) return { options, error: null };

  if (!managed)
    return { options, error: "The TypeScript SDK path is required but no managed package resolver is available." };

  const typescript = await managed.resolve("typescript", "lib/tsserver.js");
  if (!typescript.available || !typescript.executable) {
    return {
      options,
      error: `The TypeScript SDK could not be resolved: ${typescript.error || "tsserver.js is missing"}.`,
    };
  }
  return { options: replacePlaceholder(options, typescript.executable) as Record<string, unknown>, error: null };
}

function containsPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{tsserver}");
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).some(containsPlaceholder);
  return false;
}

function replacePlaceholder(value: unknown, executable: string): unknown {
  if (typeof value === "string") return value.split("{tsserver}").join(executable);
  if (Array.isArray(value)) return value.map((entry) => replacePlaceholder(entry, executable));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = replacePlaceholder(entry, executable);
    }
    return output;
  }
  return value;
}

/**
 * Resolve how to launch a language server, without a shell.
 *
 * Order is deterministic and explicit:
 *   1. an absolute path configured by the user in settings.json;
 *   2. a valid installation owned by NCE, when the definition declares one;
 *   3. a binary discovered on PATH.
 *
 * A configured path always wins, so existing user setups keep working. A
 * managed installation wins over PATH so NCE never silently runs an unrelated
 * system binary that happens to share the name. Every failure names the source
 * that was tried.
 */
export async function resolveServerExecutable(
  options: ResolveServerOptions,
): Promise<LspExecutableResolution> {
  const {
    definition,
    configuration,
    env = process.env,
    platform = process.platform,
    managed = null,
  } = options;

  const configuredPath = typeof configuration?.path === "string"
    ? configuration.path.trim()
    : "";
  const configuredArgs = configuration && Array.isArray(configuration.args)
    ? configuration.args.filter((value): value is string => typeof value === "string")
    : null;

  if (definition.requiresConfiguration && !configuredPath && !configuredArgs) {
    return {
      available: false,
      command: null,
      args: [],
      source: null,
      error: `${definition.name} requires an explicit executable path and arguments. Configure lsp.servers in settings.json.`,
    };
  }

  // 1. Explicit user configuration always wins.
  if (configuredPath) {
    if (configuredPath.includes("\0") || !path.isAbsolute(configuredPath)) {
      return {
        available: false,
        command: null,
        args: [],
        source: null,
        error: "The configured server path must be absolute.",
      };
    }
    const resolved = await checkCandidate(path.resolve(configuredPath), platform);
    if (!resolved) {
      return {
        available: false,
        command: null,
        args: [],
        source: null,
        error: `The configured executable is missing or not executable: ${configuredPath}`,
      };
    }
    return {
      available: true,
      command: resolved,
      args: configuredArgs ?? definition.commands[0]?.args ?? [],
      source: "configured",
      error: null,
    };
  }

  // 2. A server NCE installed itself.
  if (definition.managed && managed) {
    const managedResolution = await resolveManaged(definition, managed, configuredArgs);
    if (managedResolution) return managedResolution;
  }

  // 3. PATH discovery of the registry candidates.
  for (const candidate of definition.commands as LspCommandCandidate[]) {
    const resolved = await resolveFromPath(candidate.command, env, platform);
    if (resolved) {
      return {
        available: true,
        command: resolved,
        args: configuredArgs ?? candidate.args,
        source: "path",
        error: null,
      };
    }
  }

  const managedHint = definition.managed
    ? ` Install ${definition.managed.packageId} from the Version Manager, or`
    : "";
  return {
    available: false,
    command: null,
    args: [],
    source: null,
    error: `Executable not found.${managedHint} install ${definition.commands[0]?.command || definition.id} or configure its absolute path.`,
  };
}

/**
 * Build the real launch command for a managed server.
 *
 * Returns `null` when the package is simply not installed, so the caller can
 * continue to PATH discovery. Any other problem (corrupted install, missing
 * runtime, missing entry point) is returned as an explicit failure: silently
 * falling back would hide a broken installation behind an unrelated binary.
 */
async function resolveManaged(
  definition: LspServerDefinition,
  managed: ManagedToolPort,
  configuredArgs: string[] | null,
): Promise<LspExecutableResolution | null> {
  const spec = definition.managed!;
  const server = await managed.resolve(spec.packageId, spec.entryPoint);

  const notInstalled = !server.available
    && server.error
    && /is not installed by NCE/.test(server.error);
  if (notInstalled) return null;

  if (!server.available || !server.executable) {
    return {
      available: false,
      command: null,
      args: [],
      source: null,
      error: `${definition.name} is installed by NCE but cannot be launched: ${server.error || "unknown error"}.`,
    };
  }

  const args = configuredArgs ?? spec.args;

  // A script entry point needs its runtime: `node <entry> --stdio`.
  if (spec.runtimePackageId) {
    const runtime = await managed.resolve(spec.runtimePackageId);
    if (!runtime.available || !runtime.executable) {
      return {
        available: false,
        command: null,
        args: [],
        source: null,
        error: `${definition.name} needs ${spec.runtimePackageId}, which is not usable: ${runtime.error || "not installed"}.`,
      };
    }
    const expanded = await expandPlaceholders(spec.initializationOptions, managed);
    if (expanded.error) {
      return { available: false, command: null, args: [], source: null, error: expanded.error };
    }
    return {
      available: true,
      command: runtime.executable,
      args: [server.executable, ...args],
      source: "managed",
      error: null,
      initializationOptions: expanded.options,
    };
  }

  const expanded = await expandPlaceholders(spec.initializationOptions, managed);
  if (expanded.error) {
    return { available: false, command: null, args: [], source: null, error: expanded.error };
  }
  return {
    available: true,
    command: server.executable,
    args,
    source: "managed",
    error: null,
    initializationOptions: expanded.options,
  };
}
