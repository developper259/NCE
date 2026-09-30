const fs = require("fs").promises;
const path = require("path");

export const LARGE_FILE_SCAN_CHUNK_SIZE = 1024 * 1024;

type Fingerprint = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
};

export type LargeFileEntry = {
  path: string;
  fingerprint: Fingerprint;
  size: number;
  totalLines: number;
  lineStarts: Float64Array;
  lineEndingKinds: Uint8Array;
  eol: string;
  hasFinalNewline: boolean;
};

type BuildToken = { cancelled: boolean };

class Float64IndexBuilder {
  private values = new Float64Array(4096);
  length = 0;

  push(value: number) {
    if (this.length === this.values.length) {
      const grown = new Float64Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length++] = value;
  }

  pop() {
    if (this.length > 0) this.length -= 1;
  }

  finish() {
    return this.values.slice(0, this.length);
  }
}

class Uint8IndexBuilder {
  private values = new Uint8Array(4096);
  length = 0;

  push(value: number) {
    if (this.length === this.values.length) {
      const grown = new Uint8Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length++] = value;
  }

  finish() {
    return this.values.slice(0, this.length);
  }
}

function pathKey(filePath: string) {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function fingerprint(stats: any): Fingerprint {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
    dev: stats.dev,
  };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.ino === right.ino &&
    left.dev === right.dev;
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** Stores line byte offsets for large files without retaining their text. */
export class LargeFileStore {
  private entries = new Map<string, LargeFileEntry>();
  private builds = new Map<string, Set<BuildToken>>();

  async index(filePath: string, initialStats: any): Promise<LargeFileEntry> {
    const key = pathKey(filePath);
    const token: BuildToken = { cancelled: false };
    const active = this.builds.get(key) || new Set<BuildToken>();
    active.add(token);
    this.builds.set(key, active);

    let handle: any = null;
    try {
      handle = await fs.open(filePath, "r");
      const openedStats = await handle.stat();
      const initialFingerprint = fingerprint(initialStats);
      if (!sameFingerprint(initialFingerprint, fingerprint(openedStats)))
        throw codedError("STALE_FILE_INDEX", "File changed before indexing started.");

      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const lineStarts = new Float64IndexBuilder();
      const lineEndingKinds = new Uint8IndexBuilder();
      lineStarts.push(0);
      const buffer = Buffer.alloc(LARGE_FILE_SCAN_CHUNK_SIZE);
      let offset = 0;
      let lastByte = -1;
      let lfCount = 0;
      let crlfCount = 0;
      let firstEndingKind = 0;

      while (offset < openedStats.size) {
        if (token.cancelled)
          throw codedError("FILE_LOAD_CANCELLED", "Large file indexing was cancelled.");
        const requested = Math.min(buffer.length, openedStats.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, requested, offset);
        if (bytesRead === 0)
          throw codedError("STALE_FILE_INDEX", "File ended while it was being indexed.");

        // Validate UTF-8 incrementally while discarding the decoded scan window.
        decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        const end = offset + bytesRead;
        let newline = buffer.indexOf(0x0a, 0);
        while (newline !== -1 && newline < bytesRead) {
          const previousByte = newline > 0 ? buffer[newline - 1] : lastByte;
          const kind = previousByte === 0x0d ? 2 : 1;
          lineEndingKinds.push(kind);
          lineStarts.push(end - bytesRead + newline + 1);
          if (kind === 2) crlfCount += 1;
          else lfCount += 1;
          if (firstEndingKind === 0) firstEndingKind = kind;
          newline = buffer.indexOf(0x0a, newline + 1);
        }
        lastByte = buffer[bytesRead - 1];
        offset = end;
      }
      decoder.decode();

      const hasFinalNewline = lastByte === 0x0a;
      if (hasFinalNewline) lineStarts.pop();
      const finalStats = await fs.stat(filePath);
      if (token.cancelled)
        throw codedError("FILE_LOAD_CANCELLED", "Large file indexing was cancelled.");
      const finalFingerprint = fingerprint(finalStats);
      if (!sameFingerprint(initialFingerprint, finalFingerprint))
        throw codedError("STALE_FILE_INDEX", "File changed while its line index was being built.");

      const entry: LargeFileEntry = {
        path: filePath,
        fingerprint: finalFingerprint,
        size: finalFingerprint.size,
        totalLines: lineStarts.length,
        lineStarts: lineStarts.finish(),
        lineEndingKinds: lineEndingKinds.finish(),
        eol: crlfCount > lfCount ||
          (crlfCount === lfCount && firstEndingKind === 2) ? "\r\n" : "\n",
        hasFinalNewline,
      };
      if (!token.cancelled) this.entries.set(key, entry);
      return entry;
    } catch (error: any) {
      if (error instanceof TypeError && /encoded data|utf-8/i.test(error.message))
        throw codedError("INVALID_UTF8", "File contains invalid UTF-8 text.");
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
      active.delete(token);
      if (active.size === 0) this.builds.delete(key);
    }
  }

  async getChunk(filePath: string, startLine: number, lineCount: number) {
    const key = pathKey(filePath);
    const entry = this.entries.get(key);
    if (!entry) return { success: false, lines: [], errorCode: "STALE_FILE_INDEX" };
    const start = Math.min(startLine, entry.totalLines);
    const end = Math.min(start + lineCount, entry.totalLines);
    if (end <= start) return { success: true, lines: [], lineEndings: [] as string[] };

    let handle: any = null;
    try {
      handle = await fs.open(filePath, "r");
      const before = fingerprint(await handle.stat());
      if (!sameFingerprint(entry.fingerprint, before))
        return { success: false, lines: [], errorCode: "STALE_FILE_INDEX" };

      const byteStart = entry.lineStarts[start];
      const byteEnd = end < entry.totalLines ? entry.lineStarts[end] : entry.size;
      const byteLength = Math.max(0, byteEnd - byteStart);
      const bytes = Buffer.alloc(byteLength);
      let bytesRead = 0;
      while (bytesRead < byteLength) {
        const result = await handle.read(
          bytes,
          bytesRead,
          byteLength - bytesRead,
          byteStart + bytesRead,
        );
        if (result.bytesRead === 0)
          return { success: false, lines: [], errorCode: "STALE_FILE_INDEX" };
        bytesRead += result.bytesRead;
      }

      const [afterHandle, afterPath] = await Promise.all([
        handle.stat(),
        fs.stat(filePath),
      ]);
      if (!sameFingerprint(entry.fingerprint, fingerprint(afterHandle)) ||
          !sameFingerprint(entry.fingerprint, fingerprint(afterPath)) ||
          this.entries.get(key) !== entry)
        return { success: false, lines: [], errorCode: "STALE_FILE_INDEX" };
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let text = decoder.decode(bytes);
      if (byteStart === 0 && text.charCodeAt(0) === 0xfeff)
        text = text.slice(1);
      const lines = text.split(/\r?\n/);
      if (text.endsWith("\n")) lines.pop();
      const lineEndings: string[] = [];
      for (let index = start; index < end && index < entry.lineEndingKinds.length; index += 1)
        lineEndings.push(entry.lineEndingKinds[index] === 2 ? "\r\n" : "\n");
      return { success: true, lines, lineEndings };
    } catch (error: any) {
      return {
        success: false,
        lines: [],
        errorCode: error?.code === "ENOENT" ? "STALE_FILE_INDEX" :
          error?.code || "INVALID_UTF8",
      };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  release(filePath: string, includeDescendants = false) {
    const key = pathKey(filePath);
    const prefix = `${key}${path.sep}`;
    let removed = 0;
    for (const [entryPath, tokens] of this.builds) {
      if (entryPath === key || (includeDescendants && entryPath.startsWith(prefix)))
        for (const token of tokens) token.cancelled = true;
    }
    for (const entryPath of this.entries.keys()) {
      if (entryPath === key || (includeDescendants && entryPath.startsWith(prefix))) {
        this.entries.delete(entryPath);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    for (const tokens of this.builds.values())
      for (const token of tokens) token.cancelled = true;
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }

  has(filePath: string) {
    return this.entries.has(pathKey(filePath));
  }
}
