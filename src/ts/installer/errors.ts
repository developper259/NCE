import type { InstallerErrorCode } from "./types";

export class InstallerError extends Error {
  constructor(
    public readonly code: InstallerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InstallerError";
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof InstallerError && error.code === "CANCELLED";
}