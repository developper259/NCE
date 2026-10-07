const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadGlobal, createEditor } = require("./helpers/runtime");
const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const [, , , FileNode] = loadGlobal("src/js/types/Tab.js", "[TAB_TYPES, Tab, SettingsTab, FileNode]", { LineNode });
const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
const StatesManager = loadGlobal("src/js/manager/StatesManager.js", "StatesManager", {
  FileNode, TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" }, NCEPath,
});
const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
  FileNode,
  SettingsTab: class {},
  TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
  NCEPath,
  getElement: () => null,
  Events: {},
  PictureView: { isSupportedPath: () => false },
});
const {
  DirtyBufferRecoveryStore,
  MAX_RECOVERY_AGE_MS,
  MAX_RECOVERY_SNAPSHOT_BYTES,
  MAX_RECOVERY_SNAPSHOT_LINES,
  MAX_RECOVERY_SNAPSHOTS,
} = require("../dist/ts/addon/DirtyBufferRecovery.js");
const { NceWorkspaceStorage } = require("../dist/ts/addon/NceWorkspaceStorage.js");
const { FileManager } = require("../dist/ts/addon/FileManager.js");

async function temporaryRoot(prefix = "nce-recovery-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function snapshot(overrides = {}) {
  const identity = overrides.identity || "untitled:test-buffer";
  return {
    identity,
    kind: "untitled",
    displayName: "Untitled",
    content: "first\r\nsecond\n",
    lineCount: 2,
    editVersion: 1,
    ...overrides,
  };
}

test("recovery snapshots are atomic, coalesce by buffer identity, and survive a new store instance", async () => {
  const root = await temporaryRoot();
  try {
    const store = new DirtyBufferRecoveryStore(root);
    const first = await store.save(snapshot({ content: "old", editVersion: 1 }));
    const latest = await store.save(snapshot({ content: "latest", editVersion: 20 }));
    assert.equal(first.success, true);
    assert.equal(latest.id, first.id);
    assert.deepEqual(await new DirtyBufferRecoveryStore(root).read(first.id), {
      ...snapshot({ content: "latest", editVersion: 20 }),
      schemaVersion: 1,
      id: first.id,
      timestamp: (await store.read(first.id)).timestamp,
      filePath: null,
      relativePath: null,
      diskFingerprint: null,
    });
    assert.equal((await store.list()).length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("path recovery records report disk changes without touching the original file", async () => {
  const root = await temporaryRoot();
  const filePath = path.join(root, "source.txt");
  try {
    await fsp.writeFile(filePath, "base\n");
    const stats = await fsp.stat(filePath);
    const store = new DirtyBufferRecoveryStore(root);
    const saved = await store.save(snapshot({
      identity: "path:source.txt",
      kind: "path",
      filePath,
      relativePath: "source.txt",
      displayName: "source.txt",
      content: "local edit\n",
      lineCount: 1,
      diskFingerprint: `${stats.size}:${stats.mtimeMs}`,
    }));
    await fsp.writeFile(filePath, "new disk content\n");
    const listed = await store.list();
    assert.equal(listed[0].id, saved.id);
    assert.equal(listed[0].diskChanged, true);
    assert.equal((await fsp.readFile(filePath, "utf8")), "new disk content\n");
    assert.equal((await store.read(saved.id)).content, "local edit\n");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager derives workspace-relative recovery identity and rejects invalid roots", async () => {
  const root = await temporaryRoot();
  const filePath = path.join(root, "nested", "file.txt");
  try {
    await fsp.mkdir(path.dirname(filePath));
    await fsp.writeFile(filePath, "base");
    const manager = new FileManager({ window: null, watcher: null });
    const result = await manager.saveRecoverySnapshot(root, {
      filePath,
      displayName: "file.txt",
      content: "recovered",
      lineCount: 1,
      editVersion: 2,
    });
    assert.equal(result.success, true);
    assert.equal((await manager.getRecoveryStore(root)).root, await fsp.realpath(root));
    const metadata = await (await manager.getRecoveryStore(root)).list();
    assert.equal(metadata[0].relativePath, "nested/file.txt");
    assert.equal(await manager.saveRecoverySnapshot("relative-root", {
      filePath,
      displayName: "file.txt",
      content: "recovered",
      lineCount: 1,
      editVersion: 2,
    }).then((value) => value.success), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("recovery snapshots stay isolated by workspace and clean quit deletion is durable", async () => {
  const firstRoot = await temporaryRoot("nce-recovery-workspace-a-");
  const secondRoot = await temporaryRoot("nce-recovery-workspace-b-");
  try {
    const firstStore = new DirtyBufferRecoveryStore(firstRoot);
    const secondStore = new DirtyBufferRecoveryStore(secondRoot);
    const first = await firstStore.save(snapshot({ identity: "untitled:stable-buffer" }));
    const second = await secondStore.save(snapshot({ identity: "untitled:stable-buffer" }));
    assert.equal(first.id, second.id);
    assert.equal((await firstStore.list()).length, 1);
    assert.equal((await secondStore.list()).length, 1);
    assert.equal(await firstStore.delete(first.id), true);
    assert.equal((await new DirtyBufferRecoveryStore(firstRoot).list()).length, 0);
    assert.equal((await secondStore.read(second.id)).content, "first\r\nsecond\n");
  } finally {
    await fsp.rm(firstRoot, { recursive: true, force: true });
    await fsp.rm(secondRoot, { recursive: true, force: true });
  }
});

test("Agent temp cleanup preserves recovery snapshots", async () => {
  const root = await temporaryRoot();
  try {
    const store = new DirtyBufferRecoveryStore(root);
    const saved = await store.save(snapshot());
    await new NceWorkspaceStorage(root).cleanupTemp(0);
    assert.equal((await store.read(saved.id)).content, "first\r\nsecond\n");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("recovery refuses a symlinked storage directory", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot("nce-recovery-outside-");
  try {
    await fsp.mkdir(path.join(root, ".nce", "temp"), { recursive: true });
    await fsp.symlink(outside, path.join(root, ".nce", "temp", "recovery"), "dir");
    const result = await new DirtyBufferRecoveryStore(root).save(snapshot());
    assert.equal(result.success, false);
    assert.deepEqual(await fsp.readdir(outside), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test("corrupt and aged recovery records are removed during listing", async () => {
  const root = await temporaryRoot();
  let now = 1_800_000_000_000;
  try {
    const store = new DirtyBufferRecoveryStore(root, { now: () => now });
    const aged = await store.save(snapshot({ identity: "untitled:aged" }));
    const corrupt = await store.save(snapshot({ identity: "untitled:corrupt" }));
    await fsp.writeFile(store.recoveryRoot + `/${corrupt.id}.json`, "{broken", "utf8");
    const abandonedTemp = path.join(store.recoveryRoot, `${"a".repeat(64)}.1234.${"b".repeat(16)}.tmp`);
    await fsp.writeFile(abandonedTemp, "interrupted atomic write", "utf8");
    now += MAX_RECOVERY_AGE_MS + 1;
    assert.deepEqual(await store.list(), []);
    assert.equal(await fsp.access(store.recoveryRoot + `/${aged.id}.json`).then(() => true, () => false), false);
    assert.equal(await fsp.access(store.recoveryRoot + `/${corrupt.id}.json`).then(() => true, () => false), false);
    assert.equal(await fsp.access(abandonedTemp).then(() => true, () => false), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("recovery snapshots enforce per-record, line-count, and retention bounds", async () => {
  const root = await temporaryRoot();
  try {
    let now = Date.now();
    const store = new DirtyBufferRecoveryStore(root, { now: () => now++ });
    assert.equal((await store.save(snapshot({ content: "x".repeat(MAX_RECOVERY_SNAPSHOT_BYTES + 1) }))).reason,
      "RECOVERY_SNAPSHOT_TOO_LARGE");
    assert.equal((await store.save(snapshot({ lineCount: MAX_RECOVERY_SNAPSHOT_LINES + 1 }))).reason,
      "INVALID_SNAPSHOT");
    for (let index = 0; index < MAX_RECOVERY_SNAPSHOTS + 3; index++) {
      const result = await store.save(snapshot({ identity: `untitled:buffer-${index}` }));
      assert.equal(result.success, true);
    }
    assert.equal((await store.list()).length, MAX_RECOVERY_SNAPSHOTS);
    assert.equal(await store.read(require("node:crypto").createHash("sha256").update("untitled:buffer-0").digest("hex")), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("total recovery storage stays bounded when escaped text expands on disk", async () => {
  const root = await temporaryRoot();
  try {
    const store = new DirtyBufferRecoveryStore(root);
    const ids = [];
    for (let index = 0; index < 3; index++) {
      const result = await store.save(snapshot({
        identity: `untitled:expanded-${index}`,
        content: "\0".repeat(1_000_000),
      }));
      assert.equal(result.success, true);
      ids.push(result.id);
    }
    const listed = await store.list();
    assert.equal(listed.length, 2);
    assert.equal(await store.read(ids[0]), null);
    assert.ok((await fsp.stat(store.recoveryRoot)).isDirectory());
    const files = await fsp.readdir(store.recoveryRoot);
    const total = (await Promise.all(files.map(async (name) =>
      (await fsp.stat(path.join(store.recoveryRoot, name))).size,
    ))).reduce((sum, size) => sum + size, 0);
    assert.ok(total <= 16 * 1024 * 1024);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("failed atomic replacement retains the previous recovery snapshot", async () => {
  const root = await temporaryRoot();
  try {
    const original = new DirtyBufferRecoveryStore(root);
    const saved = await original.save(snapshot({ content: "previous" }));
    let failRename = true;
    const operations = Object.create(fsp);
    operations.rename = async (...args) => {
      if (failRename) {
        failRename = false;
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      }
      return fsp.rename(...args);
    };
    const failing = new DirtyBufferRecoveryStore(root, { operations });
    const failed = await failing.save(snapshot({ content: "replacement" }));
    assert.equal(failed.success, false);
    assert.equal((await original.read(saved.id)).content, "previous");
    assert.equal((await fsp.readdir(original.recoveryRoot)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a rapid edit burst emits one latest recovery snapshot and restore preserves line endings", async () => {
  const { editor } = createEditor();
  const writes = [];
  const deletions = [];
  editor.fileExplorer = { rootPath: "/workspace" };
  editor.api = {
    async saveRecoverySnapshot(root, value) {
      writes.push({ root, ...value });
      return { success: true, id: "a".repeat(64) };
    },
    async deleteRecoverySnapshot(root, id) { deletions.push({ root, id }); return true; },
  };
  const file = new FileNode(editor, 1, "Untitled", null);
  editor.tabManager = new TabManager(editor);
  editor.tabManager.tabs = [file];
  editor.tabManager.activeFile = file;
  file.setIsSaved(false);
  for (let index = 0; index < 20; index++) {
    file.lines = [new LineNode(`edit-${index}`)];
    file.editVersion = index + 1;
    file.scheduleRecoverySnapshot();
  }
  assert.equal(await file.flushRecoverySnapshot(), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, "edit-19");
  assert.equal(writes[0].editVersion, 20);
  assert.equal(writes[0].root, "/workspace");

  file.restoreRecoveredContent("one\r\ntwo\n", { snapshotId: "a".repeat(64), storeRoot: "/workspace" });
  assert.equal(file.serializeContent(), "one\r\ntwo\n");
  assert.equal(file.isSaved, false);
  assert.equal(file.externalModified, false);
  file.disposeRecovery();
  assert.equal(await editor.tabManager.clearRecoverySnapshots(), true);
  assert.equal(deletions.length, 1);
});

test("clean quit flushes and clears recovery while a cancelled quit retains it", async () => {
  for (const choice of ["dontSave", "cancel"]) {
    const { editor } = createEditor();
    const writes = [];
    const deletions = [];
    editor.fileExplorer = { rootPath: "/workspace" };
    editor.api = {
      async saveRecoverySnapshot(root, value) {
        writes.push({ root, ...value });
        return { success: true, id: "d".repeat(64) };
      },
      async deleteRecoverySnapshot(root, id) { deletions.push({ root, id }); return true; },
    };
    const file = new FileNode(editor, 1, "Untitled", null);
    file.lines = [new LineNode("unsaved")];
    file.isSaved = false;
    file.editVersion = 1;
    const manager = new TabManager(editor);
    editor.tabManager = manager;
    manager.tabs = [file];
    manager.activeFile = file;
    editor.savePopupManager = { confirmClose: async () => choice };
    assert.equal(await manager.prepareForQuit(), choice !== "cancel");
    assert.equal(writes.length, 1);
    if (choice === "dontSave") {
      assert.equal(await manager.clearRecoverySnapshots(), true);
      assert.equal(deletions.length, 1);
    } else {
      assert.equal(deletions.length, 0);
      assert.equal(file.recoverySnapshotId, "d".repeat(64));
    }
    file.disposeRecovery();
  }
});

test("restoring a stale snapshot keeps the disk conflict guard active", async () => {
  const { editor } = createEditor();
  let writes = 0;
  editor.api = { saveFile: async () => { writes += 1; return "/file.txt"; } };
  const file = new FileNode(editor, 1, "file.txt", "/file.txt");
  file.isLoaded = true;
  file.loadingState = { status: "loaded", loadedLineCount: 1, expectedTotalLines: 1 };
  file.restoreRecoveredContent("recovered", { diskChanged: true });
  const originalAlert = global.alert;
  const originalWarn = console.warn;
  global.alert = () => {};
  console.warn = () => {};
  try { assert.equal(await file.save(), false); }
  finally { global.alert = originalAlert; console.warn = originalWarn; }
  assert.equal(writes, 0);
  assert.equal(file.externalModified, true);
  file.disposeRecovery();
});

test("startup recovery restores only after explicit choice and does not write to disk", async () => {
  const { editor } = createEditor();
  const metadata = {
    id: "b".repeat(64), kind: "path", filePath: "/workspace/source.txt",
    displayName: "source.txt", diskFingerprint: "4:10", diskChanged: true,
    diskMissing: false, timestamp: Date.now(),
  };
  const file = new FileNode(editor, 2, "source.txt", metadata.filePath);
  file.diskFingerprint = "9:20";
  const calls = { confirmed: 0, read: 0, deleted: 0, saved: 0 };
  editor.tabManager = {
    tabs: [file], activeFile: file,
    getFileByPath(candidate) { return candidate === file.path ? file : null; },
    async setFocusFile(candidate) { this.activeFile = candidate; return candidate; },
  };
  editor.fileLoader = { async waitForFileLoaded() {} };
  editor.lineController.markDirtyAll = () => {};
  editor.api = {
    async listRecoverySnapshots() { return [metadata]; },
    async confirmRecoverySnapshot(value) { calls.confirmed++; assert.equal(value.id, metadata.id); return "restore"; },
    async readRecoverySnapshot() {
      calls.read++;
      return { content: "recovered local text", editVersion: 4 };
    },
    async deleteRecoverySnapshot() { calls.deleted++; return true; },
    async saveFile() { calls.saved++; return file.path; },
  };
  editor.fileExplorer = { rootPath: "/workspace" };
  const manager = new StatesManager(editor);
  assert.equal(await manager.offerDirtyBufferRecovery("/workspace"), 1);
  assert.equal(calls.confirmed, 1);
  assert.equal(calls.read, 1);
  assert.equal(calls.deleted, 0);
  assert.equal(calls.saved, 0);
  assert.equal(file.serializeContent(), "recovered local text");
  assert.equal(file.externalModified, true);
  assert.equal(file.isSaved, false);
  file.disposeRecovery();
});

test("restoring a Markdown buffer switches its preview tab back to text first", async () => {
  const { editor } = createEditor();
  const pathValue = "/workspace/README.md";
  const markdownTab = { id: 2, type: "markdown", path: pathValue, textTab: null };
  const file = new FileNode(editor, 2, "README.md", pathValue);
  file.isLoaded = true;
  file.loadingState = { status: "loaded", loadedLineCount: 1, expectedTotalLines: 1 };
  let switched = 0;
  const manager = {
    tabs: [markdownTab], activeTab: markdownTab, activeFile: null,
    async setFocusTab(tab) { this.activeTab = tab; return tab; },
    async switchActiveTabView(view) {
      assert.equal(view, "text");
      switched++;
      this.tabs = [file];
      return file;
    },
    async setFocusFile(candidate) { this.activeTab = candidate; this.activeFile = candidate; return candidate; },
    async closeFile() { return true; },
  };
  editor.tabManager = manager;
  editor.fileLoader = { async waitForFileLoaded() {} };
  editor.lineController.markDirtyAll = () => {};
  editor.fileExplorer = { rootPath: "/workspace" };
  editor.api = {
    async listRecoverySnapshots() {
      return [{ id: "9".repeat(64), kind: "path", filePath: pathValue,
        displayName: "README.md", timestamp: Date.now(), diskMissing: false,
        diskChanged: false }];
    },
    async confirmRecoverySnapshot() { return "restore"; },
    async readRecoverySnapshot() { return { content: "recovered markdown", editVersion: 3 }; },
    async deleteRecoverySnapshot() { return true; },
  };
  assert.equal(await new StatesManager(editor).offerDirtyBufferRecovery("/workspace"), 1);
  assert.equal(switched, 1);
  assert.equal(manager.activeFile, file);
  assert.equal(file.serializeContent(), "recovered markdown");
  file.disposeRecovery();
});

test("declining recovery deletes the snapshot while cancelling leaves it available", async () => {
  for (const choice of ["discard", "cancel"]) {
    const { editor } = createEditor();
    const calls = { read: 0, deleted: 0 };
    editor.api = {
      async listRecoverySnapshots() { return [{ id: "c".repeat(64), displayName: "Untitled", kind: "untitled" }]; },
      async confirmRecoverySnapshot() { return choice; },
      async readRecoverySnapshot() { calls.read++; return null; },
      async deleteRecoverySnapshot() { calls.deleted++; return true; },
    };
    editor.tabManager = { tabs: [] };
    const manager = new StatesManager(editor);
    assert.equal(await manager.offerDirtyBufferRecovery(null), 0);
    assert.equal(calls.read, 0);
    assert.equal(calls.deleted, choice === "discard" ? 1 : 0);
  }
});

test("clean quit clears orphaned recovery records for the active workspace and untitled scope", async () => {
  const { editor } = createEditor();
  editor.fileExplorer = { rootPath: "/workspace" };
  editor.tabManager = { async clearRecoverySnapshots() { return true; } };
  const deleted = [];
  editor.api = {
    async listRecoverySnapshots(root) {
      return [{ id: root ? "e".repeat(64) : "f".repeat(64) }];
    },
    async deleteRecoverySnapshot(root, id) { deleted.push({ root, id }); return true; },
  };
  const manager = new StatesManager(editor);
  assert.equal(await manager.clearRecoverySnapshotsOnQuit(), true);
  assert.deepEqual(deleted, [
    { root: "/workspace", id: "e".repeat(64) },
    { root: null, id: "f".repeat(64) },
  ]);
});
