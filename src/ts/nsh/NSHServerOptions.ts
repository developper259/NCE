import type { NSHServerOptions } from "nsh/server";

export const NSH_SERVER_HOST = "127.0.0.1";

/** Only the packaged file:// renderer and NCE's local Vite renderer may connect. */
export const NSH_RENDERER_ORIGINS = [
  "file://",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
] as const;

export function createNSHServerOptions(): NSHServerOptions {
  return {
    host: NSH_SERVER_HOST,
    port: 0,
    // The allowlist deliberately stays local: packaged renderer, dev renderer,
    // plus the null origin some Electron versions send from file://.
    allowedOrigins: [...NSH_RENDERER_ORIGINS],
    allowNullOrigin: true,
  };
}
