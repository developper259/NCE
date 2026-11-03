import path from "node:path";
import { promises as fs } from "node:fs";
import type { LspCommandCandidate, LspServerDefinition } from "./LspServerRegistry";
import type { LspServerConfiguration } from "./LspTypes";

export interface LspExecutableResolution {
  available: boolean;
  command: string | null;
  args: string[];
  source: "configured" | "path" | null;
  error: string | null;
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
 * Resolve a language server executable without a shell. A user-configured
 * absolute path takes precedence over PATH discovery of the registry
 * candidates. Missing binaries stay explicit so NCE remains usable.
 */
export async function resolveServerExecutable(
  definition: LspServerDefinition,
  configuration: LspServerConfiguration | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<LspExecutableResolution> {
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
      error: `${definition.name} requires an explicit executable path and arguments. Configure them in Language Manager settings.`,
    };
  }

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

  return {
    available: false,
    command: null,
    args: [],
    source: null,
    error: `Executable not found. Install ${definition.commands[0]?.command || definition.id} or configure its absolute path.`,
  };
}
