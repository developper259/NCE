"use strict";

const { createHash } = require("node:crypto");
const { createWriteStream, promises: fs } = require("node:fs");
const { createServer } = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { createGzip } = require("node:zlib");
const tar = require("tar-stream");
const yazl = require("yazl");

async function tempDir(prefix = "nce-installer-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function makeTarGz(entries, file) {
  const pack = tar.pack();
  for (const entry of entries) {
    const type = entry.type ?? (entry.name.endsWith("/") ? "directory" : "file");
    const header = {
      name: entry.name,
      type,
      mode: entry.mode ?? (type === "directory" ? 0o755 : 0o644),
    };
    if (type === "symlink" || type === "link") header.linkname = entry.linkname ?? "";
    const data = type === "file" ? Buffer.from(entry.data ?? "") : Buffer.alloc(0);
    if (type === "file") header.size = data.length;
    await new Promise((resolve, reject) => {
      const sink = pack.entry(header, (error) => (error ? reject(error) : resolve()));
      sink.end(data);
    });
  }
  pack.finalize();
  await pipeline(pack, createGzip(), createWriteStream(file));
}

async function makeZip(entries, file) {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    const type = entry.type ?? (entry.name.endsWith("/") ? "directory" : "file");
    if (type === "directory") {
      zip.addEmptyDirectory(entry.name.replace(/\/+$/, ""), { mode: 0o40755 });
    } else if (type === "symlink") {
      zip.addBuffer(Buffer.from(entry.linkname ?? ""), entry.name, { mode: 0o120777, compress: false });
    } else {
      zip.addBuffer(Buffer.from(entry.data ?? ""), entry.name, {
        mode: entry.mode ?? 0o100644,
        compress: true,
      });
    }
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
}

function crc32(buffer) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Hand-rolled store-only ZIP so security fixtures can carry hostile entry names. */
async function makeRawZip(entries, file) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  await fs.writeFile(file, Buffer.concat([...locals, centralBuffer, end]));
}

async function rawZipFixture(entries) {
  const dir = await tempDir("nce-installer-fixtures-");
  const file = path.join(dir, "fixture.zip");
  await makeRawZip(entries, file);
  const body = await fs.readFile(file);
  return { dir, body, checksum: sha256(body) };
}

function staticRoute(body, headers = {}) {
  return (req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length, ...headers });
    res.end(body);
  };
}

function serve(routes) {
  const server = createServer((req, res) => {
    const route = routes[new URL(req.url, "http://127.0.0.1").pathname];
    if (!route) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { tempDir, sha256, makeTarGz, makeZip, makeRawZip, rawZipFixture, staticRoute, serve };