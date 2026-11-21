const RENDERER_DEV_PATH = "/html/index.html";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function parseRendererDevUrl(): URL | null {
  const configured = process.env.NCE_RENDERER_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:") return null;
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
    if (!url.port) return null;
    if (url.pathname !== RENDERER_DEV_PATH) return null;
    if (url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

/** Validated local Vite renderer URL used when running unpackaged in development. */
export function getRendererDevUrl(): string | null {
  const url = parseRendererDevUrl();
  return url ? `${url.origin}${url.pathname}` : null;
}

/** Origin the development renderer connects from, for NSH's allowlist. */
export function getRendererDevOrigin(): string | null {
  return parseRendererDevUrl()?.origin ?? null;
}
