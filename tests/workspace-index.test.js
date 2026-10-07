const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_WORKSPACE_INDEX_ENTRIES,
  MAX_WORKSPACE_INDEX_BYTES,
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
      version: WORKSPACE_INDEX_VERSION,
      root: `${path.resolve(root)}-different`,
      generatedAt: Date.now(),
      complete: true,
      entries: [],
    }));
    assert.equal(await new WorkspaceIndex().load(root), null);

    await fsp.writeFile(cachePath, JSON.stringify({
      version: WORKSPACE_INDEX_VERSION,
      root: path.resolve(root),
      generatedAt: Date.now(),
      complete: false,
      entries: [],
    }));
    assert.equal(await new WorkspaceIndex().load(root), null);

    const originalStat = fsp.stat;
    fsp.stat = async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(cachePath))
        return { size: MAX_WORKSPACE_INDEX_BYTES + 1 };
      return originalStat.call(fsp, target, ...args);
    };
    try {
      assert.equal(await new WorkspaceIndex().load(root), null);
    } finally {
      fsp.stat = originalStat;
    }

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
      indexProbeConcurrency: 8,
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
    assert.equal(index.getPerformanceProfile(root).indexProbeConcurrency, 4);

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
    assert.equal(index.getPerformanceProfile(root).indexProbeConcurrency, 8);
    assert.equal(updates.some((stats) => stats.largeWorkspaceMode), true);
    assert.equal(updates.at(-1).largeWorkspaceMode, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceIndex bounds file probes and keeps deterministic order in each profile", async () => {
  const roots = [];
  const createRoot = async (prefix) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      fsp.writeFile(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "text\n"),
    ));
    return root;
  };
  const probeWithDelay = async (index, root, expectedPeak) => {
    const active = { count: 0, max: 0 };
    const originalOpen = fsp.open;
    fsp.open = async (...args) => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await originalOpen.apply(fsp, args);
      } finally {
        active.count -= 1;
      }
    };
    try {
      const snapshot = await index.build(root);
      assert.ok(snapshot);
      assert.equal(active.max, expectedPeak);
      assert.equal(index.getDiagnostics().probeConcurrencyMax, expectedPeak);
      assert.deepEqual(snapshot.entries.map((entry) => entry.relativePath),
        Array.from({ length: 24 }, (_, fileIndex) =>
          `file-${String(fileIndex).padStart(2, "0")}.txt`));
    } finally {
      fsp.open = originalOpen;
    }
  };

  const normalRoot = await createRoot("nce-workspace-probe-normal-");
  try {
    await probeWithDelay(new WorkspaceIndex(), normalRoot, 8);

    const largeRoot = await createRoot("nce-workspace-probe-large-");
    const largeIndex = new WorkspaceIndex();
    const thresholdEntries = Array.from({
      length: LARGE_WORKSPACE_MODE_THRESHOLDS.files * LARGE_WORKSPACE_MODE_THRESHOLDS.pressureScore,
    }, (_, entryIndex) => {
      const name = `cached-${entryIndex}.js`;
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
    assert.equal(largeIndex.primeFromScan(largeRoot, thresholdEntries), true);
    await largeIndex.flush(largeRoot);
    assert.equal(largeIndex.getPerformanceProfile(largeRoot).mode, "large");
    await probeWithDelay(largeIndex, largeRoot, 4);
  } finally {
    for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceIndex tolerates vanished files and stops a cancelled probe pool", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-probe-cancel-"));
  try {
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      fsp.writeFile(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "text\n"),
    ));

    const missingPath = path.join(root, "file-00.txt");
    const originalLstat = fsp.lstat;
    fsp.lstat = async (target, ...args) => {
      if (path.resolve(String(target)) === missingPath) {
        const error = new Error("file disappeared");
        error.code = "ENOENT";
        throw error;
      }
      return originalLstat.call(fsp, target, ...args);
    };
    try {
      const snapshot = await new WorkspaceIndex().build(root);
      assert.ok(snapshot);
      assert.equal(snapshot.entries.some((entry) => entry.relativePath === "file-00.txt"), false);
      assert.equal(snapshot.entries.length, 23);
    } finally {
      fsp.lstat = originalLstat;
    }

    const inaccessiblePath = path.join(root, "file-01.txt");
    fsp.lstat = async (target, ...args) => {
      if (path.resolve(String(target)) === inaccessiblePath) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat.call(fsp, target, ...args);
    };
    try {
      assert.equal(await new WorkspaceIndex().build(root), null);
    } finally {
      fsp.lstat = originalLstat;
    }

    const index = new WorkspaceIndex();
    const originalOpen = fsp.open;
    let notifyOpen;
    const firstOpen = new Promise((resolve) => { notifyOpen = resolve; });
    let releaseOpen;
    const openGate = new Promise((resolve) => { releaseOpen = resolve; });
    let started = 0;
    fsp.open = async (...args) => {
      started += 1;
      notifyOpen();
      await openGate;
      return originalOpen.apply(fsp, args);
    };
    const building = index.build(root);
    try {
      await firstOpen;
      index.handleWatcherEvent(root, "rename", path.join(root, "file-01.txt"));
      releaseOpen();
      assert.equal(await building, null);
      assert.ok(started <= 8);
      assert.equal(index.getLifecycleStats().activeBuildTokens, 0);
    } finally {
      releaseOpen();
      fsp.open = originalOpen;
      await index.flush(root);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceIndex release and invalidate cancel active probes before writing stale data", async () => {
  const roots = [];
  const makeRoot = async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-probe-lifecycle-"));
    roots.push(root);
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      fsp.writeFile(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "text\n"),
    ));
    return root;
  };
  const startBlockedBuild = async (index, root) => {
    const originalOpen = fsp.open;
    let notifyOpen;
    const firstOpen = new Promise((resolve) => { notifyOpen = resolve; });
    let releaseOpen;
    const openGate = new Promise((resolve) => { releaseOpen = resolve; });
    fsp.open = async (...args) => {
      notifyOpen();
      await openGate;
      return originalOpen.apply(fsp, args);
    };
    const building = index.build(root);
    await firstOpen;
    return {
      building,
      restore: () => { fsp.open = originalOpen; },
      releaseOpen,
    };
  };

  try {
    const releaseRoot = await makeRoot();
    const releaseIndex = new WorkspaceIndex();
    const originalSnapshot = await releaseIndex.build(releaseRoot);
    assert.ok(originalSnapshot);
    await releaseIndex.flush(releaseRoot);
    const cachePath = releaseIndex.getCacheFilePath(releaseRoot);
    const persistedBeforeRelease = JSON.parse(await fsp.readFile(cachePath, "utf8"));

    const releaseBuild = await startBlockedBuild(releaseIndex, releaseRoot);
    await releaseIndex.release(releaseRoot);
    releaseBuild.releaseOpen();
    releaseBuild.restore();
    assert.equal(await releaseBuild.building, null);
    const persistedAfterRelease = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    assert.equal(persistedAfterRelease.generatedAt, persistedBeforeRelease.generatedAt);

    const invalidateRoot = await makeRoot();
    const invalidateIndex = new WorkspaceIndex();
    const invalidateBuild = await startBlockedBuild(invalidateIndex, invalidateRoot);
    const invalidateCachePath = invalidateIndex.getCacheFilePath(invalidateRoot);
    await invalidateIndex.invalidate(invalidateRoot);
    invalidateBuild.releaseOpen();
    invalidateBuild.restore();
    assert.equal(await invalidateBuild.building, null);
    await invalidateIndex.flush(invalidateRoot);
    assert.equal(await fsp.stat(invalidateCachePath).catch(() => null), null);
    assert.equal(invalidateIndex.getLifecycleStats().activeBuildTokens, 0);
  } finally {
    for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceIndex releases watcher state while retaining a bounded cache across workspaces", async () => {
  const roots = [];
  const index = new WorkspaceIndex();
  try {
    for (let workspace = 0; workspace < 10; workspace += 1) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-release-"));
      roots.push(root);
      const filePath = path.join(root, "tracked.txt");
      await fsp.writeFile(filePath, `workspace ${workspace}\n`);
      await index.build(root);
      await fsp.writeFile(filePath, `updated workspace ${workspace}\n`);
      index.handleWatcherEvent(root, "change", filePath);
      await index.release(root);
      const state = index.getLifecycleStats();
      assert.equal(state.pendingWatcherRoots, 0);
      assert.equal(state.watcherEventTimers, 0);
      assert.equal(state.eventFlushQueues, 0);
      assert.equal(state.reconcileTimers, 0);
      assert.equal(state.reconcileQueues, 0);
      assert.equal(state.staleRemovals, 0);
      assert.equal(state.buildQueues, 0);
      assert.equal(state.writeQueues, 0);
      assert.equal(state.activeBuildTokens, 0);
      assert.equal(state.reconcileAgainRoots, 0);
    }
    const state = index.getLifecycleStats();
    assert.equal(state.cachedWorkspaces, 4);
    assert.equal(state.statsWorkspaces, 4);
    assert.equal(state.largeWorkspaceRoots, 0);
    assert.ok(state.rootRevisions <= 64);
    assert.ok(state.needsReconcileRoots <= 64);
    assert.equal((await index.load(roots.at(-1))).entries[0].size,
      Buffer.byteLength(`updated workspace 9\n`));
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
});

test("WorkspaceIndex bounds cache-load reconciliation state across many roots", async () => {
  const roots = [];
  const index = new WorkspaceIndex();
  try {
    for (let workspace = 0; workspace < 72; workspace += 1) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-index-load-bound-"));
      roots.push(root);
      const storage = new NceWorkspaceStorage(root);
      await fsp.mkdir(path.dirname(storage.getCachePath(WORKSPACE_INDEX_CACHE_FILE)), {
        recursive: true,
      });
      await fsp.writeFile(storage.getCachePath(WORKSPACE_INDEX_CACHE_FILE), JSON.stringify({
        version: WORKSPACE_INDEX_VERSION,
        root: path.resolve(root),
        generatedAt: Date.now(),
        complete: true,
        entries: [],
      }));
      assert.ok(await index.load(root));
    }
    const state = index.getLifecycleStats();
    assert.equal(state.cachedWorkspaces, 4);
    assert.equal(state.statsWorkspaces, 4);
    assert.equal(state.needsReconcileRoots, 64);
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
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
