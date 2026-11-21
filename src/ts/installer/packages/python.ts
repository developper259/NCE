import type { PackageDefinition, PlatformConfig } from "../types";

// CPython 3.12.16 from python-build-standalone (release 20261110), a widely used
// source of self-contained, relocatable CPython builds. The official python.org
// installers are .pkg/.exe (not extractable by the Installer), whereas these
// install_only archives are plain .tar.gz with a verified SHA-256SUMS file.
// URLs, sizes and checksums come from that release's published assets.
const VERSION = "3.12.16";
const RELEASE = "20261110";
const BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}`;

function distribution(
  target: string,
  checksum: string,
  size: number,
  executable: string,
): PlatformConfig {
  return {
    download: {
      url: `${BASE_URL}/cpython-${VERSION}%2B${RELEASE}-${target}-install_only.tar.gz`,
      checksum,
      checksumAlgorithm: "sha256",
      size,
    },
    archive: { format: "tar.gz", stripComponents: 1 },
    executable,
    verification: { executable: "{installDir}/" + executable, args: ["--version"] },
  };
}

export const python: PackageDefinition = {
  id: "python",
  name: "Python",
  version: VERSION,
  platforms: {
    darwin: {
      arm64: distribution("aarch64-apple-darwin", "e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f", 25371130, "bin/python"),
      x64: distribution("x86_64-apple-darwin", "83f2922437e6d546d0fcdb8c11f150a8e52787e8d9ea8651b1974e20908eb1bc", 25078514, "bin/python"),
    },
    linux: {
      x64: distribution("x86_64-unknown-linux-gnu", "c2f87d4b4e8db3abddb0f116c6ccfc503d0cbdbb9ee8faacddad1b679ec12e99", 68163679, "bin/python"),
    },
    win32: {
      x64: distribution("x86_64-pc-windows-msvc", "e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b", 47438699, "python.exe"),
    },
  },
  install: {
    destination: "tools/{id}/{version}",
    steps: [{ type: "download" }, { type: "extract" }],
  },
  verification: { executable: "{installDir}/bin/python", args: ["--version"] },
};
