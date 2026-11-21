import type { PackageDefinition, PlatformConfig } from "../types";

// typescript-language-server 6.1.0 from the official npm registry. The tarball
// is a self-contained bundle (lib/cli.mjs) launched by a Node.js runtime; it
// resolves TypeScript's tsserver.js from a sibling node_modules/typescript/lib.
// SHA-512 integrity is taken from registry metadata (base64) and stored in
// hexadecimal, the form the Installer uses. Architecture-independent.
const VERSION = "6.1.0";
const TARBALL = "typescript-language-server-6.1.0.tgz";
const CHECKSUM = "fcefddaf609bbc34b55bd8ca25c050c64e166a0510f7ba016fc93f7aaf5c3ac96c6ed02e0b60433e991c50bc44d9211988f209bd534b78d8cb65ef61425d7309";

function distribution(): PlatformConfig {
  return {
    download: {
      url: `https://registry.npmjs.org/typescript-language-server/-/${TARBALL}`,
      checksum: CHECKSUM,
      checksumAlgorithm: "sha512",
    },
    archive: { format: "tar.gz", stripComponents: 1 },
    executable: "lib/cli.mjs",
    verification: { executable: "lib/cli.mjs", mode: "presence" },
  };
}

const platforms = {
  darwin: { x64: distribution(), arm64: distribution() },
  win32: { x64: distribution(), arm64: distribution() },
  linux: { x64: distribution(), arm64: distribution() },
};

export const typescriptLanguageServer: PackageDefinition = {
  id: "typescript-language-server",
  name: "TypeScript Language Server",
  version: VERSION,
  platforms,
  install: {
    destination: "tools/{id}/{version}",
    steps: [{ type: "download" }, { type: "extract" }],
  },
  verification: { executable: "lib/cli.mjs", mode: "presence" },
};
