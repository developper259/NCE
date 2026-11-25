"use strict";

/**
 * Download, verify and stage the Node.js runtime embedded in NCE.
 *
 * Runs at BUILD time only. Nothing here runs when the user opens the app.
 * The staged layout is resources/internal-node/<version>/{node,LICENSE}.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const tarStream = require("tar-stream");
const yauzl = require("yauzl");

const config = require("./internal-node-config.cjs");

const root = path.resolve(__dirname, "..");
const targetRoot = path.join(root, "resources", config.RESOURCE_DIR, config.VERSION);

function argument(name) {
  const flag = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(flag));
  return found ? found.slice(flag.length) : null;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function download(url, destination, expectedSize, expectedChecksum) {
  if (fs.existsSync(destination)) {
    const stats = fs.statSync(destination);
    if (stats.size === expectedSize && (await sha256(destination)) === expectedChecksum) {
      console.log(`[internal-node] cached archive: ${path.basename(destination)}`);
      return;
    }
    fs.rmSync(destination, { force: true });
  }

  console.log(`[internal-node] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (expectedSize && buffer.length !== expectedSize) {
    throw new Error(
      `Archive size mismatch for ${url}: expected ${expectedSize}, got ${buffer.length}.`,
    );
  }
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  if (checksum !== expectedChecksum) {
    throw new Error(
      `SHA-256 mismatch for ${url}: expected ${expectedChecksum}, got ${checksum}.`,
    );
  }
  fs.writeFileSync(destination, buffer);
  console.log(`[internal-node] verified SHA-256 ${checksum}`);
}

function extractTarGz(archive, wanted, output) {
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    let found = false;
    extract.on("entry", (header, stream, next) => {
      // Official Node archives wrap every entry in a top-level directory named
      // after the distribution. Match on the suffix so the layout stays a
      // single source of truth in internal-node-config.cjs.
      const name = header.name.replace(/^\.\//, "");
      const matches = name === wanted || name.endsWith(`/${wanted}`);
      const isFile = header.type === "file" || header.type === 0 || header.type === "0";
      if (!matches || !isFile) {
        stream.resume();
        next();
        return;
      }
      found = true;
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        fs.writeFileSync(output, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", () => {
      if (!found) reject(new Error(`Entry ${wanted} not found in ${archive}`));
      else resolve();
    });
    extract.on("error", reject);
    pipeline(Readable.from(fs.createReadStream(archive)), zlib.createGunzip(), extract)
      .catch(reject);
  });
}

function extractZipEntry(archive, wanted, output) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zipFile) => {
      if (error) return reject(error);
      let found = false;
      zipFile.readEntry();
      zipFile.on("entry", (entry) => {
        if (entry.fileName !== wanted) {
          zipFile.readEntry();
          return;
        }
        found = true;
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            fs.writeFileSync(output, Buffer.concat(chunks));
            zipFile.close();
            resolve();
          });
          stream.on("error", reject);
        });
      });
      zipFile.on("end", () => {
        if (!found) reject(new Error(`Entry ${wanted} not found in ${archive}`));
      });
      zipFile.on("error", reject);
    });
  });
}

async function main() {
  const platform = argument("platform") || process.platform;
  const arch = argument("arch") || process.arch;
  const distribution = config.getDistribution(platform, arch);

  const cacheRoot = path.join(os.tmpdir(), "nce-internal-node-cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const archive = path.join(cacheRoot, distribution.asset);

  await download(
    distribution.url,
    archive,
    distribution.size,
    distribution.checksum,
  );

  fs.mkdirSync(targetRoot, { recursive: true });
  const executableName = path.basename(distribution.executable);
  const output = path.join(targetRoot, executableName);

  if (distribution.format === "tar.gz") {
    await extractTarGz(archive, distribution.executable, output);
  } else {
    await extractZipEntry(archive, distribution.executable, output);
  }

  if (platform !== "win32") fs.chmodSync(output, 0o755);

  const license = await fetch(config.LICENSE_URL);
  if (!license.ok) throw new Error(`License download failed: HTTP ${license.status}`);
  fs.writeFileSync(path.join(targetRoot, "LICENSE"), Buffer.from(await license.arrayBuffer()));

  console.log(`[internal-node] staged ${output} (${fs.statSync(output).size} bytes)`);
}

main().catch((error) => {
  console.error(`[internal-node] ${error.message}`);
  process.exitCode = 1;
});
