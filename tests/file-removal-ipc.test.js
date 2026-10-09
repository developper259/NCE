const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("Preload maps the named deletion APIs to separate IPC channels", async () => {
  const calls = [];
  const exposed = {};
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) { exposed[name] = api; },
    },
    ipcRenderer: {
      invoke: async (...args) => { calls.push(args); return { success: true }; },
      on() {},
      removeListener() {},
    },
  };
  const source = await fs.readFile(
    path.join(__dirname, "../src/js/main/Preload.js"),
    "utf8",
  );
  vm.runInNewContext(source, {
    require: (name) => name === "electron" ? electron : require(name),
    process: { platform: "linux" },
  });
  assert.equal(typeof exposed.api.moveToTrash, "function");
  assert.equal(typeof exposed.api.permanentlyDelete, "function");
  assert.equal(exposed.api.deleteEntry, undefined);
  await exposed.api.moveToTrash("/workspace/file.txt");
  await exposed.api.permanentlyDelete("/workspace/other.txt");
  assert.deepEqual(calls, [
    ["FileManager:moveToTrash", "/workspace/file.txt"],
    ["FileManager:permanentlyDelete", "/workspace/other.txt"],
  ]);
});

test("Main IPC reaches the mocked native Trash API and permanently deletes only on its own channel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-removal-ipc-"));
  const handlers = new Map();
  const trashCalls = [];
  const mockedElectron = {
    app: {},
    dialog: {},
    shell: {
      async trashItem(targetPath) { trashCalls.push(targetPath); },
    },
    BrowserWindow: class {},
    ipcMain: {
      handle(channel, callback) { handlers.set(channel, callback); },
    },
    safeStorage: {},
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return mockedElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  let FileManager;
  try {
    ({ FileManager } = require("../dist/ts/addon/FileManager.js"));
  } finally {
    Module._load = originalLoad;
  }

  const manager = new FileManager({ watcher: { getWatchedPath: () => root } });
  try {
    manager.handleIPC();
    const file = path.join(root, "to-trash.txt");
    const permanentFile = path.join(root, "permanent.txt");
    await fs.writeFile(file, "keep");
    await fs.writeFile(permanentFile, "remove");
    const trashHandler = handlers.get("FileManager:moveToTrash");
    const permanentHandler = handlers.get("FileManager:permanentlyDelete");
    assert.equal(typeof trashHandler, "function");
    assert.equal(typeof permanentHandler, "function");
    assert.equal(handlers.has("FileManager:delete"), false);

    const trashed = await trashHandler({}, file);
    assert.equal(trashed.success, true);
    assert.equal(trashed.action, "trash");
    assert.deepEqual(trashCalls, [file]);
    assert.equal(await fs.readFile(file, "utf8"), "keep");

    const permanentlyDeleted = await permanentHandler({}, permanentFile);
    assert.equal(permanentlyDeleted.success, true);
    assert.equal(permanentlyDeleted.action, "permanent-delete");
    assert.deepEqual(trashCalls, [file]);
    await assert.rejects(fs.access(permanentFile));

    const rejected = await trashHandler({}, path.join(root, "..", "outside"));
    assert.equal(rejected.code, "OUTSIDE_WORKSPACE");
    assert.deepEqual(trashCalls, [file]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
