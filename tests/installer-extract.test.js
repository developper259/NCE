"use strict";

const assert = require("node:assert");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { extractArchive } = require("../dist/ts/installer/extract.js");
const { makeTarGz, makeZip, tempDir } = require("./helpers/installer.js");

const BIG = 64 * 1024 * 1024;

async function listing(dir) {
  return fs.readdir(dir).catch(() => []);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fixture(format, data) {
  const dir = await tempDir("nce-extract-fixtures-");
  const file = path.join(dir, `fixture.${format === "zip" ? "zip" : "tar.gz"}`);
  const entries = [{ name: "big.bin", data, mode: 0o644 }];
  if (format === "zip") await makeZip(entries, file);
  else await makeTarGz(entries, file);
  return { dir, file };
}

for (const format of ["tar.gz", "zip"]) {
  test(`extractArchive rejects a pre-aborted signal without writing (${format})`, async () => {
    const root = await tempDir();
    const small = await fixture(format, Buffer.from("payload"));
    const dest = path.join(root, "out");
    try {
      await assert.rejects(
        extractArchive(small.file, dest, { format, stripComponents: 0 }, AbortSignal.abort()),
        (error) => error.code === "CANCELLED",
      );
      assert.deepEqual(await listing(dest), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(small.dir, { recursive: true, force: true });
    }
  });

  test(`extractArchive interrupts a running extraction promptly (${format})`, async () => {
    const root = await tempDir();
    const big = await fixture(format, Buffer.alloc(BIG, 7));
    const dest = path.join(root, "out");
    const controller = new AbortController();
    try {
      const pending = extractArchive(big.file, dest, { format, stripComponents: 0 }, controller.signal);
      const target = path.join(dest, "big.bin");
      const deadline = Date.now() + 10000;
      let started = false;
      while (Date.now() < deadline) {
        if (await fs.stat(target).then(() => true, () => false)) { started = true; break; }
        await sleep(2);
      }
      assert.ok(started, "extraction must begin before cancellation");
      const abortedAt = Date.now();
      controller.abort();
      await assert.rejects(pending, (error) => error.code === "CANCELLED");
      assert.ok(Date.now() - abortedAt < 5000, "cancellation must settle promptly");
    } finally {
      controller.abort();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(big.dir, { recursive: true, force: true });
    }
  });
}