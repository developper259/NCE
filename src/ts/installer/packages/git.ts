import type { PackageDefinition, PlatformConfig } from "../types";

// dugite-native v2.56.1 (Git 2.56.1, Git for Windows 2.56.1.windows.1) ships the
// prebuilt Git used by GitHub Desktop. Checksums and sizes below come from the
// release's published .sha256 assets, not from local computation.
const VERSION = "2.56.1";
const BASE_URL = "https://github.com/desktop/dugite-native/releases/download/v2.56.1";
const ASSET_PREFIX = "dugite-native-v2.56.1-238326e";

function distribution(asset: string, checksum: string, size: number, executable: string, verificationExecutable: string): PlatformConfig {
  return {
    download: {
      url: `${BASE_URL}/${ASSET_PREFIX}-${asset}.tar.gz`,
      checksum,
      checksumAlgorithm: "sha256",
      size,
    },
    archive: { format: "tar.gz", stripComponents: 0 },
    executable,
    verification: { executable: verificationExecutable, args: ["--version"] },
  };
}

export const git: PackageDefinition = {
  id: "git",
  name: "Git",
  version: VERSION,
  platforms: {
    darwin: {
      x64: distribution("macOS-x64", "3fdb0c2f102fe0273d64b5d5fb77315c19f2b4648a154593723cb9ed98f2bc7d", 67474588, "bin/git", "{installDir}/bin/git"),
      arm64: distribution("macOS-arm64", "a882ec6882416b57d212a22bac845ae27944f96cf73453a864f6a12c17863a79", 63505330, "bin/git", "{installDir}/bin/git"),
    },
    linux: {
      x64: distribution("ubuntu-x64", "e5bc3e8e80b57a5bcd8da18d59b23f5b39533d19019ac1d50b0bd34f051d111d", 67476577, "bin/git", "{installDir}/bin/git"),
      arm64: distribution("ubuntu-arm64", "8626f036e1235f5b209d8331c368d85a9790988fb21a443e5f61662a178abcb6", 25267157, "bin/git", "{installDir}/bin/git"),
    },
    win32: {
      x64: distribution("windows-x64", "e9fa2c78952aa2c2154c26dbd4999f93269896e9fc902fa9fe840412d4ffdb04", 47024188, "cmd/git.exe", "{installDir}/cmd/git.exe"),
      arm64: distribution("windows-arm64", "c30eef9fc273f4f56f795b4be713726f8a2fd35832633f4e4b9f51a6f0cf8198", 44390827, "cmd/git.exe", "{installDir}/cmd/git.exe"),
    },
  },
  install: {
    destination: "tools/{id}/{version}",
    steps: [{ type: "download" }, { type: "extract" }],
  },
  verification: { executable: "{installDir}/bin/git", args: ["--version"] },
};