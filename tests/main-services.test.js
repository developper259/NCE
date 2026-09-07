const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FileManager } = require("../dist/ts/addon/FileManager.js");
const { WorkspaceSearch } = require("../dist/ts/addon/WorkspaceSearch.js");

async function tempWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-"));
  await fsp.mkdir(path.join(root, "sub"));
  await fsp.mkdir(path.join(root, "node_modules"));
  await fsp.writeFile(path.join(root, "a.js"), "const target = 1;\n");
  await fsp.writeFile(path.join(root, "b.txt"), "TARGET twice\ntarget\n");
  await fsp.writeFile(path.join(root, "sub", "c.js"), "target();\n");
  await fsp.writeFile(path.join(root, "node_modules", "ignored.js"), "target\n");
  return root;
}

test("FileManager initializes, chunks, saves, and rejects binary/invalid UTF-8", async () => {
  const root = await tempWorkspace();
  try {
    const manager = new FileManager({ window: null, watcher: null });
    const textPath = path.join(root, "a.js");
    const initialized = await manager.initializeFile(textPath);
    assert.equal(initialized.success, true);
    assert.equal(initialized.totalLines, 1);
    assert.equal(initialized.incrementalEligible, true);
    assert.deepEqual(await manager.getFileChunk(textPath, 0, 1), { success: true, lines: ["const target = 1;"] });
    await manager.saveFile(textPath, "updated\n");
    assert.equal(await fsp.readFile(textPath, "utf8"), "updated\n");

    const binaryPath = path.join(root, "binary.bin");
    const invalidPath = path.join(root, "invalid.txt");
    await fsp.writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02]));
    await fsp.writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
    assert.equal((await manager.initializeFile(binaryPath)).errorCode, "BINARY_FILE");
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal((await manager.initializeFile(invalidPath)).success, false);
    } finally {
      console.error = originalError;
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceSearch searches recursively while ignoring node_modules", async () => {
  const root = await tempWorkspace();
  try {
    const search = new WorkspaceSearch({ window: null });
    const result = await search.search(root, "target", { caseSensitive: false, limit: 20 });
    assert.equal(result.totalMatches, 4);
    assert.equal(result.results.some((entry) => entry.relativePath.includes("node_modules")), false);
    assert.equal(result.results.some((entry) => entry.relativePath === "sub/c.js"), true);

    const onlyJs = await search.search(root, "target", { include: "*.js" });
    assert.equal(onlyJs.results.every((entry) => entry.name.endsWith(".js")), true);
    const project = await search.getProjectMap(root, root, { maxDepth: 3 });
    assert.equal(project.success, true);
    assert.equal(project.entries.some((entry) => entry.name === "node_modules"), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('FileManager mutation safety, cache invalidation and nested creation', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nce-operations-'));
  const manager = new FileManager({});
  try {
    assert.equal((await manager.createFile(root, 'nested/a.txt', 'original')).success, true);
    const a = path.join(root, 'nested', 'a.txt'); const b = path.join(root, 'nested', 'b.txt');
    await manager.initializeFile(a);
    assert.equal((await manager.copyEntry(a, b)).success, true);
    assert.equal((await manager.copyEntry(a, b)).success, false);
    assert.equal((await manager.moveEntry(a, b)).success, false);
    assert.equal(await fsp.readFile(a, 'utf8'), 'original');
    const duplicate = await manager.duplicateEntry(a); assert.equal(duplicate.success, true);
    const moved = path.join(root, 'moved.txt'); assert.equal((await manager.moveEntry(a, moved)).success, true);
    assert.equal((await manager.getFileChunk(a, 0, 1)).success, false);
    await manager.initializeFile(moved);
    const renamed = path.join(root, 'renamed.txt'); assert.equal((await manager.renameEntry(moved, renamed)).success, true);
    assert.equal((await manager.getFileChunk(moved, 0, 1)).success, false);
    await manager.initializeFile(renamed); assert.equal((await manager.deleteEntry(renamed)).success, true);
    assert.equal((await manager.getFileChunk(renamed, 0, 1)).success, false);
    for (const invalid of [null, 123, {}, '', '   ', 'bad\0path']) {
      assert.equal(await manager.saveFile(invalid, 'x'), undefined);
      assert.equal((await manager.deleteEntry(invalid)).success, false);
      assert.equal((await manager.createFile(invalid, 'file', 'x')).success, false);
      assert.equal((await manager.copyEntry(invalid, b)).success, false);
    }
    assert.equal((await manager.createFile(root, '../escape.txt', 'bad')).success, false);
    assert.equal((await manager.createFolder(root, '..\\escape')).success, false);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('FileManager rejects a sparse file above 20 MiB and handles empty files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nce-size-'));
  const manager = new FileManager({});
  try {
    const large = path.join(root, 'large'); const handle = await fsp.open(large, 'w');
    await handle.truncate(20 * 1024 * 1024 + 1); await handle.close();
    assert.equal((await manager.initializeFile(large)).errorCode, 'FILE_TOO_LARGE');
    const empty = path.join(root, 'empty'); await fsp.writeFile(empty, '');
    const initialized = await manager.initializeFile(empty); assert.equal(initialized.totalLines, 1); assert.equal(initialized.size, 0);
    assert.deepEqual((await manager.getFileChunk(empty, 0, 1)).lines, ['']);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
