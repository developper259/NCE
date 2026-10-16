import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSecretStore } from "./AgentSecretStore";

const STORE_VERSION = 1;
const MAX_SESSIONS = 8;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const METADATA_DEBOUNCE_MS = 150;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSession {
  id: string;
  workspacePath: string | null;
  bounds: WindowBounds | null;
  maximized: boolean;
  fullScreen: boolean;
  rendererState: Record<string, unknown> | null;
  lastActiveAt: number;
}

interface SessionSnapshot {
  version: number;
  lastActiveSessionId: string | null;
  sessions: WindowSession[];
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, limit = 4096): string | null {
  return typeof value === "string" && value.trim() && value.length <= limit &&
    !value.includes("\0") ? value : null;
}

function sanitizeBounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000 ||
      width < 1 || height < 1 || width > 20_000 || height > 20_000) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function sanitizeRendererState(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  try {
    const state = JSON.parse(JSON.stringify(value));
    if (state.agent && isRecord(state.agent)) delete state.agent.apiKeys;
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) return null;
    return state;
  } catch {
    return null;
  }
}

function workspaceKey(value: string | null, platform: NodeJS.Platform): string | null {
  if (!value) return null;
  const normalized = path.resolve(value).normalize("NFC");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export class WindowSessionStore {
  readonly storePath: string;
  readonly legacyStatePath: string;
  private readonly platform: NodeJS.Platform;
  private sessions = new Map<string, WindowSession>();
  private lastActiveSessionId: string | null = null;
  private writeQueue: Promise<boolean> = Promise.resolve(true);
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersistedContent: string | null = null;
  private initializePromise: Promise<WindowSession[]> | null = null;
  private readonly agentSecrets?: Pick<AgentSecretStore, "migrateLegacyApiKeys">;
  private readonly filesystem: typeof fs;
  private preserveLegacySessionFile = false;

  constructor(
    userDataPath: string,
    platform: NodeJS.Platform = process.platform,
    agentSecrets?: Pick<AgentSecretStore, "migrateLegacyApiKeys">,
    filesystem: typeof fs = fs,
  ) {
    this.storePath = path.join(userDataPath, "window-sessions.json");
    this.legacyStatePath = path.join(userDataPath, "state.json");
    this.platform = platform;
    this.agentSecrets = agentSecrets;
    this.filesystem = filesystem;
  }

  async initialize(): Promise<WindowSession[]> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeState();
    return this.initializePromise;
  }

  private async initializeState(): Promise<WindowSession[]> {
    let loaded = false;
    let rawSnapshot: Record<string, unknown> | null = null;
    let storedContent: string | null = null;
    try {
      const content = await this.filesystem.readFile(this.storePath, "utf8");
      storedContent = content;
      if (Buffer.byteLength(content, "utf8") <= MAX_STORE_BYTES) {
        const parsed: unknown = JSON.parse(content);
        if (isRecord(parsed) && parsed.version === STORE_VERSION && Array.isArray(parsed.sessions)) {
          rawSnapshot = parsed;
          loaded = true;
        } else {
          this.preserveLegacySessionFile = true;
        }
      } else {
        this.preserveLegacySessionFile = true;
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.preserveLegacySessionFile = true;
        console.warn("[Window Sessions] Invalid store; attempting migration without replacing the original file");
      }
    }

    const legacyState = await this.readLegacyState();
    const credentialSources = this.findLegacyCredentialSources(rawSnapshot, legacyState);
    let credentialsMigrated = credentialSources.length === 0;
    if (credentialSources.length > 0) {
      const credentials = this.combineLegacyCredentials(credentialSources);
      if (credentials && this.agentSecrets) {
        const result = await this.agentSecrets.migrateLegacyApiKeys(credentials);
        credentialsMigrated = result.success;
      }
      if (credentialsMigrated && legacyState && this.hasLegacyApiKeys(legacyState)) {
        const cleaned = this.cloneRecord(legacyState);
        this.removeLegacyApiKeys(cleaned);
        if (!(await this.writeJsonAtomically(this.legacyStatePath, cleaned))) {
          console.warn("[Window Sessions] Secure credentials saved; legacy state cleanup will retry on next startup");
        }
      } else if (!credentialsMigrated && this.snapshotContainsLegacyKeys(rawSnapshot)) {
        // Its existing session file is the sole recoverable copy. Do not
        // rewrite it until secure migration can be completed.
        this.preserveLegacySessionFile = true;
        console.warn("[Window Sessions] Agent credentials remain in the legacy session file because secure storage is unavailable");
      } else if (!credentialsMigrated) {
        console.warn("[Window Sessions] Agent credential migration could not use secure storage; the original state was preserved");
      }
    }

    if (loaded && rawSnapshot) this.loadSnapshot(rawSnapshot);
    else if (legacyState) this.migrateLegacyState(legacyState);
    if (!this.preserveLegacySessionFile) {
      const content = this.serializeSnapshot();
      if (storedContent === content) this.lastPersistedContent = content;
      await this.flush();
    }
    return this.getAll();
  }

  getAll(): WindowSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map((session) => this.clone(session));
  }

  get(id: string): WindowSession | null {
    const value = this.sessions.get(id);
    return value ? this.clone(value) : null;
  }

  getLastActiveSessionId(): string | null {
    return this.lastActiveSessionId;
  }

  create(input: Partial<WindowSession> = {}): WindowSession {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("WINDOW_LIMIT_REACHED");
    const id = safeText(input.id, 128) || randomUUID();
    if (this.sessions.has(id)) throw new Error("WINDOW_SESSION_ALREADY_EXISTS");
    const session: WindowSession = {
      id,
      workspacePath: safeText(input.workspacePath),
      bounds: sanitizeBounds(input.bounds),
      maximized: input.maximized === true,
      fullScreen: input.fullScreen === true,
      rendererState: sanitizeRendererState(input.rendererState),
      lastActiveAt: Number.isSafeInteger(input.lastActiveAt) && input.lastActiveAt! >= 0
        ? input.lastActiveAt! : Date.now(),
    };
    this.sessions.set(id, session);
    this.lastActiveSessionId = id;
    this.schedulePersistence();
    return this.clone(session);
  }

  update(id: string, patch: Partial<Omit<WindowSession, "id">>): boolean {
    const current = this.sessions.get(id);
    if (!current) return false;
    const next: WindowSession = {
      ...current,
      ...(Object.prototype.hasOwnProperty.call(patch, "workspacePath")
        ? { workspacePath: safeText(patch.workspacePath) } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "bounds")
        ? { bounds: sanitizeBounds(patch.bounds) } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "maximized")
        ? { maximized: patch.maximized === true } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "fullScreen")
        ? { fullScreen: patch.fullScreen === true } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "rendererState")
        ? { rendererState: sanitizeRendererState(patch.rendererState) } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "lastActiveAt")
        ? { lastActiveAt: Number.isSafeInteger(patch.lastActiveAt) && patch.lastActiveAt! >= 0
          ? patch.lastActiveAt! : current.lastActiveAt } : {}),
    };
    this.sessions.set(id, next);
    this.schedulePersistence();
    return true;
  }

  markActive(id: string): void {
    if (!this.sessions.has(id)) return;
    this.lastActiveSessionId = id;
    this.update(id, { lastActiveAt: Date.now() });
  }

  remove(id: string): boolean {
    const removed = this.sessions.delete(id);
    if (!removed) return false;
    if (this.lastActiveSessionId === id) {
      this.lastActiveSessionId = this.getAll()[0]?.id || null;
    }
    this.schedulePersistence();
    return true;
  }

  findByWorkspace(workspacePath: string): WindowSession | null {
    const key = workspaceKey(workspacePath, this.platform);
    if (!key) return null;
    for (const session of this.sessions.values()) {
      if (workspaceKey(session.workspacePath, this.platform) === key) return this.clone(session);
    }
    return null;
  }

  saveRendererState(id: string, rawState: string): Promise<boolean> {
    if (typeof rawState !== "string" || Buffer.byteLength(rawState, "utf8") > MAX_STATE_BYTES) {
      return Promise.resolve(false);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(rawState); } catch { return Promise.resolve(false); }
    if (!isRecord(parsed)) return Promise.resolve(false);
    const lastWorkspace = safeText(parsed.lastWorkspace) ||
      (isRecord(parsed.fileExplorer) ? safeText(parsed.fileExplorer.rootPath) : null);
    const sanitized = sanitizeRendererState(parsed);
    const current = this.sessions.get(id);
    if (!sanitized || !current) return Promise.resolve(false);
    this.sessions.set(id, { ...current, rendererState: sanitized, workspacePath: lastWorkspace });
    return this.persist();
  }

  async flush(): Promise<boolean> {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.preserveLegacySessionFile) return false;
    return this.persist();
  }

  private loadSnapshot(value: Record<string, any>): void {
    const sessions: WindowSession[] = [];
    const usedIds = new Set<string>();
    const usedWorkspaces = new Set<string>();
    for (const candidate of value.sessions.slice(0, MAX_SESSIONS)) {
      if (!isRecord(candidate)) continue;
      const id = safeText(candidate.id, 128);
      if (!id || usedIds.has(id)) continue;
      const workspacePath = safeText(candidate.workspacePath);
      const key = workspaceKey(workspacePath, this.platform);
      if (key && usedWorkspaces.has(key)) continue;
      const state = sanitizeRendererState(candidate.rendererState);
      const session: WindowSession = {
        id,
        workspacePath,
        bounds: sanitizeBounds(candidate.bounds),
        maximized: candidate.maximized === true,
        fullScreen: candidate.fullScreen === true,
        rendererState: state,
        lastActiveAt: Number.isSafeInteger(candidate.lastActiveAt) && candidate.lastActiveAt >= 0
          ? candidate.lastActiveAt : 0,
      };
      sessions.push(session);
      usedIds.add(id);
      if (key) usedWorkspaces.add(key);
    }
    this.sessions = new Map(sessions.map((session) => [session.id, session]));
    const lastActive = safeText(value.lastActiveSessionId, 128);
    this.lastActiveSessionId = lastActive && this.sessions.has(lastActive)
      ? lastActive : sessions[0]?.id || null;
  }

  private migrateLegacyState(state: Record<string, unknown>): void {
    const workspacePath = safeText(state.lastWorkspace) ||
      (isRecord(state.fileExplorer) ? safeText(state.fileExplorer.rootPath) : null);
    const session: WindowSession = {
      id: randomUUID(),
      workspacePath,
      bounds: null,
      maximized: false,
      fullScreen: false,
      rendererState: sanitizeRendererState(state),
      lastActiveAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.lastActiveSessionId = session.id;
  }

  private async readLegacyState(): Promise<Record<string, unknown> | null> {
    try {
      const content = await this.filesystem.readFile(this.legacyStatePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) return null;
      const state: unknown = JSON.parse(content);
      return isRecord(state) ? state : null;
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.warn("[Window Sessions] Legacy state migration failed; the original file was preserved");
      return null;
    }
  }

  private findLegacyCredentialSources(
    snapshot: Record<string, unknown> | null,
    legacyState: Record<string, unknown> | null,
  ): unknown[] {
    const sources: unknown[] = [];
    if (snapshot && Array.isArray(snapshot.sessions)) {
      for (const session of snapshot.sessions) {
        if (isRecord(session) && isRecord(session.rendererState) &&
            isRecord(session.rendererState.agent) &&
            Object.prototype.hasOwnProperty.call(session.rendererState.agent, "apiKeys")) {
          sources.push(session.rendererState.agent.apiKeys);
        }
      }
    }
    if (legacyState && isRecord(legacyState.agent) &&
        Object.prototype.hasOwnProperty.call(legacyState.agent, "apiKeys")) {
      sources.push(legacyState.agent.apiKeys);
    }
    return sources;
  }

  private combineLegacyCredentials(sources: unknown[]): Record<string, string> | null {
      const combined: Record<string, string> = Object.create(null);
    for (const source of sources) {
      if (!isRecord(source)) return null;
      for (const [provider, credential] of Object.entries(source)) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(provider) ||
            ["__proto__", "constructor", "prototype"].includes(provider) ||
            typeof credential !== "string" || !credential.trim())
          return null;
        if (Object.prototype.hasOwnProperty.call(combined, provider) && combined[provider] !== credential)
          return null;
        combined[provider] = credential;
      }
    }
    return combined;
  }

  private snapshotContainsLegacyKeys(snapshot: Record<string, unknown> | null): boolean {
    return this.findLegacyCredentialSources(snapshot, null).length > 0;
  }

  private hasLegacyApiKeys(state: Record<string, unknown>): boolean {
    return isRecord(state.agent) && Object.prototype.hasOwnProperty.call(state.agent, "apiKeys");
  }

  private removeLegacyApiKeys(state: Record<string, unknown>): void {
    if (isRecord(state.agent)) delete state.agent.apiKeys;
  }

  private cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value));
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<boolean> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      await this.filesystem.mkdir(path.dirname(filePath), { recursive: true });
      handle = await this.filesystem.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.filesystem.rename(temporaryPath, filePath);
      try {
        const directory = await this.filesystem.open(path.dirname(filePath), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {}
      return true;
    } catch {
      return false;
    } finally {
      try { await handle?.close(); } catch {}
      try { await this.filesystem.unlink(temporaryPath); } catch {}
    }
  }

  private schedulePersistence(): void {
    if (this.preserveLegacySessionFile) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.persist();
    }, METADATA_DEBOUNCE_MS);
  }

  private persist(): Promise<boolean> {
    const content = this.serializeSnapshot();
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) return Promise.resolve(false);
    const queued = this.writeQueue.then(async () => {
      if (content === this.lastPersistedContent) return true;
      const saved = await this.writeJsonAtomically(this.storePath, JSON.parse(content));
      if (saved) this.lastPersistedContent = content;
      else console.error("[Window Sessions] Failed to save sessions");
      return saved;
    }, async () => false);
    this.writeQueue = queued;
    return queued;
  }

  private serializeSnapshot(): string {
    const snapshot: SessionSnapshot = {
      version: STORE_VERSION,
      lastActiveSessionId: this.lastActiveSessionId,
      sessions: this.getAll(),
    };
    return `${JSON.stringify(snapshot, null, 2)}\n`;
  }

  private clone(value: WindowSession): WindowSession {
    return JSON.parse(JSON.stringify(value));
  }
}
