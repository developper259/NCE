#!/usr/bin/env node
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function removeIfPresent(target) {
  try { await fs.rm(target, { recursive: true, force: true }); return true; }
  catch (error) { if (error.code !== "ENOENT") throw error; return false; }
}

async function main() {
  const root = path.resolve(__dirname, "../..");
  const removed = [];
  for (const relative of ["dataset/output", "dataset/export"]) if (await removeIfPresent(path.join(root, relative))) removed.push(relative);
  const tempRoot = os.tmpdir();
  for (const entry of await fs.readdir(tempRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith("nce-dataset-")) continue;
    const target = path.join(tempRoot, entry.name);
    if (await removeIfPresent(target)) removed.push(target);
  }
  console.log(`Dataset clean: ${removed.length} path(s) removed.`);
  for (const item of removed) console.log(`- ${item}`);
}
main().catch((error) => { console.error(`Dataset clean failed: ${error.message}`); process.exitCode = 1; });
