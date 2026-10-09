export type TerminalError = { code: string; message: string };

export type TerminalSize = {
  cols: number;
  rows: number;
};

export type TerminalCreateResult =
  | { success: true; sessionId: string; shell: string; cwd: string }
  | { success: false; error: TerminalError };

export type TerminalActionResult =
  | { success: true }
  | { success: false; error: TerminalError };

export type TerminalOutputMessage = {
  sessionId: string;
  sequence: number;
  data: string;
};

export const terminalLimits = Object.freeze({
  maxSessions: 8,
  maxDimension: 500,
  maxWriteBytes: 64 * 1024,
  outputChunkBytes: 32 * 1024,
  outputPauseBytes: 1024 * 1024,
  outputResumeBytes: 512 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
});

export function normalizeTerminalLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))
    return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
