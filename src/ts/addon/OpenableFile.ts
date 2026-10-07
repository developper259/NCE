import path from "path";
import { promises as fs } from "fs";

export const MAX_IMAGE_FILE_SIZE = 100 * 1024 * 1024;
export const BINARY_SAMPLE_SIZE = 8192;

export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
});

export function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes++;
  }
  return buffer.length > 0 && controlBytes / buffer.length > 0.05;
}

export function isOpenableImagePath(filePath: string, size: number): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension !== ".asar" &&
    Boolean(IMAGE_MIME_TYPES[extension]) &&
    size <= MAX_IMAGE_FILE_SIZE;
}

/**
 * Plain-text fallback is valid for unrecognized extensions; this preflight
 * mirrors FileManager's binary check and its supported image route.
 */
export function isOpenableFileSample(
  filePath: string,
  size: number,
  sample: Buffer,
): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".asar") return false;
  if (isOpenableImagePath(filePath, size)) return true;
  return !looksBinary(sample);
}

export async function isOpenableFileAtPath(
  filePath: string,
  size: number,
): Promise<boolean> {
  if (isOpenableImagePath(filePath, size)) return true;
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const sample = Buffer.alloc(Math.min(BINARY_SAMPLE_SIZE, size));
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return isOpenableFileSample(filePath, size, sample.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}
