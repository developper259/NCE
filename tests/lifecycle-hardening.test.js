const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadMain } = require("./helpers/main-runtime");

test("a preserved legacy session file is never overwritten and does not block quitting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-session-preserve-"));
  try {
    const corrupt = '{"agent":{"apiKeys":{"provider":"recoverable-secret"},';
    await fs.writeFile(path.join(root, "window-sessions.json"), corrupt);
    const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
    const store = new WindowSessionStore(root, process.platform);
    await store.initialize();
    const session = store.create({});
    await store.saveRendererState(session.id, JSON.stringify({
      version: 2,
      lastWorkspace: "/definitely/not/the/workspace",
      value: "new",
    }));
    assert.equal(
      await fs.readFile(path.join(root, "window-sessions.json"), "utf8"),
      corrupt,
    );
    assert.equal(await store.flush(), true);
    assert.equal(store.get(session.id).workspacePath, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Watcher drops file events when its WebContents is already destroyed", () => {
  const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
    electron: { BrowserWindow: class {}, ipcMain: { handle() {} } },
  });
  const window = {
    on() {},
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => true,
    webContents: {
      isDestroyed: () => true,
      send() { throw new Error("send must not run"); },
    },
  };
  const watcher = new Watcher(window, { handle() {} }, {});
  watcher.queueEvent("change", "/tmp/file.txt", "/tmp");
  assert.doesNotThrow(() => watcher.flushEvents());
});
