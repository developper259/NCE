import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { extract as tarExtract, type Header } from "tar-stream";
import yauzl from "yauzl";
import { InstallerError } from "./errors";
import type { ArchiveConfig } from "./types";

const MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LINK_TARGET_BYTES = 64 * 1024;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;

export async function extractArchive(
  archivePath: string,
  destDir: string,
  config: ArchiveConfig,
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const strip = config.stripComponents ?? 0;
  if (config.format === "zip") return extractZip(archivePath, destDir, strip, signal);
  if (config.format === "tar.gz") return extractTarGz(archivePath, destDir, strip, signal);
  throw new InstallerError("EXTRACTION_FAILED", `Unsupported archive format: ${String(config.format)}`);
}

/**
 * Shared entry-path gate: strips components, rejects absolute paths, drive
 * letters, ".." traversal and null bytes, and keeps every entry inside destDir.
 */
export function resolveEntryPath(
  entryName: string,
  destDir: string,
  stripComponents: number,
): string | null {
  if (entryName.includes("\0"))
    throw new InstallerError("EXTRACTION_FAILED", "Archive entry name contains a null byte.");
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized))
    throw new InstallerError("EXTRACTION_FAILED", `Archive entry uses an absolute path: ${entryName}`);
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === ".."))
    throw new InstallerError("EXTRACTION_FAILED", `Archive entry escapes the destination directory: ${entryName}`);
  const stripped = segments.slice(stripComponents);
  if (stripped.length === 0) return null;
  const target = path.resolve(destDir, ...stripped);
  if (!target.startsWith(destDir + path.sep))
    throw new InstallerError("EXTRACTION_FAILED", `Archive entry escapes the destination directory: ${entryName}`);
  return target;
}

async function assertFreshTarget(target: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing)
    throw new InstallerError("EXTRACTION_FAILED", `Refusing to overwrite an existing path during extraction: ${target}`);
}

/**
 * Links are never created: an in-tree link is materialized as a copy of its
 * regular-file target, and anything pointing outside the destination is
 * rejected. This keeps symlink-based escapes impossible on every platform.
 * Targets may appear later in the archive, so copies happen in final passes.
 */
interface PendingLink {
  linkPath: string;
  linkName: string;
}

function linkTargetPath(linkPath: string, linkName: string, destDir: string): string {
  if (!linkName || linkName.includes("\0") || linkName.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(linkName))
    throw new InstallerError("EXTRACTION_FAILED", `Archive link points outside the destination directory: ${linkName}`);
  const resolvedTarget = path.resolve(path.dirname(linkPath), linkName);
  if (!resolvedTarget.startsWith(destDir + path.sep))
    throw new InstallerError("EXTRACTION_FAILED", `Archive link points outside the destination directory: ${linkName}`);
  return resolvedTarget;
}

async function resolvePendingLinks(pending: PendingLink[], destDir: string): Promise<void> {
  let remaining = pending;
  while (remaining.length > 0) {
    const deferred: PendingLink[] = [];
    for (const link of remaining) {
      const resolvedTarget = linkTargetPath(link.linkPath, link.linkName, destDir);
      const stats = await fs.lstat(resolvedTarget).catch(() => null);
      if (!stats?.isFile()) {
        deferred.push(link);
        continue;
      }
      await assertFreshTarget(link.linkPath);
      await fs.mkdir(path.dirname(link.linkPath), { recursive: true });
      await fs.copyFile(resolvedTarget, link.linkPath);
    }
    if (deferred.length === remaining.length)
      throw new InstallerError("EXTRACTION_FAILED", `Archive link target is missing or not a regular file: ${deferred[0].linkName}`);
    remaining = deferred;
  }
}

async function readEntryBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_LINK_TARGET_BYTES)
      throw new InstallerError("EXTRACTION_FAILED", "Archive link target exceeds the size limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InstallerError("CANCELLED", "Installation cancelled.");
}

async function extractZip(
  archivePath: string,
  destDir: string,
  strip: number,
  signal?: AbortSignal,
): Promise<void> {
  let totalBytes = 0;
  const pendingLinks: PendingLink[] = [];
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError: Error | null, zipfile: yauzl.ZipFile) => {
      if (openError || !zipfile) {
        reject(new InstallerError("EXTRACTION_FAILED", `Could not open ZIP archive: ${openError?.message ?? "unknown error"}`));
        return;
      }
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        zipfile.close();
        if (error) reject(error instanceof InstallerError ? error : new InstallerError("EXTRACTION_FAILED", `ZIP extraction failed: ${String(error)}`));
        else resolve();
      };
      const onAbort = () => finish(new InstallerError("CANCELLED", "Installation cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
      zipfile.on("error", (error: Error) => finish(error));
      zipfile.on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        finish();
      });
      zipfile.on("entry", (entry: yauzl.Entry) => {
        handleEntry(entry)
          .then(() => {
            if (settled) return;
            throwIfAborted(signal);
            zipfile.readEntry();
          })
          .catch(finish);
      });
      zipfile.readEntry();

      async function handleEntry(entry: yauzl.Entry): Promise<void> {
        throwIfAborted(signal);
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = unixMode & S_IFMT;
        if (fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR && fileType !== S_IFLNK)
          throw new InstallerError("EXTRACTION_FAILED", `Archive entry is a special file: ${entry.fileName}`);
        const target = resolveEntryPath(entry.fileName, destDir, strip);
        if (!target) return;
        if (fileType === S_IFLNK) {
          const linkName = (await readEntryBuffer(await openEntryStream(entry))).toString("utf8");
          linkTargetPath(target, linkName, destDir);
          pendingLinks.push({ linkPath: target, linkName });
          return;
        }
        const isDirectory = entry.fileName.endsWith("/") || fileType === S_IFDIR;
        if (isDirectory) {
          await fs.mkdir(target, { recursive: true });
          return;
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_EXTRACT_BYTES)
          throw new InstallerError("EXTRACTION_FAILED", "Archive exceeds the extracted size limit.");
        await assertFreshTarget(target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const mode = unixMode & 0o777;
        await pipeline(await openEntryStream(entry), createWriteStream(target, { mode: mode || 0o644 }));
      }

      function openEntryStream(entry: yauzl.Entry): Promise<Readable> {
        return new Promise<Readable>((resolveStream, rejectStream) => {
          zipfile.openReadStream(entry, (error: Error | null, readable: Readable) => {
            if (error || !readable) rejectStream(error ?? new Error("missing entry stream"));
            else resolveStream(readable);
          });
        });
      }
    });
  });
  await resolvePendingLinks(pendingLinks, destDir);
}

async function extractTarGz(
  archivePath: string,
  destDir: string,
  strip: number,
  signal?: AbortSignal,
): Promise<void> {
  let totalBytes = 0;
  const pendingLinks: PendingLink[] = [];
  const extract = tarExtract();
  extract.on(
    "entry",
    (
      header: Header,
      stream: { resume(): unknown; [Symbol.asyncIterator](): AsyncIterator<unknown> },
      next: (error?: Error | null) => void,
    ) => {
      handleEntry(header, stream)
        .then(() => next())
        .catch((error) => next(error instanceof Error ? error : new Error(String(error))));
    },
  );
  await pipeline(createReadStream(archivePath), createGunzip(), extract);
  await resolvePendingLinks(pendingLinks, destDir);

  async function handleEntry(
    header: Header,
    stream: { resume(): unknown; [Symbol.asyncIterator](): AsyncIterator<unknown> },
  ): Promise<void> {
    throwIfAborted(signal);
    if (header.type !== "file" && header.type !== "directory" && header.type !== "symlink" && header.type !== "link") {
      stream.resume();
      throw new InstallerError("EXTRACTION_FAILED", `Archive entry is a special file: ${header.name} (${header.type})`);
    }
    const target = resolveEntryPath(header.name, destDir, strip);
    if (!target) {
      stream.resume();
      return;
    }
    if (header.type === "symlink" || header.type === "link") {
      stream.resume();
      const linkName = header.linkname ?? "";
      linkTargetPath(target, linkName, destDir);
      pendingLinks.push({ linkPath: target, linkName });
      return;
    }
    if (header.type === "directory") {
      await fs.mkdir(target, { recursive: true });
      stream.resume();
      return;
    }
    totalBytes += header.size ?? 0;
    if (totalBytes > MAX_EXTRACT_BYTES) {
      stream.resume();
      throw new InstallerError("EXTRACTION_FAILED", "Archive exceeds the extracted size limit.");
    }
    await assertFreshTarget(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const mode = (header.mode ?? 0o644) & 0o777;
    await pipeline(Readable.from(stream as AsyncIterable<Buffer>), createWriteStream(target, { mode: mode || 0o644 }));
  }
}