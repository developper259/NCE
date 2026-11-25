"use strict";

/**
 * Single source of truth for the Node.js runtime embedded in NCE.
 *
 * This runtime is used only by NCE internals (language servers and internal
 * tools). It is downloaded and verified at BUILD time, never at first launch,
 * and it is independent of any Node.js a user's project may select.
 *
 * Checksums come from https://nodejs.org/dist/v24.22.3/SHASUMS256.txt.
 * Sizes are the HTTP Content-Length of the official archives.
 */
const VERSION = "24.22.3";
const BASE_URL = `https://nodejs.org/dist/v${VERSION}`;

const DISTRIBUTIONS = {
  "darwin-arm64": {
    asset: `node-v${VERSION}-darwin-arm64.tar.gz`,
    checksum: "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
    size: 53084299,
    format: "tar.gz",
    executable: "bin/node",
  },
  "darwin-x64": {
    asset: `node-v${VERSION}-darwin-x64.tar.gz`,
    checksum: "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
    size: 54395976,
    format: "tar.gz",
    executable: "bin/node",
  },
  "linux-x64": {
    asset: `node-v${VERSION}-linux-x64.tar.gz`,
    checksum: "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
    size: 58330843,
    format: "tar.gz",
    executable: "bin/node",
  },
  "linux-arm64": {
    asset: `node-v${VERSION}-linux-arm64.tar.gz`,
    checksum: "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
    size: 58051304,
    format: "tar.gz",
    executable: "bin/node",
  },
  "win32-x64": {
    asset: `node-v${VERSION}-win-x64.zip`,
    checksum: "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f",
    size: 37762649,
    format: "zip",
    executable: "node.exe",
  },
};

/** Destination inside the packaged app, relative to process.resourcesPath. */
const RESOURCE_DIR = "internal-node";
const LICENSE_URL = `https://raw.githubusercontent.com/nodejs/node/v${VERSION}/LICENSE`;

function distributionKey(platform, arch) {
  return `${platform}-${arch}`;
}

function getDistribution(platform, arch) {
  const entry = DISTRIBUTIONS[distributionKey(platform, arch)];
  if (!entry) {
    throw new Error(
      `No embedded Node.js distribution for ${platform}-${arch}. ` +
      `Supported: ${Object.keys(DISTRIBUTIONS).join(", ")}.`,
    );
  }
  return { ...entry, url: `${BASE_URL}/${entry.asset}` };
}

module.exports = {
  VERSION,
  BASE_URL,
  RESOURCE_DIR,
  LICENSE_URL,
  DISTRIBUTIONS,
  distributionKey,
  getDistribution,
};
