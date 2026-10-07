import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { NceWorkspaceStorage } from "./NceWorkspaceStorage";

export const DIRTY_BUFFER_RECOVERY_VERSION = 1;
export const MAX_RECOVERY_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_RECOVERY_RECORD_BYTES = MAX_RECOVERY_SNAPSHOT_BYTES * 7;
export const MAX_RECOVERY_SNAPSHOT_LINES = 100_000;
export const MAX_RECOVERY_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_RECOVERY_SNAPSHOTS = 32;
export const MAX_RECOVERY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DirtyBufferRecoveryInput {
  identity: string;
  kind: "path" | "untitled";
  filePath?: string | null;
  relativePath?: string | null;
  displayName: string;
  content: string;
  lineCount: number;
  editVersion: number;
  diskFingerprint?: string | null;
}

export interface DirtyBufferRecoveryMetadata {
  id: string;
  kind: "path" | "untitled";
  filePath: string | null;
  relativePath: string | null;
  displayName: string;
  timestamp: number;
  editVersion: number;
  diskFingerprint: string | null;
  diskChanged: boolean;
  diskMissing: boolean;
}

interface DirtyBufferRecoveryRecord extends DirtyBufferRecoveryInput {
  schemaVersion: number;
  id: string;
  timestamp: number;
}

type FileOperations = typeof fs;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength && !value.includes("\0");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class DirtyBufferRecoveryStore {
  readonly root: string;
  readonly recoveryRoot: string;
  private readonly operations: FileOperations;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    root: string,
    { operations = fs, now = Date.now }: {
      operations?: FileOperations;
      now?: () => number;
    } = {},
  ) {
    this.root = path.resolve(root);
    this.recoveryRoot = new NceWorkspaceStorage(this.root)
      .getTempPath("recovery");
    this.operations = operations;
    this.now = now;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private recordPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid recovery snapshot id.");
    return path.join(this.recoveryRoot, `${id}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    const storage = new NceWorkspaceStorage(this.root);
    await this.operations.mkdir(storage.nceRoot, { recursive: true });
    const nceStats = await this.operations.lstat(storage.nceRoot);
    if (nceStats.isSymbolicLink() || !nceStats.isDirectory())
      throw new Error("Recovery storage must remain inside the workspace.");
    await storage.ensureStructure();
    await this.operations.mkdir(this.recoveryRoot, { recursive: true });
    const [tempStats, recoveryStats, realTempRoot, realRecoveryRoot] = await Promise.all([
      this.operations.lstat(storage.tempRoot),
      this.operations.lstat(this.recoveryRoot),
      this.operations.realpath(storage.tempRoot),
      this.operations.realpath(this.recoveryRoot),
    ]);
    if (tempStats.isSymbolicLink() ||
        recoveryStats.isSymbolicLink() || !recoveryStats.isDirectory() ||
        !isInside(realTempRoot, realRecoveryRoot))
      throw new Error("Recovery storage must remain inside .nce/temp.");
  }

  private validateInput(input: DirtyBufferRecoveryInput): DirtyBufferRecoveryInput {
    if (!isRecord(input) || !validText(input.identity, 8192) ||
        (input.kind !== "path" && input.kind !== "untitled") ||
        !validText(input.displayName, 256) || typeof input.content !== "string" ||
        !Number.isSafeInteger(input.lineCount) || input.lineCount < 1 ||
        input.lineCount > MAX_RECOVERY_SNAPSHOT_LINES ||
        !Number.isSafeInteger(input.editVersion) || input.editVersion < 0) {
      throw new Error("Invalid dirty buffer recovery snapshot.");
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_RECOVERY_SNAPSHOT_BYTES)
      throw Object.assign(new Error("Recovery snapshot exceeds the size limit."), {
        code: "RECOVERY_SNAPSHOT_TOO_LARGE",
      });
    if (input.kind === "path") {
      if (!validText(input.filePath, 16_384) ||
          !path.isAbsolute(input.filePath))
        throw new Error("A path snapshot requires an absolute file path.");
      const resolved = path.resolve(input.filePath);
      const relativePath = isInside(this.root, resolved)
        ? path.relative(this.root, resolved).split(path.sep).join("/")
        : null;
      const expectedIdentity = `path:${relativePath ?? resolved}`;
      if (input.identity !== expectedIdentity)
        throw new Error("Recovery path identity does not match its file path.");
      return {
        ...input,
        identity: expectedIdentity,
        filePath: resolved,
        relativePath,
        diskFingerprint: validText(input.diskFingerprint, 256)
          ? input.diskFingerprint : null,
      };
    }
    if (input.filePath || input.relativePath ||
        !/^untitled:[A-Za-z0-9._-]{1,160}$/.test(input.identity))
      throw new Error("Invalid untitled recovery identity.");
    return {
      ...input,
      filePath: null,
      relativePath: null,
      diskFingerprint: null,
    };
  }

  private async readRecords(): Promise<DirtyBufferRecoveryRecord[]> {
    let names: string[];
    try {
      names = await this.operations.readdir(this.recoveryRoot);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const now = this.now();
    const records: DirtyBufferRecoveryRecord[] = [];
    await Promise.all(names.map(async (name) => {
      if (/^[a-f0-9]{64}\.\d+\.[a-f0-9]{16}\.tmp$/.test(name)) {
        await this.operations.rm(path.join(this.recoveryRoot, name), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        return;
      }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) return;
      const id = name.slice(0, -5);
      const target = path.join(this.recoveryRoot, name);
      try {
        const stats = await this.operations.lstat(target);
        if (!stats.isFile() || stats.isSymbolicLink() ||
            stats.size > MAX_RECOVERY_RECORD_BYTES) {
          await this.operations.rm(target, { force: true });
          return;
        }
        const parsed: unknown = JSON.parse(await this.operations.readFile(target, "utf8"));
        if (!isRecord(parsed) || parsed.schemaVersion !== DIRTY_BUFFER_RECOVERY_VERSION ||
            parsed.id !== id || !Number.isFinite(parsed.timestamp) ||
            now - Number(parsed.timestamp) > MAX_RECOVERY_AGE_MS ||
            Number(parsed.timestamp) > now + 5 * 60 * 1000 ||
            typeof parsed.content !== "string" ||
            Buffer.byteLength(parsed.content, "utf8") > MAX_RECOVERY_SNAPSHOT_BYTES ||
            !Number.isSafeInteger(parsed.lineCount) ||
            Number(parsed.lineCount) < 1 || Number(parsed.lineCount) > MAX_RECOVERY_SNAPSHOT_LINES ||
            !validText(parsed.identity, 8192) ||
            (parsed.kind !== "path" && parsed.kind !== "untitled") ||
            crypto.createHash("sha256").update(String(parsed.identity)).digest("hex") !== id ||
            !validText(parsed.displayName, 256) ||
            !Number.isSafeInteger(parsed.editVersion) || Number(parsed.editVersion) < 0) {
          await this.operations.rm(target, { force: true });
          return;
        }
        if (parsed.kind === "path" &&
            (!validText(parsed.filePath, 16_384) || !path.isAbsolute(parsed.filePath) ||
             typeof parsed.identity !== "string" || !parsed.identity.startsWith("path:"))) {
          await this.operations.rm(target, { force: true });
          return;
        }
        if (parsed.kind === "path") {
          const normalizedPath = path.resolve(parsed.filePath as string);
          const relativePath = isInside(this.root, normalizedPath)
            ? path.relative(this.root, normalizedPath).split(path.sep).join("/")
            : null;
          const expectedIdentity = `path:${relativePath ?? normalizedPath}`;
          if (parsed.filePath !== normalizedPath ||
              parsed.relativePath !== relativePath ||
              parsed.identity !== expectedIdentity) {
            await this.operations.rm(target, { force: true });
            return;
          }
        }
        if (parsed.kind === "untitled" &&
            (parsed.filePath || !/^untitled:[A-Za-z0-9._-]{1,160}$/.test(String(parsed.identity)))) {
          await this.operations.rm(target, { force: true });
          return;
        }
        records.push(parsed as unknown as DirtyBufferRecoveryRecord);
      } catch {
        await this.operations.rm(target, { force: true }).catch(() => undefined);
      }
    }));
    return records.sort((a, b) => b.timestamp - a.timestamp);
  }

  private async prune(records: DirtyBufferRecoveryRecord[], incomingBytes = 0, replacingId?: string): Promise<DirtyBufferRecoveryRecord[]> {
    const now = this.now();
    let retained = records.filter((record) => {
      const fresh = now - record.timestamp <= MAX_RECOVERY_AGE_MS;
      return fresh;
    });
    for (const record of records) {
      if (now - record.timestamp > MAX_RECOVERY_AGE_MS)
        await this.operations.rm(this.recordPath(record.id), { force: true });
    }
    const measureTotal = () => retained
      .filter((record) => record.id !== replacingId)
      .reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8"), 0);
    const incomingCount = incomingBytes > 0 ? 1 : 0;
    while (retained.filter((record) => record.id !== replacingId).length + incomingCount > MAX_RECOVERY_SNAPSHOTS ||
        measureTotal() + incomingBytes > MAX_RECOVERY_TOTAL_BYTES) {
      const oldest = [...retained].reverse().find((record) => record.id !== replacingId);
      if (!oldest) break;
      retained = retained.filter((record) => record.id !== oldest.id);
      await this.operations.rm(this.recordPath(oldest.id), { force: true });
    }
    return retained;
  }

  async save(inputValue: DirtyBufferRecoveryInput): Promise<{ success: boolean; id?: string; reason?: string }> {
    return this.serialize(async () => {
      let input: DirtyBufferRecoveryInput;
      try {
        input = this.validateInput(inputValue);
      } catch (error: any) {
        return { success: false, reason: error?.code || "INVALID_SNAPSHOT" };
      }
      const id = crypto.createHash("sha256").update(input.identity).digest("hex");
      const record: DirtyBufferRecoveryRecord = {
        ...input,
        schemaVersion: DIRTY_BUFFER_RECOVERY_VERSION,
        id,
        timestamp: this.now(),
      };
      const serialized = JSON.stringify(record);
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_RECOVERY_TOTAL_BYTES)
        return { success: false, reason: "RECOVERY_SNAPSHOT_TOO_LARGE" };
      try {
        await this.ensureDirectory();
        const records = await this.readRecords();
        await this.prune(records, bytes, id);
        const target = this.recordPath(id);
        const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
        try {
          const handle = await this.operations.open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(serialized, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await this.operations.rename(temporary, target);
          try {
            const directory = await this.operations.open(this.recoveryRoot, "r");
            try { await directory.sync(); }
            finally { await directory.close(); }
          } catch { /* directory fsync is not available on every platform */ }
        } catch (error) {
          await this.operations.rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        return { success: true, id };
      } catch (error: any) {
        return { success: false, reason: error?.code || "RECOVERY_WRITE_FAILED" };
      }
    });
  }

  async list(): Promise<DirtyBufferRecoveryMetadata[]> {
    return this.serialize(async () => {
      await this.ensureDirectory();
      const records = await this.readRecords();
      const retained = await this.prune(records);
      return Promise.all(retained.map(async (record) => {
          const disk = record.filePath ? await this.readDiskState(record.filePath) : null;
          const diskMissing = Boolean(record.filePath && disk && !disk.exists);
          const diskChanged = Boolean(record.filePath && record.diskFingerprint &&
            disk?.exists && disk.fingerprint !== record.diskFingerprint);
          return {
            id: record.id,
            kind: record.kind,
            filePath: record.filePath || null,
            relativePath: record.relativePath || null,
            displayName: record.displayName,
            timestamp: record.timestamp,
            editVersion: record.editVersion,
            diskFingerprint: record.diskFingerprint || null,
            diskChanged,
            diskMissing,
          };
        }));
    });
  }

  private async readDiskState(filePath: string): Promise<{ exists: boolean; fingerprint?: string } | null> {
    try {
      const stats = await this.operations.stat(filePath);
      if (!stats.isFile()) return { exists: false };
      return { exists: true, fingerprint: `${stats.size}:${stats.mtimeMs}` };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { exists: false };
      return null;
    }
  }

  async read(id: string): Promise<DirtyBufferRecoveryRecord | null> {
    return this.serialize(async () => {
      if (!/^[a-f0-9]{64}$/.test(id)) return null;
      try {
        await this.ensureDirectory();
        return (await this.readRecords()).find((record) => record.id === id) || null;
      } catch {
        return null;
      }
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.serialize(async () => {
      if (!/^[a-f0-9]{64}$/.test(id)) return false;
      try {
        await this.operations.rm(this.recordPath(id), { force: true });
        return true;
      } catch {
        return false;
      }
    });
  }
}
