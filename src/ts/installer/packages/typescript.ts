import type { PackageDefinition, PlatformConfig } from "../types";

// TypeScript 5.9.3 from the official npm registry. The tarball carries
// lib/tsserver.js and lib/typescript.js, which typescript-language-server
// resolves from a sibling node_modules/typescript/lib directory. SHA-512
// integrity is taken from the registry metadata (base64) and stored here in
// hexadecimal, the form the Installer's checksum comparison uses. All platforms
// share the same architecture-independent archive.
const VERSION = "5.9.3";
const TARBALL = "typescript-5.9.3.tgz";
const CHECKSUM = "8e5d6f6733c38a72ebf5e52ddc9feded5e8580d130f508ef04f772b33f4a7d00c3e357d0ac2d98e2f290762694a454f86d795bd511e12e9a7cc2d9ba3394e04b";

function distribution(): PlatformConfig {
  return {
    download: {
      url: `https://registry.npmjs.org/typescript/-/${TARBALL}`,
      checksum: CHECKSUM,
      checksumAlgorithm: "sha512",
    },
    archive: { format: "tar.gz", stripComponents: 1 },
    executable: "lib/tsserver.js",
    verification: { executable: "lib/tsserver.js", mode: "presence" },
  };
}

const platforms = {
  darwin: { x64: distribution(), arm64: distribution() },
  win32: { x64: distribution(), arm64: distribution() },
  linux: { x64: distribution(), arm64: distribution() },
};

export const typescript: PackageDefinition = {
  id: "typescript",
  name: "TypeScript",
  version: VERSION,
  platforms,
  install: {
    destination: "tools/{id}/{version}",
    steps: [{ type: "download" }, { type: "extract" }],
  },
  verification: { executable: "lib/tsserver.js", mode: "presence" },
};
