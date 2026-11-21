import type { PackageDefinition, PlatformConfig } from "../types";

// Node.js 24.22.3 LTS (Krypton), published 2026-11-10. URLs, sizes and SHA-256
// checksums come from https://nodejs.org/dist/v24.22.3/SHASUMS256.txt and the
// HTTP Content-Length headers of the official archives. Only platforms whose
// official distribution uses an archive format supported by the Installer
// (.tar.gz / .zip) are declared; Linux ships .tar.xz and is intentionally
// omitted until an xz decoder is available.
const VERSION = "24.22.3";
const BASE_URL = `https://nodejs.org/dist/v${VERSION}`;

function distribution(
  asset: string,
  checksum: string,
  size: number,
  format: "tar.gz" | "zip",
  executable: string,
): PlatformConfig {
  return {
    download: {
      url: `${BASE_URL}/${asset}`,
      checksum,
      checksumAlgorithm: "sha256",
      size,
    },
    archive: { format, stripComponents: 1 },
    executable,
    verification: { executable: "{installDir}/" + executable, args: ["--version"] },
  };
}

export const node: PackageDefinition = {
  id: "node",
  name: "Node.js",
  version: VERSION,
  platforms: {
    darwin: {
      arm64: distribution("node-v24.22.3-darwin-arm64.tar.gz", "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd", 53084299, "tar.gz", "bin/node"),
      x64: distribution("node-v24.22.3-darwin-x64.tar.gz", "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7", 54395976, "tar.gz", "bin/node"),
    },
    win32: {
      x64: distribution("node-v24.22.3-win-x64.zip", "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f", 37762649, "zip", "node.exe"),
    },
  },
  install: {
    destination: "tools/{id}/{version}",
    steps: [{ type: "download" }, { type: "extract" }],
  },
  verification: { executable: "{installDir}/bin/node", args: ["--version"] },
};
