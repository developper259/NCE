import type { PackageDefinition, PlatformConfig } from "../types";

// Pyright 1.1.414 from the official npm registry: a self-contained Python
// language server (bundles pyright-internal.js/vendor.js and typeshed, no
// runtime downloads). Launched through the Node.js runtime. SHA-512 integrity
// is taken from registry metadata (base64) and stored in hexadecimal.
const VERSION = "1.1.414";
const TARBALL = "pyright-1.1.414.tgz";
const CHECKSUM = "14f6596f9d637a90d7e1e3fb4c460378d16d984dd683092411c269bc7dff426512b23d04032dcb5eefb10784ff1560de8edb179427c5affadb5858f0bb0b97c3";

function distribution(): PlatformConfig {
  return {
    download: {
      url: `https://registry.npmjs.org/pyright/-/${TARBALL}`,
      checksum: CHECKSUM,
      checksumAlgorithm: "sha512",
    },
    archive: { format: "tar.gz", stripComponents: 1 },
    executable: "langserver.index.js",
    verification: { executable: "langserver.index.js", mode: "presence" },
  };
}

const platforms = {
  darwin: { x64: distribution(), arm64: distribution() },
  win32: { x64: distribution(), arm64: distribution() },
  linux: { x64: distribution(), arm64: distribution() },
};

export const pyright: PackageDefinition = {
  id: "pyright",
  name: "Pyright Language Server",
  version: VERSION,
  platforms,
  install: {
    destination: "tools/{id}/{version}",
    steps: [{ type: "download" }, { type: "extract" }],
  },
  verification: { executable: "langserver.index.js", mode: "presence" },
};
