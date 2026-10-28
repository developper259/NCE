import { safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

type SafeStorage = Pick<typeof safeStorage,
  "isEncryptionAvailable" | "encryptString" | "decryptString"> & {
    getSelectedStorageBackend?: () => string;
  };

type FileSystem = Pick<typeof fs,
  "readFile" | "mkdir" | "open" | "rename" | "unlink">;

export interface LegacyApiKeyMigrationResult {
  success: boolean;
  hadCredentials: boolean;
}

const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** Owns the one encrypted Agent credential file shared by all windows. */
export class AgentSecretStore {
  readonly secretsPath: string;
  private readonly storage: SafeStorage;
  private readonly filesystem: FileSystem;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    storage: SafeStorage = safeStorage,
    filesystem: FileSystem = fs,
  ) {
    this.secretsPath = path.join(userDataPath, "agent-secrets.json");
    this.storage = storage;
    this.filesystem = filesystem;
  }

  async get(providerId: string): Promise<string> {
    if (!this.isValidProviderId(providerId) || !this.encryptionAvailable()) return "";
    const records = await this.readRecords();
    if (!records) return "";
    try {
      return this.storage.decryptString(Buffer.from(records[providerId], "base64"));
    } catch {
      return "";
    }
  }

  async has(providerId: string): Promise<boolean> {
    if (!this.isValidProviderId(providerId) || !this.encryptionAvailable()) return false;
    const records = await this.readRecords();
    return Boolean(records?.[providerId]);
  }

  async set(providerId: string, apiKey: string): Promise<boolean> {
    if (!this.isValidProviderId(providerId) || typeof apiKey !== "string" ||
        !this.encryptionAvailable()) return false;
    return this.serialize(async () => {
      const records = await this.readRecords();
      if (!records) return false;
      if (apiKey) {
        const encrypted = this.encrypt(apiKey);
        if (!encrypted) return false;
        records[providerId] = encrypted;
      } else {
        delete records[providerId];
      }
      return this.persistAndVerify(records, apiKey ? { [providerId]: apiKey } : {});
    });
  }

  /** Existing encrypted values win; legacy values are only added for missing providers. */
  async migrateLegacyApiKeys(value: unknown): Promise<LegacyApiKeyMigrationResult> {
    if (value === undefined || value === null) return { success: true, hadCredentials: false };
    if (!this.isRecord(value)) return { success: false, hadCredentials: true };
    const entries = Object.entries(value);
    if (entries.length === 0) return { success: true, hadCredentials: false };
    const legacy = new Map<string, string>();
    for (const [providerId, credential] of entries) {
      if (!this.isValidProviderId(providerId) || typeof credential !== "string" ||
          !credential.trim()) return { success: false, hadCredentials: true };
      legacy.set(providerId, credential);
    }
    if (!this.encryptionAvailable()) return { success: false, hadCredentials: true };

    const success = await this.serialize(async () => {
      const records = await this.readRecords();
      if (!records) return false;
      const verify: Record<string, string> = {};
      let changed = false;
      for (const [providerId, credential] of legacy) {
        const stored = records[providerId];
        if (typeof stored === "string") {
          try {
            this.storage.decryptString(Buffer.from(stored, "base64"));
          } catch {
            return false;
          }
          continue;
        }
        const encrypted = this.encrypt(credential);
        if (!encrypted) return false;
        records[providerId] = encrypted;
        verify[providerId] = credential;
        changed = true;
      }
      if (!changed) return true;
      return this.persistAndVerify(records, verify);
    });
    return { success, hadCredentials: true };
  }

  private encryptionAvailable(): boolean {
    try {
      return this.storage.isEncryptionAvailable() &&
        this.storage.getSelectedStorageBackend?.() !== "basic_text";
    } catch {
      return false;
    }
  }

  private encrypt(value: string): string | null {
    try {
      const encrypted = this.storage.encryptString(value);
      if (this.storage.decryptString(encrypted) !== value) return null;
      return encrypted.toString("base64");
    } catch {
      return null;
    }
  }

  private async readRecords(): Promise<Record<string, string> | null> {
    try {
      const parsed: unknown = JSON.parse(await this.filesystem.readFile(this.secretsPath, "utf8"));
      if (!this.isRecord(parsed) || Object.values(parsed).some((value) => typeof value !== "string"))
        return null;
      return parsed as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      return null;
    }
  }

  private async persistAndVerify(
    records: Record<string, string>,
    expected: Record<string, string>,
  ): Promise<boolean> {
    const temporaryPath = `${this.secretsPath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<FileSystem["open"]>> | null = null;
    try {
      await this.filesystem.mkdir(path.dirname(this.secretsPath), { recursive: true });
      handle = await this.filesystem.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(records), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.filesystem.rename(temporaryPath, this.secretsPath);
      try {
        const directory = await this.filesystem.open(path.dirname(this.secretsPath), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {}

      const persisted = await this.readRecords();
      if (!persisted) return false;
      for (const [providerId, value] of Object.entries(expected)) {
        try {
          if (this.storage.decryptString(Buffer.from(persisted[providerId], "base64")) !== value)
            return false;
        } catch {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      try { await handle?.close(); } catch {}
      try { await this.filesystem.unlink(temporaryPath); } catch {}
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private isValidProviderId(value: unknown): value is string {
    return typeof value === "string" && PROVIDER_ID.test(value) &&
      !["__proto__", "constructor", "prototype"].includes(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
}
