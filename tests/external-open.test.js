const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { loadMain } = require("./helpers/main-runtime");
const { ExternalOpenCoordinator, MAX_EXTERNAL_OPEN_PATHS } = require("../dist/ts/manager/ExternalOpenCoordinator.js");

async function waitForDelivery(sent, index = 0) {
  for (let attempt = 0; attempt < 100 && sent.length <= index; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(sent.length > index, "expected an external open delivery");
  return sent[index].payload;
}

function makeWindow(id, { deliver } = {}) {
  const state = { destroyed: false, deliveries: [], notices: [] };
  const window = {
    id,
    state,
    window: {
      isDestroyed: () => state.destroyed,
      webContents: { isDestroyed: () => state.destroyed },
    },
    async deliverExternalFiles(paths) {
      state.deliveries.push([...paths]);
      if (deliver) return deliver(paths, state);
      return { openedPaths: [...paths], failures: [] };
    },
    notifyExternalOpenResult(result) { state.notices.push(result); },
  };
  return window;
}

function makeWindowManager(windows = [], { limit = 8 } = {}) {
  const byId = new Map(windows.map((window) => [window.id, window]));
  let activeId = windows[0]?.id || null;
  const openedFolders = [];
  const focusedIds = [];
  const manager = {
    windows: byId,
    openedFolders,
    focusedIds,
    getFocusedWindow: () => byId.get(activeId) || null,
    getAllWindows: () => [...byId.values()],
    focusWindow(id) {
      if (!byId.has(id)) return false;
      activeId = id;
      focusedIds.push(id);
      return true;
    },
    createEmptyWindow() {
      if (byId.size >= limit) return null;
      const window = makeWindow(`created-${byId.size}`);
      byId.set(window.id, window);
      activeId = window.id;
      return window;
    },
    async openWorkspaceInNewWindow(folderPath) {
      return (await manager.openWorkspaceInNewWindowWithOutcome(folderPath)).opened;
    },
    async openWorkspaceInNewWindowWithOutcome(folderPath) {
      openedFolders.push(folderPath);
      const existing = [...byId.values()].find((window) => window.workspacePath === folderPath);
      if (existing) {
        activeId = existing.id;
        return { opened: true, focused: true };
      }
      if (byId.size >= limit) return { opened: false, focused: false };
      const window = makeWindow(`folder-${byId.size}`);
      window.workspacePath = folderPath;
      byId.set(window.id, window);
      activeId = window.id;
      return { opened: true, focused: false };
    },
  };
  return manager;
}

function loadWindowWithTimers() {
  const timers = new Map();
  const clearedTimers = [];
  let nextTimerId = 0;
  const { Window, EXTERNAL_OPEN_TIMEOUTS_MS } = loadMain("dist/ts/Window.js", {
    electron: { app: {}, BrowserWindow: class {}, clipboard: {}, shell: {} },
    "./addon/FileManager": { FileManager: class {} },
    "./addon/Watcher": { Watcher: class {} },
    "./addon/Menu": { AppMenu: class {} },
    "./addon/ContextMenu": { ContextMenu: class {} },
    "./addon/WorkspaceSearch": { WorkspaceSearch: class {} },
    "./addon/AgentApprovalManager": { AgentApprovalManager: class {} },
    "./addon/AgentProcessRunner": { AgentProcessRunner: class {} },
    "./terminal/TerminalManager": { TerminalManager: class {} },
    "./terminal/TerminalTypes": { normalizeTerminalLink: (value) => value },
  }, {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
      timers.delete(id);
    },
  });
  return { Window, EXTERNAL_OPEN_TIMEOUTS_MS, timers, clearedTimers };
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-external-open-é-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "fichier avec espaces - 東京.js");
  const folder = path.join(root, "Projet été");
  await fs.writeFile(file, "const opened = true;\n", "utf8");
  await fs.mkdir(folder);
  return { root, file, folder };
}

test("native drop routes files to its captured WebContents window and folders through the workspace manager", async (t) => {
  const { file, folder, root } = await makeFixture(t);
  const windowA = makeWindow("a");
  const windowB = makeWindow("b");
  const windowC = makeWindow("c");
  const manager = makeWindowManager([windowA, windowB, windowC]);
  manager.focusWindow(windowC.id);
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();
  const secondFile = path.join(root, "second file.js");
  await fs.writeFile(secondFile, "const second = true;\n", "utf8");

  const result = await coordinator.enqueueDrop([
    file,
    secondFile,
    file,
    folder,
    path.join(root, "removed.js"),
    "relative.js",
  ], windowB);

  assert.equal(result.openedFiles, 2, "unique files open once while duplicate paths are ignored");
  assert.equal(result.openedFolders, 1);
  assert.equal(result.failures.length, 2, "a missing path and relative drop path fail independently");
  assert.deepEqual(windowA.state.deliveries, []);
  assert.deepEqual(windowB.state.deliveries, [[await fs.realpath(file), await fs.realpath(secondFile)]]);
  assert.deepEqual(windowC.state.deliveries, []);
  assert.deepEqual(manager.openedFolders, [await fs.realpath(folder)]);
  assert.ok(manager.focusedIds.includes(windowB.id), "the receiver was focused for the file open before folder windows were opened");
  coordinator.dispose();
});

test("system opens wait for restore, choose the focused window once, and process batches in order", async (t) => {
  const { root } = await makeFixture(t);
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  await Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")]);
  const firstWindow = makeWindow("first-window");
  const focusedWindow = makeWindow("focused-window");
  const manager = makeWindowManager([firstWindow, focusedWindow]);
  manager.focusWindow(focusedWindow.id);
  const coordinator = new ExternalOpenCoordinator(manager);

  let settled = false;
  const firstRequest = coordinator.enqueueSystemPaths([first], root).then((result) => {
    settled = true;
    return result;
  });
  const secondRequest = coordinator.enqueueSystemPaths([second], root);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "no external path is delivered before the restore barrier opens");
  coordinator.start();

  assert.equal((await firstRequest).openedFiles, 1);
  assert.equal((await secondRequest).openedFiles, 1);
  assert.deepEqual(focusedWindow.state.deliveries, [[await fs.realpath(first)], [await fs.realpath(second)]]);
  assert.deepEqual(firstWindow.state.deliveries, []);
  coordinator.dispose();
});

test("a blocked window does not block other windows, while each window retains request order", async (t) => {
  const { root } = await makeFixture(t);
  const paths = ["a-first.js", "a-second.js", "b.js", "c.js"].map((name) => path.join(root, name));
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, filePath)));
  let releaseA;
  const blockedA = new Promise((resolve) => { releaseA = resolve; });
  const windowA = makeWindow("a", { deliver: () => blockedA });
  const windowB = makeWindow("b");
  const windowC = makeWindow("c");
  const manager = makeWindowManager([windowA, windowB, windowC]);
  const coordinator = new ExternalOpenCoordinator(manager);

  const firstA = coordinator.enqueueSystemPaths([paths[0]], root);
  const secondA = coordinator.enqueueSystemPaths([paths[1]], root);
  manager.focusWindow(windowB.id);
  const requestB = coordinator.enqueueSystemPaths([paths[2]], root);
  manager.focusWindow(windowC.id);
  const requestC = coordinator.enqueueSystemPaths([paths[3]], root);
  coordinator.start();

  const fastResults = await Promise.race([
    Promise.all([requestB, requestC]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("independent windows were blocked")), 250)),
  ]);
  assert.deepEqual(fastResults.map((result) => result.openedFiles), [1, 1]);
  assert.deepEqual(windowB.state.deliveries, [[await fs.realpath(paths[2])]]);
  assert.deepEqual(windowC.state.deliveries, [[await fs.realpath(paths[3])]]);
  assert.deepEqual(windowA.state.deliveries, [[await fs.realpath(paths[0])]]);

  releaseA({ openedPaths: [await fs.realpath(paths[0])], failures: [] });
  assert.equal((await firstA).openedFiles, 1);
  assert.equal((await secondA).openedFiles, 1);
  assert.deepEqual(windowA.state.deliveries, [
    [await fs.realpath(paths[0])],
    [await fs.realpath(paths[1])],
  ]);
  coordinator.dispose();
});

test("system routing captures the receiving focus before path validation changes focus", async (t) => {
  const { root } = await makeFixture(t);
  const file = path.join(root, "focused-at-receipt.js");
  await fs.writeFile(file, "captured");
  const windowA = makeWindow("a");
  const windowB = makeWindow("b");
  const manager = makeWindowManager([windowA, windowB]);
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();

  const request = coordinator.enqueueSystemPaths([file], root);
  manager.focusWindow(windowB.id);
  assert.equal((await request).openedFiles, 1);
  assert.deepEqual(windowA.state.deliveries, [[await fs.realpath(file)]]);
  assert.deepEqual(windowB.state.deliveries, []);
  coordinator.dispose();
});

test("system directory requests reuse an open workspace and respect the window limit", async (t) => {
  const { root, folder } = await makeFixture(t);
  const otherFolder = path.join(root, "autre-projet");
  await fs.mkdir(otherFolder);
  const existing = makeWindow("existing");
  existing.workspacePath = await fs.realpath(folder);
  const manager = makeWindowManager([existing]);
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();

  const result = await coordinator.enqueueSystemPaths([folder, otherFolder, otherFolder]);
  assert.equal(result.openedFolders, 1);
  assert.equal(result.focusedFolders, 1, "the folder that was already open is reported as focused, not reopened");
  assert.equal(result.failures.length, 0);
  assert.equal(manager.getAllWindows().length, 2, "duplicate folder input opens only one new workspace window");
  assert.deepEqual(manager.openedFolders, [await fs.realpath(folder), await fs.realpath(otherFolder)]);

  const limitedManager = makeWindowManager(
    Array.from({ length: 8 }, (_, index) => makeWindow(`limit-${index}`)),
  );
  const limitedCoordinator = new ExternalOpenCoordinator(limitedManager);
  limitedCoordinator.start();
  const limited = await limitedCoordinator.enqueueSystemPaths([otherFolder]);
  assert.equal(limited.openedFolders, 0);
  assert.equal(limited.failures[0].code, "FOLDER_OPEN_FAILED");
  assert.equal(limitedManager.getAllWindows().length, 8);
  coordinator.dispose();
  limitedCoordinator.dispose();
});

test("cold system opens create only the windows needed for files and workspaces", async (t) => {
  const { root, folder } = await makeFixture(t);
  const secondFolder = path.join(root, "second workspace");
  const file = path.join(root, "cold file.js");
  await Promise.all([fs.mkdir(secondFolder), fs.writeFile(file, "cold")]);

  const folderManager = makeWindowManager();
  const folderCoordinator = new ExternalOpenCoordinator(folderManager);
  folderCoordinator.start();
  const folders = await folderCoordinator.enqueueSystemPaths([folder, secondFolder], root);
  assert.equal(folders.openedFolders, 2);
  assert.equal(folderManager.getAllWindows().length, 2, "folder-only start has no additional blank window");
  assert.deepEqual(folderManager.getAllWindows().map((window) => window.workspacePath), [
    await fs.realpath(folder),
    await fs.realpath(secondFolder),
  ]);
  folderCoordinator.dispose();

  const mixedManager = makeWindowManager();
  const mixedCoordinator = new ExternalOpenCoordinator(mixedManager);
  mixedCoordinator.start();
  const mixed = await mixedCoordinator.enqueueSystemPaths([file, folder], root);
  assert.equal(mixed.openedFiles, 1);
  assert.equal(mixed.openedFolders, 1);
  assert.equal(mixedManager.getAllWindows().length, 2,
    "mixed start creates one file target and one workspace window");
  assert.deepEqual(mixedManager.getAllWindows().map((window) => window.state.deliveries), [
    [[await fs.realpath(file)]],
    [],
  ]);
  mixedCoordinator.dispose();
});

test("adopted startup request chains are released with the window they routed to", async (t) => {
  const { file } = await makeFixture(t);
  const manager = makeWindowManager();
  const coordinator = new ExternalOpenCoordinator(manager);
  const request = coordinator.enqueueSystemPaths([file]);
  coordinator.start();
  assert.equal((await request).openedFiles, 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(coordinator.requestChains.size, 0,
    "a settled startup chain does not stay keyed to the window it adopted");
  coordinator.dispose();
});

test("concurrent folder requests preserve workspace uniqueness and the eight-window limit", async (t) => {
  const { root, folder } = await makeFixture(t);
  const secondFolder = path.join(root, "second concurrent workspace");
  await fs.mkdir(secondFolder);
  const first = makeWindow("first");
  const second = makeWindow("second");
  const duplicateManager = makeWindowManager([first, second]);
  const duplicateCoordinator = new ExternalOpenCoordinator(duplicateManager);
  duplicateCoordinator.start();
  const firstDuplicate = duplicateCoordinator.enqueueSystemPaths([folder], root);
  duplicateManager.focusWindow(second.id);
  const secondDuplicate = duplicateCoordinator.enqueueSystemPaths([folder], root);
  const canonicalFolder = await fs.realpath(folder);
  const duplicateResults = await Promise.all([firstDuplicate, secondDuplicate]);
  assert.equal(duplicateResults.reduce((count, result) => count + result.openedFolders, 0), 1);
  assert.equal(duplicateResults.reduce((count, result) => count + result.focusedFolders, 0), 1,
    "the second concurrent request focuses the workspace created by the first one");
  assert.equal(duplicateManager.getAllWindows().filter((window) =>
    window.workspacePath === canonicalFolder).length, 1);
  duplicateCoordinator.dispose();

  const fullManager = makeWindowManager(Array.from({ length: 7 }, (_, index) => makeWindow(`limit-${index}`)));
  const fullCoordinator = new ExternalOpenCoordinator(fullManager);
  fullCoordinator.start();
  const openA = fullCoordinator.enqueueSystemPaths([folder], root);
  fullManager.focusWindow("limit-1");
  const openB = fullCoordinator.enqueueSystemPaths([secondFolder], root);
  const limitedResults = await Promise.all([openA, openB]);
  assert.equal(fullManager.getAllWindows().length, 8);
  assert.equal(limitedResults.reduce((count, result) => count + result.openedFolders, 0), 1);
  assert.equal(limitedResults.reduce((count, result) => count + result.failures.length, 0), 1);
  fullCoordinator.dispose();
});

test("a captured drop target that closes while queued is never rerouted to another window", async (t) => {
  const { file } = await makeFixture(t);
  const target = makeWindow("drop-target");
  const other = makeWindow("other");
  const manager = makeWindowManager([target, other]);
  manager.focusWindow(other.id);
  const coordinator = new ExternalOpenCoordinator(manager);
  const request = coordinator.enqueueDrop([file], target);
  target.state.destroyed = true;
  coordinator.start();

  const result = await request;
  assert.equal(result.openedFiles, 0);
  assert.equal(result.failures[0].code, "WINDOW_UNAVAILABLE");
  assert.deepEqual(other.state.deliveries, []);
  coordinator.dispose();
});

test("invalid arguments and oversized batches fail without opening a window", async (t) => {
  const { root } = await makeFixture(t);
  const manager = makeWindowManager();
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();
  const invalid = await coordinator.enqueueSystemPaths(["", "https://example.test/file", path.join(root, "missing")]);
  assert.equal(invalid.openedFiles, 0);
  assert.equal(invalid.failures.length, 3);
  assert.equal(manager.getAllWindows()[0].state.notices.length, 1,
    "all-invalid system opens create/focus one window and report the failures");
  const oversized = await coordinator.enqueueSystemPaths(Array(MAX_EXTERNAL_OPEN_PATHS + 1).fill(path.join(root, "missing")));
  assert.equal(oversized.failures[0].code, "TOO_MANY_PATHS");
  coordinator.dispose();
});

test("system queue overflow is reported once a startup window becomes available", async (t) => {
  const { root, file } = await makeFixture(t);
  const manager = makeWindowManager();
  const coordinator = new ExternalOpenCoordinator(manager);
  const accepted = [];
  for (let index = 0; index < 64; index++) {
    accepted.push(coordinator.enqueueSystemPaths(["https://example.test/file"]));
  }
  const overflow = await coordinator.enqueueSystemPaths([file]);
  assert.equal(overflow.failures[0].code, "QUEUE_FULL");
  coordinator.start();
  await Promise.all(accepted);
  await new Promise((resolve) => setImmediate(resolve));

  const window = manager.getAllWindows()[0];
  assert.ok(window, "startup creates a window for the queued requests");
  assert.ok(
    window.state.notices.some((result) =>
      result.failures.some((failure) => failure.code === "QUEUE_FULL")),
    "the dropped request is surfaced instead of disappearing silently",
  );
  coordinator.dispose();
});

test("drop queue overflow returns to the renderer without a duplicate window notification", async (t) => {
  const { file } = await makeFixture(t);
  const target = makeWindow("drop-target");
  const manager = makeWindowManager([target]);
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  target.deliverExternalFiles = async (paths) => {
    await gate;
    return { openedPaths: [...paths], failures: [] };
  };

  const accepted = [];
  for (let index = 0; index < 64; index++) {
    accepted.push(coordinator.enqueueDrop([file], target));
  }
  const overflow = await coordinator.enqueueDrop([file], target);
  assert.equal(overflow.failures[0].code, "QUEUE_FULL");
  assert.equal(target.state.notices.length, 0,
    "drop failures are reported through the renderer response, not a second notification");

  release();
  const results = await Promise.all(accepted);
  assert.ok(results.every((result) => result.openedFiles === 1));
  assert.equal(target.state.notices.length, 0);
  coordinator.dispose();
});

test("POSIX paths preserve significant leading and trailing whitespace and deduplicate symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root } = await makeFixture(t);
  const leadingSpace = path.join(root, " leading.js");
  const trailingSpace = path.join(root, "trailing.js ");
  const whitespaceName = path.join(root, "   ");
  const alias = path.join(root, "trailing-alias.js");
  await Promise.all([
    fs.writeFile(leadingSpace, "leading"),
    fs.writeFile(trailingSpace, "trailing"),
    fs.writeFile(whitespaceName, "spaces"),
  ]);
  await fs.symlink(trailingSpace, alias);
  const target = makeWindow("target");
  const manager = makeWindowManager([target]);
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();

  const result = await coordinator.enqueueSystemPaths(
    [leadingSpace, trailingSpace, whitespaceName, alias],
    root,
  );
  assert.equal(result.openedFiles, 3);
  assert.deepEqual(target.state.deliveries, [[
    await fs.realpath(leadingSpace),
    await fs.realpath(trailingSpace),
    await fs.realpath(whitespaceName),
  ]]);
  coordinator.dispose();
});

test("renderer reload attempts reject stale ACKs and a late ACK after timeout is ignored", async () => {
  const { Window, EXTERNAL_OPEN_TIMEOUTS_MS, timers, clearedTimers } = loadWindowWithTimers();
  assert.equal(JSON.stringify(EXTERNAL_OPEN_TIMEOUTS_MS), JSON.stringify({
    rendererReady: 90_000,
    acknowledgement: 120_000,
  }));
  const window = new Window({});
  const sent = [];
  window.window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  window.rendererReady = true;

  const deliveryResult = window.deliverExternalFiles(["/tmp/file.js"]);
  const firstMessage = await waitForDelivery(sent);
  assert.equal(firstMessage.attempt, 1);
  const delivery = window.pendingExternalOpenDeliveries.get(firstMessage.requestId);
  delivery.sent = false;
  window.armExternalOpenDeliveryTimeout(
    firstMessage.requestId,
    delivery,
    EXTERNAL_OPEN_TIMEOUTS_MS.rendererReady,
  );
  window.flushExternalOpenDeliveries();
  const secondMessage = sent[1].payload;
  assert.equal(secondMessage.requestId, firstMessage.requestId);
  assert.equal(secondMessage.attempt, 2);
  assert.equal(window.acknowledgeExternalOpen(firstMessage.requestId, 1, {
    openedPaths: ["/tmp/file.js"],
  }), false, "an ACK from before reload cannot settle the current delivery attempt");
  assert.equal(window.acknowledgeExternalOpen(secondMessage.requestId, 2, {
    openedPaths: ["/tmp/file.js"],
  }), true);
  assert.equal(window.acknowledgeExternalOpen(secondMessage.requestId, 2, {
    openedPaths: ["/tmp/file.js"],
  }), false, "a consumed ACK is not accepted twice");
  assert.equal(JSON.stringify(await deliveryResult), JSON.stringify({
    openedPaths: ["/tmp/file.js"],
    failures: [],
  }));
  assert.equal(window.pendingExternalOpenDeliveries.size, 0);
  assert.equal(timers.size, 0);
  assert.ok(clearedTimers.length >= 2);

  const lateIndex = sent.length;
  const lateResult = window.deliverExternalFiles(["/tmp/slow.js"]);
  const lateMessage = await waitForDelivery(sent, lateIndex);
  const activeTimer = [...timers.keys()].at(-1);
  timers.get(activeTimer).callback();
  assert.equal(JSON.stringify(await lateResult), JSON.stringify({
    openedPaths: [],
    failures: [{
      path: "/tmp/slow.js",
      message: "The editor did not confirm that this file was opened.",
    }],
  }));
  assert.equal(window.acknowledgeExternalOpen(lateMessage.requestId, lateMessage.attempt, {
    openedPaths: ["/tmp/slow.js"],
  }), false, "a late ACK after expiry cannot reopen or resettle the delivery");
  assert.equal(window.pendingExternalOpenDeliveries.size, 0);
  assert.equal(timers.size, 0);
});

test("renderer progress re-arms the acknowledgement deadline until the batch completes", async () => {
  const { Window, timers, clearedTimers } = loadWindowWithTimers();
  const sent = [];
  const window = new Window({});
  window.window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  window.rendererReady = true;

  const result = window.deliverExternalFiles(["/tmp/one.js", "/tmp/two.js"]);
  const message = await waitForDelivery(sent);
  const initialTimer = [...timers.keys()].at(-1);
  assert.equal(window.noteExternalOpenProgress(message.requestId, message.attempt), true);
  assert.ok(clearedTimers.includes(initialTimer), "progress clears the pending inactivity timer");
  const progressTimer = [...timers.keys()].at(-1);
  assert.notEqual(progressTimer, initialTimer, "progress arms a fresh inactivity timer");
  assert.equal(window.noteExternalOpenProgress(message.requestId, message.attempt + 1), false,
    "a stale delivery attempt cannot extend the deadline");
  assert.equal(window.noteExternalOpenProgress("unknown-delivery", message.attempt), false);
  assert.equal(window.acknowledgeExternalOpen(message.requestId, message.attempt, {
    openedPaths: ["/tmp/one.js", "/tmp/two.js"],
  }), true);
  assert.equal(window.noteExternalOpenProgress(message.requestId, message.attempt), false,
    "a settled delivery ignores late progress");
  assert.equal(timers.size, 0);
  assert.equal(JSON.stringify(await result), JSON.stringify({
    openedPaths: ["/tmp/one.js", "/tmp/two.js"],
    failures: [],
  }));
});

test("progress cannot extend a delivery that is waiting for a renderer reload", async () => {
  const { Window, timers } = loadWindowWithTimers();
  const sent = [];
  const window = new Window({});
  window.window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  window.rendererReady = true;

  const result = window.deliverExternalFiles(["/tmp/reload.js"]);
  const message = await waitForDelivery(sent);
  const delivery = window.pendingExternalOpenDeliveries.get(message.requestId);
  delivery.sent = false;
  assert.equal(window.noteExternalOpenProgress(message.requestId, message.attempt), false,
    "progress from an obsolete attempt cannot revive a delivery that must be resent");
  delivery.sent = true;
  window.acknowledgeExternalOpen(message.requestId, message.attempt, { openedPaths: ["/tmp/reload.js"] });
  assert.equal((await result).openedPaths[0], "/tmp/reload.js");
  assert.equal(timers.size, 0, "the acknowledged delivery leaves no timer behind");
});

test("path classification probes the filesystem concurrently without reordering deliveries", async () => {
  const paths = Array.from({ length: 32 }, (_, index) =>
    path.join(os.tmpdir(), `nce-classification-${process.pid}-${index}.js`));
  let active = 0;
  let maxActive = 0;
  const { ExternalOpenCoordinator: ConcurrentCoordinator } = loadMain(
    "dist/ts/manager/ExternalOpenCoordinator.js",
    {
      "node:fs/promises": {
        async realpath(value) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return value;
        },
        async stat() { return { isFile: () => true, isDirectory: () => false }; },
        async access() {},
      },
      "node:fs": { constants: { R_OK: 4, X_OK: 1 } },
    },
  );
  const target = makeWindow("classification-target");
  const coordinator = new ConcurrentCoordinator(makeWindowManager([target]));
  coordinator.start();
  const result = await coordinator.enqueueDrop(paths, target);

  assert.equal(result.openedFiles, paths.length);
  assert.deepEqual(target.state.deliveries[0], paths);
  assert.ok(maxActive <= 8, `classification issued ${maxActive} concurrent filesystem probes`);
  assert.ok(maxActive > 1, "independent paths are not validated serially");
  coordinator.dispose();
});

test("App captures macOS open-file before the lock and queues startup and second-instance paths", async (t) => {
  const { root, file, folder } = await makeFixture(t);
  const startupFile = path.join(root, "startup file.js");
  const startupUriFile = path.join(root, "fichier URI été.js");
  const inspectFile = path.join(root, "after-inspect.js");
  const equalsFlagFile = path.join(root, "after-empty-flag-value.js");
  const leadingDashFolder = path.join(root, "-leading-folder");
  const secondFile = path.join(root, "second instance.js");
  await Promise.all([
    fs.writeFile(startupFile, "startup"),
    fs.writeFile(startupUriFile, "startup URI"),
    fs.writeFile(inspectFile, "after inspect"),
    fs.writeFile(equalsFlagFile, "after equals option"),
    fs.writeFile(secondFile, "second"),
    fs.mkdir(leadingDashFolder),
  ]);
  const app = new EventEmitter();
  app.isPackaged = true;
  app.getAppPath = () => root;
  app.getPath = () => path.join(root, "profile");
  app.getVersion = () => "test";
  app.quit = () => {};
  const calls = [];
  let lockOpenFilePrevented = false;
  app.requestSingleInstanceLock = () => {
    assert.equal(app.listenerCount("open-file"), 1, "macOS listener is registered before requesting the lock");
    app.emit("open-file", { preventDefault() { lockOpenFilePrevented = true; } }, file);
    return true;
  };

  class FakeExternalOpenCoordinator {
    constructor() { this.requests = []; }
    enqueueSystemPaths(paths, cwd) {
      this.requests.push({ paths: [...paths], cwd });
      calls.push(["enqueue", [...paths], cwd]);
      return Promise.resolve({ success: true, openedFiles: 0, openedFolders: 0, failures: [] });
    }
    enqueueDrop() { throw new Error("not expected in this App test"); }
    hasPendingSystemRequests() { return this.requests.length > 0; }
    start() { calls.push(["start"]); }
    dispose() {}
  }
  class FakeWindowManager {
    constructor() { this.windows = []; }
    async restoreSessions(options) { calls.push(["restore", options]); }
    getAllWindows() { return this.windows; }
    getFocusedWindow() { return null; }
    createEmptyWindow() { calls.push(["create-empty"]); }
    dispose() {}
  }
  class FakeIpcRouter { dispose() {} }
  class FakeSessionStore { async initialize() {} }
  class FakeManager { async initialize() {} async flush() { return true; } }
  class FakeNshServer { async start() { return 1234; } async stop() {} getPort() { return 1234; } }
  const mockProcess = {
    platform: process.platform,
    isPackaged: true,
    execPath: "/fake/NCE",
    env: {},
    cwd: () => root,
    argv: [
      "/fake/NCE", startupFile, "--user-data-dir", root, "--enable-logging", folder,
      pathToFileURL(startupUriFile).href, "https://example.test/file", "--inspect", inspectFile,
      "--user-data-dir=", equalsFlagFile, "--", "-leading-folder",
    ],
  };
  const { App } = loadMain("dist/ts/App.js", {
    electron: { app, BrowserWindow: { getFocusedWindow: () => null }, dialog: {} },
    "./Window": { Window: class {} },
    "nsh/server": { NSHServer: FakeNshServer },
    "./manager/IpcRouter": { IpcRouter: FakeIpcRouter },
    "./manager/WindowManager": { WindowManager: FakeWindowManager },
    "./manager/WindowSessionStore": { WindowSessionStore: FakeSessionStore },
    "./manager/SettingsManager": { SettingsManager: FakeManager },
    "./manager/RecentFoldersManager": { RecentFoldersManager: FakeManager },
    "./manager/AgentConversationStore": { AgentConversationStore: FakeManager },
    "./manager/AgentSecretStore": { AgentSecretStore: FakeManager },
    "./manager/ExternalOpenCoordinator": { ExternalOpenCoordinator: FakeExternalOpenCoordinator },
  }, { process: mockProcess });

  const runtime = new App();
  assert.equal(lockOpenFilePrevented, true);
  assert.deepEqual(runtime.externalOpenCoordinator.requests.slice(0, 2), [
    { paths: [startupFile, folder, startupUriFile, inspectFile, equalsFlagFile, "-leading-folder"], cwd: root },
    { paths: [file], cwd: root },
  ], "startup flags and their values are filtered while early document opens are retained");

  app.emit("open-file", { preventDefault() {} }, secondFile);
  assert.deepEqual(runtime.externalOpenCoordinator.requests[2], {
    paths: [secondFile], cwd: root,
  }, "additional macOS document events are queued while NCE is already running");

  app.emit("ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.findIndex(([step]) => step === "start") > calls.findIndex(([step]) => step === "restore"),
    "external path delivery starts after session restoration");
  assert.equal(JSON.stringify(calls.find(([step]) => step === "restore")[1]), JSON.stringify({ createEmptyWindow: false }),
    "startup paths suppress the empty fallback window while the coordinator restores sessions first");

  const secondWorkingDirectory = path.join(root, "working directory");
  const secondFolder = path.join(root, "second folder");
  await fs.mkdir(secondWorkingDirectory);
  await fs.mkdir(secondFolder);
  app.emit("second-instance", {}, ["/fake/NCE", secondFile, "--enable-logging", secondFolder], secondWorkingDirectory);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.externalOpenCoordinator.requests.at(-1), {
    paths: [secondFile, secondFolder],
    cwd: secondWorkingDirectory,
  });

  app.isPackaged = false;
  app.emit("second-instance", {}, ["/fake/Electron", "/project/dist/main.js", secondFile], secondWorkingDirectory);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.externalOpenCoordinator.requests.at(-1), {
    paths: [secondFile],
    cwd: secondWorkingDirectory,
  }, "development second-instance requests omit the Electron entry script");

  mockProcess.platform = "win32";
  app.isPackaged = true;
  const windowsCwd = String.raw`C:\Project`;
  const windowsFile = String.raw`C:\Project\file with spaces.js`;
  const uncFile = String.raw`\\server\share\file.js`;
  app.emit("second-instance", {}, [String.raw`C:\Program Files\NCE.exe`, windowsFile, uncFile], windowsCwd);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.externalOpenCoordinator.requests.at(-1), {
    paths: [windowsFile, uncFile], cwd: windowsCwd,
  }, "Windows drive and UNC paths remain filesystem paths instead of URL schemes");
});
