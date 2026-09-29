#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { isInside } = require("../utils/files.cjs");

const root = path.resolve(__dirname, "../../..");
const generatedRoot = path.join(root, ".benchmark-data", "ide");
const targets = [path.join(generatedRoot, "fixtures"), path.join(generatedRoot, "profiles")];

for (const target of targets) {
  const resolved = path.resolve(target);
  if (!isInside(generatedRoot, resolved) || resolved === path.resolve(root) || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to remove unsafe path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
console.log(`Removed generated fixtures and isolated profiles below ${generatedRoot}. Benchmark results were kept.`);
