#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { ensureDirectory, isInside, writeJsonAtomic } = require("../utils/files.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURE_ROOT = path.join(ROOT, ".benchmark-data", "ide", "fixtures");
const PROFILE_NAMES = new Set(["quick", "standard", "full"]);

function parseOptions(argv) {
  const options = { profile: "quick", extreme: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") options.profile = argv[++index] || "";
    else if (arg.startsWith("--profile=")) options.profile = arg.slice("--profile=".length);
    else if (arg === "--extreme") options.extreme = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!PROFILE_NAMES.has(options.profile)) throw new Error("--profile must be quick, standard or full");
  return options;
}

function removeGeneratedDirectory(directory) {
  const resolved = path.resolve(directory);
  if (!isInside(FIXTURE_ROOT, resolved) || resolved === path.resolve(ROOT) || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to remove an unsafe fixture path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function writeLines(filePath, lineCount, kind = "plain") {
  ensureDirectory(path.dirname(filePath));
  const file = fs.openSync(filePath, "w");
  const batchSize = 1000;
  try {
    for (let start = 0; start < lineCount; start += batchSize) {
      const count = Math.min(batchSize, lineCount - start);
      let batch = "";
      for (let offset = 0; offset < count; offset += 1) {
        const index = start + offset;
        const line = kind === "javascript"
          ? `const record${String(index).padStart(6, "0")} = { id: ${index}, label: "benchmark deterministic payload", active: ${index % 2 === 0} };`
          : `benchmark fixture row ${String(index).padStart(7, "0")} deterministic payload for editor rendering and search`;
        batch += `${line}\n`;
      }
      fs.writeSync(file, batch, null, "utf8");
    }
  } finally {
    fs.closeSync(file);
  }
}

function maximumLineLength(kind) {
  return kind === "javascript"
    ? `const record000000 = { id: 0, label: "benchmark deterministic payload", active: false };`.length
    : `benchmark fixture row 0000000 deterministic payload for editor rendering and search`.length;
}

function writeBytes(filePath, byteCount, lineWidth = 79) {
  ensureDirectory(path.dirname(filePath));
  const file = fs.openSync(filePath, "w");
  const fullLine = `${"x".repeat(lineWidth)}\n`;
  const chunk = Buffer.from(fullLine.repeat(Math.max(1, Math.floor(65536 / fullLine.length))), "ascii");
  let remaining = byteCount;
  try {
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      fs.writeSync(file, chunk.subarray(0, length));
      remaining -= length;
    }
  } finally {
    fs.closeSync(file);
  }
}

function writeBinary(filePath, byteCount = 4096) {
  ensureDirectory(path.dirname(filePath));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80]);
  const contents = Buffer.alloc(byteCount);
  for (let index = 0; index < byteCount; index += 1) contents[index] = signature[index % signature.length];
  fs.writeFileSync(filePath, contents);
}

function writeLongLine(filePath, length, { tabs = false, unicode = false } = {}) {
  ensureDirectory(path.dirname(filePath));
  let content;
  if (unicode) {
    const unit = "a🙂e\u0301👩‍💻\t界";
    content = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  } else if (tabs) {
    content = "x".repeat(length).replace(/x{4096}/g, (chunk) => `${chunk.slice(0, -1)}\t`);
  } else {
    content = "x".repeat(length);
  }
  fs.writeFileSync(filePath, content, unicode ? "utf8" : "ascii");
}

function makeWorkspace(name, fileCount, folderCount) {
  const workspacePath = path.join(FIXTURE_ROOT, "workspaces", name);
  removeGeneratedDirectory(workspacePath);
  ensureDirectory(workspacePath);
  const folders = [];
  const groupCount = folderCount > 10 ? Math.ceil(folderCount / 10) : 0;
  const leafCount = folderCount - groupCount;
  for (let index = 0; index < leafCount; index += 1) {
    const relative = groupCount
      ? `group-${String(Math.floor(index / Math.ceil(leafCount / groupCount)) + 1).padStart(3, "0")}/folder-${String(index + 1).padStart(4, "0")}`
      : `folder-${String(index + 1).padStart(4, "0")}`;
    folders.push(relative);
    ensureDirectory(path.join(workspacePath, relative));
  }
  for (let index = 0; index < fileCount; index += 1) {
    const folder = folders[index % folders.length];
    const filePath = path.join(workspacePath, folder, `file-${String(index + 1).padStart(6, "0")}.txt`);
    fs.writeFileSync(filePath, `workspace ${name} file ${index + 1}\nbenchmark data\n`, "utf8");
  }
  return { name, path: workspacePath, files: fileCount, folders: folderCount, entries: fileCount + folderCount };
}

function addFile(files, name, relativePath, bytes, lines, maxLineLength) {
  files[name] = { path: relativePath, bytes, lines, maxLineLength };
}

function generate(options) {
  ensureDirectory(FIXTURE_ROOT);
  const filesRoot = path.join(FIXTURE_ROOT, "files");
  const workspacesRoot = path.join(FIXTURE_ROOT, "workspaces");
  removeGeneratedDirectory(filesRoot);
  removeGeneratedDirectory(workspacesRoot);
  ensureDirectory(filesRoot);
  const files = {};

  const lineFiles = [
    ["tiny", 10], ["small", 1000], ["medium", 10000],
  ];
  if (options.profile !== "quick") lineFiles.push(["large", 100000]);
  if (options.profile === "full") lineFiles.push(["very-large", 500000], ["extreme", 1000000]);
  for (const [name, count] of lineFiles) {
    const relative = `files/${name}.txt`;
    const filePath = path.join(FIXTURE_ROOT, relative);
    writeLines(filePath, count);
    addFile(files, name, relative, fs.statSync(filePath).size, count, maximumLineLength("plain"));
  }

  const longLineLengths = options.profile === "quick"
    ? [10000, 100000]
    : options.profile === "standard" ? [10000, 100000] : [10000, 100000, 1000000];
  for (const length of longLineLengths) {
    const name = `long-line-${length >= 1000000 ? "1m" : `${length / 1000}k`}`;
    const relative = `files/${name}.txt`;
    const filePath = path.join(FIXTURE_ROOT, relative);
    writeLongLine(filePath, length);
    addFile(files, name, relative, fs.statSync(filePath).size, 1, length);
  }
  const tabLength = options.profile === "full" ? 1000000 : 100000;
  const tabName = `long-line-tabs-${tabLength >= 1000000 ? "1m" : "100k"}`;
  let tabFile = path.join(FIXTURE_ROOT, `files/${tabName}.txt`);
  writeLongLine(tabFile, tabLength, { tabs: true });
  addFile(files, tabName, `files/${tabName}.txt`, fs.statSync(tabFile).size, 1, tabLength);

  const unicodeLength = options.profile === "full" ? 100000 : 10000;
  const unicodePath = path.join(FIXTURE_ROOT, "files/long-unicode.txt");
  writeLongLine(unicodePath, unicodeLength, { unicode: true });
  addFile(files, "long-unicode", "files/long-unicode.txt", fs.statSync(unicodePath).size, 1, unicodeLength);

  const jsPath = path.join(FIXTURE_ROOT, "files/sample.js");
  writeLines(jsPath, 1000, "javascript");
  addFile(files, "sample-js", "files/sample.js", fs.statSync(jsPath).size, 1000, maximumLineLength("javascript"));
  const searchPath = path.join(FIXTURE_ROOT, "files/search-many.txt");
  writeLines(searchPath, 10000);
  addFile(files, "search-many", "files/search-many.txt", fs.statSync(searchPath).size, 10000, 106);
  const binaryPath = path.join(FIXTURE_ROOT, "files/sample.bin");
  writeBinary(binaryPath);
  addFile(files, "binary", "files/sample.bin", fs.statSync(binaryPath).size, 0, 0);

  const byteSizes = options.profile === "quick"
    ? [10 * 1024, 100 * 1024]
    : options.profile === "standard" ? [10 * 1024, 100 * 1024, 1024 * 1024, 5 * 1024 * 1024]
      : [10 * 1024, 100 * 1024, 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024];
  for (const bytes of byteSizes) {
    const label = bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)}mb` : `${bytes / 1024}kb`;
    const relative = `files/size-${label}.txt`;
    const filePath = path.join(FIXTURE_ROOT, relative);
    writeBytes(filePath, bytes);
    addFile(files, `size-${label}`, relative, bytes, Math.ceil(bytes / 80), Math.min(79, bytes));
  }

  const workspaces = [];
  workspaces.push(makeWorkspace("small", 50, 5));
  if (options.profile !== "quick") workspaces.push(makeWorkspace("medium", 2000, 50));
  if (options.profile === "full") workspaces.push(makeWorkspace("large", 20000, 200));
  if (options.extreme) workspaces.push(makeWorkspace("extreme", 100000, 1000));

  const manifest = {
    schemaVersion: 1,
    fixtureVersion: "1.0.0",
    profile: options.profile,
    extreme: options.extreme,
    deterministic: true,
    generatedAt: new Date().toISOString(),
    files,
    workspaces,
  };
  writeJsonAtomic(path.join(FIXTURE_ROOT, "manifest.json"), manifest);
  return manifest;
}

if (require.main === module) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node benchmark/ide/fixtures/generate-fixtures.cjs [--profile quick|standard|full] [--extreme]");
      process.exit(0);
    }
    const manifest = generate(options);
    console.log(`Generated ${Object.keys(manifest.files).length} deterministic files and ${manifest.workspaces.reduce((sum, workspace) => sum + workspace.files, 0)} workspace files at ${FIXTURE_ROOT}`);
    if (options.extreme) console.log("Extreme 100,000-file workspace generated by explicit request.");
  } catch (error) {
    console.error(`Fixture generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { generate, parseOptions, writeBytes, writeLines, writeLongLine, writeBinary, maximumLineLength };
