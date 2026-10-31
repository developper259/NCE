import type { LspServerConfiguration, LspSettingsValue } from "./LspTypes";

const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SERVERS = 64;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 1_024;
const MAX_PATH_LENGTH = 2_048;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isValidLspServerConfiguration(value: unknown): value is LspServerConfiguration {
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!["enabled", "path", "args"].includes(key)) return false;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.path !== undefined) {
    if (typeof value.path !== "string" || value.path.length > MAX_PATH_LENGTH || value.path.includes("\0"))
      return false;
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > MAX_ARGS) return false;
    if (!value.args.every((entry) =>
      typeof entry === "string" && entry.length <= MAX_ARG_LENGTH && !entry.includes("\0")))
      return false;
  }
  return true;
}

export function isValidLspServers(value: unknown): boolean {
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_SERVERS) return false;
  for (const [id, configuration] of entries) {
    if (!SERVER_ID_PATTERN.test(id)) return false;
    if (!isValidLspServerConfiguration(configuration)) return false;
  }
  return true;
}

export const DEFAULT_LSP_SETTINGS: LspSettingsValue = Object.freeze({
  enabled: true,
  servers: {},
});

/** Defensive read of settings.json values, independent of the UI schema. */
export function sanitizeLspSettings(value: unknown): LspSettingsValue {
  if (!isObject(value)) return { enabled: true, servers: {} };
  const enabled = typeof value.enabled === "boolean" ? value.enabled : true;
  const servers: Record<string, LspServerConfiguration> = {};
  if (isObject(value.servers)) {
    for (const [id, configuration] of Object.entries(value.servers)) {
      if (!SERVER_ID_PATTERN.test(id) || !isValidLspServerConfiguration(configuration))
        continue;
      servers[id] = {
        ...(configuration.enabled === undefined ? {} : { enabled: configuration.enabled }),
        ...(configuration.path === undefined ? {} : { path: configuration.path }),
        ...(configuration.args === undefined ? {} : { args: [...configuration.args] }),
      };
    }
  }
  return { enabled, servers };
}
