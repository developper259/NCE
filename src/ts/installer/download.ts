import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { InstallerError } from "./errors";
import type { ChecksumAlgorithm } from "./types";

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 60_000;

export interface DownloadOutcome {
  bytes: number;
  checksum: string;
}

export interface DownloadOptions {
  algorithm: ChecksumAlgorithm;
  signal?: AbortSignal;
  onBytes?: (receivedBytes: number, totalBytes?: number) => void;
}

/** HTTPS everywhere; plain HTTP is tolerated only on loopback for local tests. */
export function isAllowedDownloadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

export async function downloadFile(
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<DownloadOutcome> {
  try {
    return await downloadWithRedirects(url, destination, options);
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

async function downloadWithRedirects(
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<DownloadOutcome> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownloadUrl(current))
      throw new InstallerError("DOWNLOAD_FAILED", `Refusing to download from an untrusted URL: ${current}`);
    const outcome = await requestOnce(current, destination, options);
    if (outcome.kind === "done") return outcome.result;
    current = new URL(outcome.location, current).toString();
  }
  throw new InstallerError("DOWNLOAD_FAILED", `Too many redirects while downloading ${url}`);
}

type HopOutcome =
  | { kind: "done"; result: DownloadOutcome }
  | { kind: "redirect"; location: string };

function requestOnce(
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<HopOutcome> {
  return new Promise<HopOutcome>((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(
      parsed,
      { headers: { "user-agent": "NCE-Installer", accept: "*/*" } },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          cleanup();
          resolve({ kind: "redirect", location: response.headers.location });
          return;
        }
        if (status !== 200) {
          response.resume();
          cleanup();
          reject(new InstallerError("DOWNLOAD_FAILED", `Download failed with HTTP ${status} for ${url}`));
          return;
        }
        const declared = Number(response.headers["content-length"]);
        const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : undefined;
        if (totalBytes !== undefined && totalBytes > MAX_DOWNLOAD_BYTES) {
          response.resume();
          cleanup();
          reject(new InstallerError("DOWNLOAD_FAILED", `Download exceeds the ${MAX_DOWNLOAD_BYTES} byte limit: ${url}`));
          return;
        }
        const hash = createHash(options.algorithm);
        let bytes = 0;
        const meter = new PassThrough();
        meter.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_DOWNLOAD_BYTES) {
            meter.destroy(new InstallerError("DOWNLOAD_FAILED", `Download exceeds the ${MAX_DOWNLOAD_BYTES} byte limit: ${url}`));
            return;
          }
          hash.update(chunk);
          options.onBytes?.(bytes, totalBytes);
        });
        pipeline(response, meter, createWriteStream(destination))
          .then(() => {
            cleanup();
            if (totalBytes !== undefined && bytes !== totalBytes) {
              reject(new InstallerError("DOWNLOAD_FAILED", `Download truncated: expected ${totalBytes} bytes, received ${bytes}.`));
              return;
            }
            resolve({ kind: "done", result: { bytes, checksum: hash.digest("hex") } });
          })
          .catch((error) => {
            cleanup();
            reject(asDownloadError(error, options.signal));
          });
      },
    );
    const onAbort = () => {
      request.destroy(new InstallerError("CANCELLED", "Installation cancelled."));
    };
    const cleanup = () => {
      request.setTimeout(0);
      options.signal?.removeEventListener("abort", onAbort);
    };
    request.setTimeout(IDLE_TIMEOUT_MS, () => {
      request.destroy(new InstallerError("DOWNLOAD_FAILED", `Download timed out after ${IDLE_TIMEOUT_MS}ms of inactivity: ${url}`));
    });
    request.on("error", (error) => {
      cleanup();
      reject(asDownloadError(error, options.signal));
    });
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    request.end();
  });
}

function asDownloadError(error: unknown, signal?: AbortSignal): InstallerError {
  if (error instanceof InstallerError) return error;
  if (signal?.aborted) return new InstallerError("CANCELLED", "Installation cancelled.");
  const message = error instanceof Error ? error.message : String(error);
  return new InstallerError("DOWNLOAD_FAILED", `Download failed: ${message}`);
}