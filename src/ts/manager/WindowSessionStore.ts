import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STORE_VERSION = 1;
const MAX_SESSIONS = 8;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

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
      width < 800 || height < 600 || width > 20_000 || height > 20_000) return null;
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

  constructor(userDataPath: string, platform: NodeJS.Platform = process.platform) {
    this.storePath = path.join(userDataPath, "window-sessions.json");
    this.legacyStatePath = path.join(userDataPath, "state.json");
    this.platform = platform;
  }

  async initialize(): Promise<WindowSession[]> {
    let loaded = false;
    try {
      const content = await fs.readFile(this.storePath, "utf8");
      if (Buffer.byteLength(content, "utf8") <= MAX_STORE_BYTES) {
        const parsed: unknown = JSON.parse(content);
        if (isRecord(parsed) && parsed.version === STORE_VERSION && Array.isArray(parsed.sessions)) {
          this.loadSnapshot(parsed);
          loaded = true;
        }
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.warn("[Window Sessions] Invalid store; attempting migration", error);
    }

    if (!loaded) await this.migrateLegacyState();
    if (this.sessions.size === 0) this.create({});
    await this.persist();
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
      rendererState: sanitizeRendererState(input.rendererState),
      lastActiveAt: Number.isSafeInteger(input.lastActiveAt) && input.lastActiveAt! >= 0
        ? input.lastActiveAt! : Date.now(),
    };
    this.sessions.set(id, session);
    this.lastActiveSessionId = id;
    void this.persist();
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
      ...(Object.prototype.hasOwnProperty.call(patch, "rendererState")
        ? { rendererState: sanitizeRendererState(patch.rendererState) } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "lastActiveAt")
        ? { lastActiveAt: Number.isSafeInteger(patch.lastActiveAt) && patch.lastActiveAt! >= 0
          ? patch.lastActiveAt! : current.lastActiveAt } : {}),
    };
    this.sessions.set(id, next);
    void this.persist();
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
    void this.persist();
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

  private async migrateLegacyState(): Promise<void> {
    try {
      const content = await fs.readFile(this.legacyStatePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) return;
      const state = JSON.parse(content);
      if (!isRecord(state)) return;
      const workspacePath = safeText(state.lastWorkspace) ||
        (isRecord(state.fileExplorer) ? safeText(state.fileExplorer.rootPath) : null);
      const session = this.create({
        workspacePath,
        rendererState: state,
      });
      this.lastActiveSessionId = session.id;
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.warn("[Window Sessions] Legacy state migration failed", error);
    }
  }

  private persist(): Promise<boolean> {
    this.writeQueue = this.writeQueue.catch(() => false).then(async () => {
      const snapshot: SessionSnapshot = {
        version: STORE_VERSION,
        lastActiveSessionId: this.lastActiveSessionId,
        sessions: this.getAll(),
      };
      const content = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) return false;
      const temporaryPath = `${this.storePath}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.storePath), { recursive: true });
        await fs.writeFile(temporaryPath, content, "utf8");
        await fs.rename(temporaryPath, this.storePath);
        return true;
      } catch (error) {
        console.error("[Window Sessions] Failed to save sessions", error);
        try { await fs.unlink(temporaryPath); } catch {}
        return false;
      }
    });
    return this.writeQueue;
  }

  private clone(value: WindowSession): WindowSession {
    return JSON.parse(JSON.stringify(value));
  }
}
