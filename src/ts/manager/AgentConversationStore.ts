import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { safeStorage } from "electron";

export const AGENT_CONVERSATION_MAX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 64 * 1024;
const MAX_SESSIONS = 256;
const MAX_MESSAGES = 10_000;
const MAX_ITEMS = 2_000;
const MAX_TOTAL_ITEMS = 20_000;
const MAX_TEXT = 512 * 1024;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const USAGE_KEYS = [
  "runs", "userMessages", "modelRequests", "actualPromptTokens",
  "estimatedPromptTokens", "completedRuns", "cancelledRuns", "failedRuns",
] as const;
const MESSAGE_KEYS = [
  "id", "role", "type", "content", "timestamp", "runId", "status",
  "startedAt", "finishedAt", "collapsed", "streaming", "hasErrors", "items",
] as const;
const ACTIVITY_KEYS = [
  "id", "toolName", "type", "title", "detail", "status", "startedAt",
  "finishedAt", "aggregate", "modificationCount", "completedModifications",
  "failedModifications", "files", "diffStats", "errors", "modelEventKind",
] as const;

export interface ConversationStoreStatus {
  available: boolean;
  reason?: "ENCRYPTION_UNAVAILABLE" | "INSECURE_STORAGE_BACKEND" | "STORE_ERROR";
}

export interface AgentConversationSnapshot {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Record<string, any>[];
  usage: Record<string, number>;
}

type SafeStorageLike = Pick<typeof safeStorage,
  "isEncryptionAvailable" | "encryptString" | "decryptString"
> & { getSelectedStorageBackend?: () => string };

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && SESSION_ID.test(value);
}

function boundedText(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.floor(value), 1_000_000_000))
    : undefined;
}

function copyAllowed(source: Record<string, any>, keys: readonly string[], itemLimit = MAX_ITEMS) {
  const output: Record<string, any> = {};
  for (const key of keys) {
    const value = source[key];
    if (key === "items" && Array.isArray(value)) {
      output.items = value.slice(0, itemLimit).map((item) => sanitizeActivityItem(item)).filter(Boolean);
    } else if (key === "diffStats" && isRecord(value)) {
      output.diffStats = {
        additions: safeNumber(value.additions) || 0,
        deletions: safeNumber(value.deletions) || 0,
      };
    } else if (key === "files" && Array.isArray(value)) {
      output.files = value.slice(0, 256).map((entry) => boundedText(entry, 1024)).filter(Boolean);
    } else if (key === "errors" && Array.isArray(value)) {
      output.errors = value.slice(0, 100).map((entry) => boundedText(entry, 4096)).filter(Boolean);
    } else if (["content", "title", "detail", "timestamp", "toolName", "type", "role", "status", "id", "aggregate", "modelEventKind"].includes(key)) {
      const text = boundedText(value, key === "content" ? MAX_TEXT : 4096);
      if (text !== undefined) output[key] = text;
    } else if (["startedAt", "finishedAt", "runId", "modificationCount", "completedModifications", "failedModifications"].includes(key)) {
      const number = safeNumber(value);
      if (number !== undefined) output[key] = number;
    } else if (["collapsed", "streaming", "hasErrors"].includes(key) && typeof value === "boolean") {
      output[key] = key === "streaming" ? false : value;
    }
  }
  return output;
}

function sanitizeActivityItem(value: unknown): Record<string, any> | null {
  if (!isRecord(value)) return null;
  const result = copyAllowed(value, ACTIVITY_KEYS);
  if (result.status === "running" || result.status === "pending") result.status = "cancelled";
  return result;
}

export function sanitizeAgentConversation(value: unknown): AgentConversationSnapshot | null {
  if (!isRecord(value) || value.version !== 1 || !validSessionId(value.id)) return null;
  if (!Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) return null;
  const messages: Record<string, any>[] = [];
  let totalItems = 0;
  for (const candidate of value.messages) {
    if (!isRecord(candidate)) continue;
    const role = candidate.role;
    const type = candidate.type;
    if (!["user", "agent", "activity"].includes(role) && !["assistant", "reasoning", "activity"].includes(type)) continue;
    const remainingItems = Math.max(0, MAX_TOTAL_ITEMS - totalItems);
    const message = copyAllowed(candidate, MESSAGE_KEYS, remainingItems);
    totalItems += message.items?.length || 0;
    if (message.role === "approval") continue;
    if (message.status === "running" || message.status === "pending") message.status = "cancelled";
    message.streaming = false;
    if (Array.isArray(message.items)) {
      message.items = message.items.filter((item: any) => item?.type !== "approval");
    }
    messages.push(message);
  }
  const usage: Record<string, number> = {};
  if (isRecord(value.usage)) {
    for (const key of USAGE_KEYS) usage[key] = safeNumber(value.usage[key]) || 0;
  }
  return {
    version: 1,
    id: value.id,
    title: boundedText(value.title, 512) || "New chat",
    createdAt: safeNumber(value.createdAt) || Date.now(),
    updatedAt: safeNumber(value.updatedAt) || Date.now(),
    messages,
    usage,
  };
}

/** Encrypts userData conversation files against direct at-rest inspection. A compromised
 * process running as the same OS user or a fully compromised machine is out of scope. */
export class AgentConversationStore {
  readonly root: string;
  readonly sessionsRoot: string;
  private storage: SafeStorageLike;
  private filesystem: typeof fs;
  private key: Buffer | null = null;
  private status: ConversationStoreStatus = { available: false, reason: "ENCRYPTION_UNAVAILABLE" };
  private index: { version: 1; activeSessionId: string | null; sessionIds: string[] } = {
    version: 1, activeSessionId: null, sessionIds: [],
  };
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(userDataPath: string, storage: SafeStorageLike = safeStorage, filesystem: typeof fs = fs) {
    this.root = path.join(userDataPath, "agent-conversations");
    this.sessionsRoot = path.join(this.root, "sessions");
    this.storage = storage;
    this.filesystem = filesystem;
  }

  getStatus(): ConversationStoreStatus { return { ...this.status }; }

  async initialize(): Promise<ConversationStoreStatus> {
    if (!this.storage.isEncryptionAvailable()) {
      this.status = { available: false, reason: "ENCRYPTION_UNAVAILABLE" };
      return this.getStatus();
    }
    if (this.storage.getSelectedStorageBackend?.() === "basic_text") {
      this.status = { available: false, reason: "INSECURE_STORAGE_BACKEND" };
      return this.getStatus();
    }
    try {
      await this.filesystem.mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 });
      this.key = await this.loadOrCreateKey();
      this.status = { available: true };
      await this.loadIndex();
    } catch (error) {
      this.key = null;
      this.status = { available: false, reason: "STORE_ERROR" };
      console.warn("[NCE Agent Conversations] Store initialization failed", { code: (error as any)?.code || "STORE_ERROR" });
    }
    return this.getStatus();
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    const file = path.join(this.root, "master-key.json");
    try {
      const stat = await this.filesystem.stat(file);
      if (stat.size > 16 * 1024) throw new Error("KEY_FILE_TOO_LARGE");
      const envelope = JSON.parse(await this.filesystem.readFile(file, "utf8"));
      if (envelope?.version !== 1 || envelope?.provider !== "electron-safe-storage" || typeof envelope.encryptedKey !== "string") throw new Error("INVALID_KEY_FILE");
      const raw = Buffer.from(this.storage.decryptString(Buffer.from(envelope.encryptedKey, "base64")), "base64");
      if (raw.length !== 32) throw new Error("INVALID_KEY");
      return raw;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const existingSessions = await this.filesystem.readdir(this.sessionsRoot).catch(() => [] as string[]);
    const existingIndex = await this.filesystem.stat(path.join(this.root, "index.enc")).then(() => true).catch(() => false);
    if (existingSessions.some((entry) => entry.endsWith(".enc")) || existingIndex) {
      throw new Error("MASTER_KEY_MISSING_WITH_ENCRYPTED_DATA");
    }
    const raw = crypto.randomBytes(32);
    const encrypted = this.storage.encryptString(raw.toString("base64")).toString("base64");
    await this.atomicWrite(file, JSON.stringify({ version: 1, provider: "electron-safe-storage", encryptedKey: encrypted }), 0o600);
    return raw;
  }

  private aad(purpose: string, id?: string) {
    return Buffer.from(id ? `nce-agent-conversation:v1:${id}` : `nce-agent-conversations:${purpose}:v1`);
  }

  private encrypt(text: string, aad: Buffer) {
    if (!this.key) throw new Error("STORE_UNAVAILABLE");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  }

  private decrypt(envelopeText: string, aad: Buffer) {
    if (!this.key) throw new Error("STORE_UNAVAILABLE");
    const envelope = JSON.parse(envelopeText);
    if (envelope?.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("INVALID_ENVELOPE");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("INVALID_ENVELOPE");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  private async atomicWrite(target: string, contents: string, mode = 0o600) {
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await this.filesystem.open(temporary, "wx", mode);
      try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await this.filesystem.rename(temporary, target);
      try { const directory = await this.filesystem.open(path.dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); } } catch {}
    } finally { await this.filesystem.rm(temporary, { force: true }).catch(() => undefined); }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = result;
    return result;
  }

  private async readEnvelope(file: string, max: number, aad: Buffer): Promise<string> {
    const stat = await this.filesystem.stat(file);
    if (stat.size > max) throw new Error("FILE_TOO_LARGE");
    return this.decrypt(await this.filesystem.readFile(file, "utf8"), aad);
  }

  private async saveIndex() {
    const encrypted = this.encrypt(JSON.stringify(this.index), this.aad("index"));
    await this.atomicWrite(path.join(this.root, "index.enc"), encrypted);
  }

  private async loadIndex() {
    const file = path.join(this.root, "index.enc");
    try {
      const text = await this.readEnvelope(file, MAX_INDEX_BYTES, this.aad("index"));
      const parsed = JSON.parse(text);
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessionIds)) throw new Error("INVALID_INDEX");
      const ids = (parsed.sessionIds as unknown[])
        .filter((id): id is string => validSessionId(id))
        .slice(0, MAX_SESSIONS);
      this.index = { version: 1, sessionIds: [...new Set(ids)], activeSessionId: typeof parsed.activeSessionId === "string" && ids.includes(parsed.activeSessionId) ? parsed.activeSessionId : null };
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.warn("[NCE Agent Conversations] Index could not be loaded", { code: error?.code || "INDEX_INVALID" });
      this.index = await this.recoverIndex();
      if (this.index.sessionIds.length) await this.saveIndex().catch(() => undefined);
    }
  }

  private async recoverIndex() {
    const ids: string[] = [];
    for (const entry of await this.filesystem.readdir(this.sessionsRoot, { withFileTypes: true }).catch(() => [] as any[])) {
      if (entry.isFile() && entry.name.endsWith(".enc")) {
        const id = entry.name.slice(0, -4);
        if (validSessionId(id)) ids.push(id);
      }
    }
    return { version: 1 as const, sessionIds: ids.slice(0, MAX_SESSIONS), activeSessionId: null };
  }

  async load(): Promise<{ status: ConversationStoreStatus; activeSessionId: string | null; sessionIds: string[]; sessions: AgentConversationSnapshot[] }> {
    await this.operationQueue.catch(() => undefined);
    if (!this.status.available) return { status: this.getStatus(), activeSessionId: null, sessionIds: [], sessions: [] };
    const sessions: AgentConversationSnapshot[] = [];
    for (const id of this.index.sessionIds) {
      try {
        const text = await this.readEnvelope(path.join(this.sessionsRoot, `${id}.enc`), AGENT_CONVERSATION_MAX_BYTES, this.aad("session", id));
        const snapshot = sanitizeAgentConversation(JSON.parse(text));
        if (snapshot?.id === id) sessions.push(snapshot);
      } catch (error: any) {
        console.warn("[NCE Agent Conversations] Session rejected", { sessionId: id, code: error?.code || "AUTH_OR_PARSE_FAILURE" });
      }
    }
    const validIds = sessions.map((session) => session.id);
    const activeSessionId = validIds.includes(this.index.activeSessionId || "") ? this.index.activeSessionId : validIds[0] || null;
    if (validIds.length !== this.index.sessionIds.length || validIds.some((id, index) => id !== this.index.sessionIds[index])) {
      this.index.sessionIds = validIds;
      this.index.activeSessionId = activeSessionId;
      await this.saveIndex().catch(() => undefined);
    }
    return { status: this.getStatus(), activeSessionId, sessionIds: validIds, sessions };
  }

  save(snapshotInput: unknown): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.status.available) return false;
      const snapshot = sanitizeAgentConversation(snapshotInput);
      if (!snapshot) return false;
      const encrypted = this.encrypt(JSON.stringify(snapshot), this.aad("session", snapshot.id));
      if (Buffer.byteLength(encrypted) > AGENT_CONVERSATION_MAX_BYTES) return false;
      await this.atomicWrite(path.join(this.sessionsRoot, `${snapshot.id}.enc`), encrypted);
      let indexChanged = false;
      if (!this.index.sessionIds.includes(snapshot.id)) {
        this.index.sessionIds.push(snapshot.id);
        indexChanged = true;
      }
      this.index.sessionIds = this.index.sessionIds.slice(0, MAX_SESSIONS);
      if (!this.index.activeSessionId) {
        this.index.activeSessionId = snapshot.id;
        indexChanged = true;
      }
      if (indexChanged) await this.saveIndex();
      return true;
    });
  }

  setActive(sessionId: unknown): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.status.available || !validSessionId(sessionId) || !this.index.sessionIds.includes(sessionId)) return false;
      this.index.activeSessionId = sessionId;
      if (!this.index.sessionIds.includes(sessionId)) this.index.sessionIds.push(sessionId);
      await this.saveIndex();
      return true;
    });
  }

  async flush(): Promise<boolean> {
    try { await this.operationQueue; return this.status.available; }
    catch { return false; }
  }

  delete(sessionId: unknown, nextActiveId?: unknown): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.status.available || !validSessionId(sessionId)) return false;
      await this.filesystem.rm(path.join(this.sessionsRoot, `${sessionId}.enc`), { force: true });
      this.index.sessionIds = this.index.sessionIds.filter((id) => id !== sessionId);
      this.index.activeSessionId = validSessionId(nextActiveId) && this.index.sessionIds.includes(nextActiveId)
        ? nextActiveId : this.index.sessionIds[0] || null;
      await this.saveIndex();
      return true;
    });
  }
}
