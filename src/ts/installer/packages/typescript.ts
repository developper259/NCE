import type { PackageDefinition, PlatformConfig } from "../types";

// TypeScript 6.0.3 from the official npm registry. typescript-language-server
// 6.1.0 is built against TypeScript 6 (its own devDependency is ^6.0.3) and its
// README installs `typescript@6` alongside it, so the managed SDK follows the
// same major. The tarball carries lib/tsserver.js and lib/typescript.js, which
// the server loads through initializationOptions.tsserver.fallbackPath. SHA-512
// integrity is taken from the registry metadata (base64) and stored here in
// hexadecimal, the form the Installer's checksum comparison uses. All platforms
// share the same architecture-independent archive.
const VERSION = "6.0.3";
const TARBALL = "typescript-6.0.3.tgz";
const CHECKSUM = "cb64efbb14993c3c906a490544f6472859be28a56a222b1d83dfc26709bd7edbca5cb3fc3515a3dfcfce0e335baf8dd2b285ea36e022b047f519d0b1a9671d07";

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
