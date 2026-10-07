const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_WORKSPACE_INDEX_ENTRIES,
  LARGE_WORKSPACE_MODE_THRESHOLDS,
  WORKSPACE_INDEX_CACHE_FILE,
  WORKSPACE_INDEX_VERSION,
  summarizeWorkspaceIndex,
  WorkspaceIndex,
} = require("../dist/ts/addon/WorkspaceIndex.js");
const { isOpenableFileSample } = require("../dist/ts/addon/OpenableFile.js");
const { NceWorkspaceStorage } = require("../dist/ts/addon/NceWorkspaceStorage.js");

test("WorkspaceIndex builds and reloads metadata-only entries atomically", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-valid-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-outside-"));
  try {
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", ".nce"), "ordinary filename\n");
    await fsp.mkdir(path.join(root, ".hidden"), { recursive: true });
    await fsp.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fsp.mkdir(path.join(root, ".nce", "cache"), { recursive: true });
    await fsp.writeFile(path.join(root, ".env"), "SECRET=value\n");
    await fsp.writeFile(path.join(root, ".nce-file"), "ordinary file\n");
    await fsp.writeFile(path.join(root, "src", "app.js"), "export const app = true;\n");
    await fsp.writeFile(path.join(root, "src", "binary.unknown"), Buffer.from([0, 1, 2, 3]));
    await fsp.writeFile(path.join(root, ".hidden", "notes.txt"), "hidden\n");
    await fsp.writeFile(path.join(root, "archive.asar"), "opaque\n");
    await fsp.writeFile(path.join(root, "node_modules", "pkg", "ignored.js"), "ignored\n");
    await fsp.writeFile(path.join(root, ".nce", "cache", "internal.json"), "{}\n");
    await fsp.writeFile(path.join(outside, "secret.txt"), "outside\n");
    try {
      await fsp.symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
    } catch {
      // Symlink creation can be disabled by the host; all other index checks still run.
    }

    const index = new WorkspaceIndex();
    assert.equal(await index.load(root), null);
    const snapshot = await index.build(root);
    assert.ok(snapshot);
    assert.equal(snapshot.version, WORKSPACE_INDEX_VERSION);
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.entries.map((entry) => entry.relativePath), [
      ".env",
      ".hidden/notes.txt",
      ".nce-file",
      "src/.nce",
      "src/app.js",
      "src/binary.unknown",
    ]);
    assert.equal(snapshot.entries.every((entry) => entry.type === "file"), true);
    assert.equal(snapshot.entries.every((entry) => typeof entry.openable === "boolean"), true);
    assert.equal(snapshot.entries.find((entry) => entry.name === ".env").openable, true);
    assert.equal(snapshot.entries.find((entry) => entry.name === "binary.unknown").openable, false);
    assert.equal(snapshot.entries.some((entry) => "content" in entry), false);
    assert.equal(snapshot.entries.find((entry) => entry.name === ".env").extension, "");

    const cachePath = new NceWorkspaceStorage(root).getCachePath(WORKSPACE_INDEX_CACHE_FILE);
    const persisted = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    assert.equal(persisted.version, WORKSPACE_INDEX_VERSION);
    assert.equal(persisted.root, path.resolve(root));
    assert.deepEqual(persisted.entries, snapshot.entries);
    assert.deepEqual(
      (await fsp.readdir(path.dirname(cachePath))).filter((name) => name.endsWith(".tmp")),
      [],
    );

    const reloaded = await new WorkspaceIndex().load(root);
    assert.deepEqual(reloaded.entries, snapshot.entries);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test("WorkspaceIndex treats corrupt and incompatible caches as misses", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-corrupt-"));
  const storage = new NceWorkspaceStorage(root);
  const cachePath = storage.getCachePath(WORKSPACE_INDEX_CACHE_FILE);
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, "{broken json");
    assert.equal(await new WorkspaceIndex().load(root), null);

    await fsp.writeFile(cachePath, JSON.stringify({
      version: 1,
      root: path.resolve(root),
      generatedAt: Date.now(),
      complete: true,
      entries: [],
    }));
    assert.equal(await new WorkspaceIndex().load(root), null);

    await fsp.writeFile(cachePath, JSON.stringify({
      version: WORKSPACE_INDEX_VERSION,
      root: path.resolve(root),
      generatedAt: Date.now(),
      complete: true,
      entries: [{
        relativePath: "../outside.txt",
        name: "outside.txt",
        extension: ".txt",
        size: 1,
        mtimeMs: 1,
        type: "file",
        openable: true,
      }],
    }));
    assert.equal(await new WorkspaceIndex().load(root), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceIndex persists empty and large workspaces within its entry bound", async () => {
  const emptyRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-empty-"));
  const largeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-large-"));
  try {
    const empty = await new WorkspaceIndex().build(emptyRoot);
    assert.deepEqual(empty.entries, []);
    assert.deepEqual((await new WorkspaceIndex().load(emptyRoot)).entries, []);

    const directory = path.join(largeRoot, "files");
    await fsp.mkdir(directory);
    await Promise.all(Array.from({ length: 1200 }, (_, index) =>
      fsp.writeFile(path.join(directory, `file-${index}.js`), `const value = ${index};\n`),
    ));
    const large = await new WorkspaceIndex().build(largeRoot);
    assert.equal(large.entries.length, 1200);
    assert.ok(large.entries.length < MAX_WORKSPACE_INDEX_ENTRIES);
    assert.equal(large.entries[0].relativePath, "files/file-0.js");
    assert.equal(large.entries.at(-1).relativePath, "files/file-999.js");
    assert.equal((await new WorkspaceIndex().load(largeRoot)).entries.length, 1200);
  } finally {
    await fsp.rm(emptyRoot, { recursive: true, force: true });
    await fsp.rm(largeRoot, { recursive: true, force: true });
  }
});

test("WorkspaceIndex derives large mode from index dimensions and preserves watcher correctness", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-mode-"));
  try {
    await fsp.writeFile(path.join(root, "readme.md"), "small workspace\n");
    const index = new WorkspaceIndex();
    const updates = [];
    index.onStatsUpdated = (stats) => updates.push(stats);
    await index.build(root);
    const small = index.getStats(root);
    assert.equal(small.ready, true);
    assert.equal(small.fileCount, 1);
    assert.equal(small.directoryCount, 0);
    assert.equal(small.largeWorkspaceMode, false);
    assert.equal(index.getWatcherDebounceMs(root), 150);
    assert.deepEqual(index.getPerformanceProfile(root), {
      mode: "normal",
      indexWatcherDebounceMs: 150,
      maxCachedSearchSessions: 8,
    });

    const thresholdEntries = Array.from({
      length: LARGE_WORKSPACE_MODE_THRESHOLDS.files * LARGE_WORKSPACE_MODE_THRESHOLDS.pressureScore,
    }, (_, entryIndex) => {
      const name = `threshold-${entryIndex}.js`;
      return {
        relativePath: name,
        name,
        extension: ".js",
        size: 0,
        mtimeMs: 1,
        type: "file",
        openable: true,
      };
    });
    const atThreshold = summarizeWorkspaceIndex({
      version: WORKSPACE_INDEX_VERSION,
      root: path.resolve(root),
      generatedAt: 2,
      complete: true,
      entries: thresholdEntries,
    });
    assert.equal(atThreshold.fileCount, 20_000);
    assert.equal(atThreshold.pressureScore, LARGE_WORKSPACE_MODE_THRESHOLDS.pressureScore);
    assert.equal(atThreshold.largeWorkspaceMode, true);

    const largeEntries = Array.from({ length: 9000 }, (_, entryIndex) => {
      const group = Math.floor(entryIndex / 6);
      const name = `file-${entryIndex}.js`;
      return {
        relativePath: `groups/group-${group}/${name}`,
        name,
        extension: ".js",
        size: 131072,
        mtimeMs: 1,
        type: "file",
        openable: true,
      };
    });
    const estimatedLarge = summarizeWorkspaceIndex({
      version: WORKSPACE_INDEX_VERSION,
      root: path.resolve(root),
      generatedAt: 2,
      complete: true,
      entries: largeEntries,
    });
    assert.equal(estimatedLarge.fileCount, 9000);
    assert.equal(estimatedLarge.directoryCount, 1501);
    assert.equal(estimatedLarge.largeWorkspaceMode, true);

    assert.equal(index.primeFromScan(root, largeEntries), true);
    await index.flush(root);
    assert.equal(index.getStats(root).largeWorkspaceMode, true);
    assert.equal(index.getWatcherDebounceMs(root), 500);
    assert.equal(index.getPerformanceProfile(root).mode, "large");
    assert.equal(index.getPerformanceProfile(root).maxCachedSearchSessions, 4);

    const beforeWatcher = index.getDiagnostics();
    const addedPath = path.join(root, "added.js");
    await fsp.writeFile(addedPath, "still indexed\n");
    index.handleWatcherEvent(root, "add", addedPath);
    await index.flush(root);
    assert.ok((await index.load(root)).entries.some((entry) => entry.relativePath === "added.js"));
    assert.equal(index.getStats(root).largeWorkspaceMode, true);
    const afterWatcher = index.getDiagnostics();
    assert.equal(afterWatcher.received - beforeWatcher.received, 1);
    assert.equal(afterWatcher.batches - beforeWatcher.batches, 1);
    assert.equal(afterWatcher.persistedWrites - beforeWatcher.persistedWrites, 1);

    await index.build(root);
    assert.equal(index.getStats(root).largeWorkspaceMode, false);
    assert.equal(index.getWatcherDebounceMs(root), 150);
    assert.equal(index.getPerformanceProfile(root).mode, "normal");
    assert.equal(index.getPerformanceProfile(root).maxCachedSearchSessions, 8);
    assert.equal(updates.some((stats) => stats.largeWorkspaceMode), true);
    assert.equal(updates.at(-1).largeWorkspaceMode, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceIndex coalesces adds, non-openable changes, deletes, directory deletes, and rename pairs", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-events-"));
  const write = async (relativePath, content) => {
    const filePath = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
    return filePath;
  };
  try {
    const changedPath = await write("src/change.js", "const original = true;\n");
    const removedPath = await write("src/remove.js", "remove me\n");
    await write("src/nested/child.js", "nested\n");
    const oldName = await write("old-name.js", "rename me\n");
    const newName = path.join(root, "new-name.js");
    const index = new WorkspaceIndex();
    await index.build(root);
    const before = index.getDiagnostics();

    const addedPath = await write("src/added.js", "new file\n");
    index.handleWatcherEvent(root, "add", addedPath);
    const binarySample = Buffer.from([0, 1, 2, 3, 4, 5]);
    await fsp.writeFile(changedPath, binarySample);
    assert.equal(isOpenableFileSample(changedPath, binarySample.length, binarySample), false);
    index.handleWatcherEvent(root, "change", changedPath);
    index.handleWatcherEvent(root, "change", changedPath);
    await fsp.unlink(removedPath);
    index.handleWatcherEvent(root, "unlink", removedPath);
    await fsp.rename(oldName, newName);
    index.handleWatcherEvent(root, "unlink", oldName);
    index.handleWatcherEvent(root, "add", newName);
    await fsp.rm(path.join(root, "src/nested"), { recursive: true });
    index.handleWatcherEvent(root, "unlinkDir", path.join(root, "src/nested"));

    await index.flush(root);
    const after = await index.load(root);
    assert.deepEqual(after.entries.map((entry) => entry.relativePath), [
      "new-name.js",
      "src/added.js",
      "src/change.js",
    ]);
    assert.equal(after.entries.find((entry) => entry.relativePath === "src/change.js").size, 6);
    assert.equal(after.entries.find((entry) => entry.relativePath === "src/change.js").openable, false);
    assert.equal(after.entries.find((entry) => entry.relativePath === "src/added.js").openable, true);
    const diagnostics = index.getDiagnostics();
    assert.equal(diagnostics.persistedWrites - before.persistedWrites, 1);
    assert.equal(diagnostics.batches - before.batches, 1);
    assert.equal(diagnostics.received - before.received, 7);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceIndex marks ambiguous watcher events stale and reconciles in the background", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-reconcile-"));
  try {
    await fsp.writeFile(path.join(root, "before.js"), "before\n");
    const index = new WorkspaceIndex();
    await index.build(root);
    await fsp.rename(path.join(root, "before.js"), path.join(root, "after.js"));
    index.handleWatcherEvent(root, "rename", path.join(root, "before.js"));
    assert.equal(await index.load(root), null);

    await index.flush(root);
    const snapshot = await index.load(root);
    assert.deepEqual(snapshot.entries.map((entry) => entry.relativePath), ["after.js"]);
    assert.equal(index.getDiagnostics().reconciliations, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
