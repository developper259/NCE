const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeClassList {
  values = new Set();
  add(...values) { for (const value of values) this.values.add(value); }
  remove(...values) { for (const value of values) this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(rect = {
    left: 0,
    top: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
  }, onLayoutRead = () => {}) {
    this.nodeType = 1;
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = new Map();
    this.textContent = "";
    this.removed = false;
    this.rect = rect;
    this.onLayoutRead = onLayoutRead;
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelector(selector) {
    const name = selector.slice(1);
    for (const child of this.children) {
      if (child.className === name) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
  remove() { this.removed = true; }
  getBoundingClientRect() {
    this.onLayoutRead();
    return this.rect;
  }
}

function createControllerHarness() {
  const listeners = new Map();
  const timers = new Map();
  const clearedTimers = [];
  const layout = { reads: 0 };
  let nextTimerId = 0;
  const createLayoutElement = (className, rect) => {
    const element = new FakeElement(rect, () => { layout.reads += 1; });
    element.className = className;
    return element;
  };
  const fakeWindow = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      const callbacks = listeners.get(name);
      if (!callbacks) return;
      callbacks.delete(callback);
      if (callbacks.size === 0) listeners.delete(name);
    },
  };
  const fakeDocument = {
    createElement: () => new FakeElement(),
    documentElement: { contains: (candidate) => candidate?.nodeType === 1 },
  };
  const Controller = loadGlobal(
    "src/js/addon/ExternalFileDropController.js",
    "ExternalFileDropController",
    {
      window: fakeWindow,
      document: fakeDocument,
      setTimeout(callback, delay) {
        const id = ++nextTimerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        if (id !== null) clearedTimers.push(id);
        timers.delete(id);
      },
    },
  );
  const openedDrops = [];
  const acknowledgements = [];
  const progressReports = [];
  const mainSection = createLayoutElement("main-section", {
    left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800,
  });
  const sidebarLeft = createLayoutElement("sidebar-left", {
    left: 49, top: 0, right: 280, bottom: 780, width: 231, height: 780,
  });
  const fileManagerOBJ = createLayoutElement("file-manager", {
    left: 49, top: 0, right: 1200, bottom: 38, width: 1151, height: 38,
  });
  const editorOBJ = createLayoutElement("editor", {
    left: 49, top: 38, right: 1200, bottom: 780, width: 1151, height: 742,
  });
  const sidebarRight = createLayoutElement("sidebar-right", {
    left: 1000, top: 0, right: 1200, bottom: 780, width: 200, height: 780,
  });
  mainSection.append(sidebarLeft, fileManagerOBJ, editorOBJ, sidebarRight);
  const editor = {
    mainSection,
    editorOBJ,
    fileManagerOBJ,
    api: {
      getPathForDroppedFile: (file) => file.path,
      openDroppedFiles: async (paths) => {
        openedDrops.push(paths);
        return { success: false, failures: [{ path: "", message: "Path unavailable." }] };
      },
      acknowledgeExternalOpen: async (...args) => acknowledgements.push(args),
      reportExternalOpenProgress: async (...args) => progressReports.push(args),
    },
    tabManager: { openFileWithPath: async () => ({}) },
  };
  return {
    controller: new Controller(editor),
    editor,
    layout,
    openedDrops,
    acknowledgements,
    progressReports,
    listeners,
    timers,
    clearedTimers,
  };
}

function makeFileTransfer(files) {
  return {
    types: ["Files"],
    items: files.map((file) => ({ kind: "file", type: file.type || "text/plain" })),
    files,
  };
}

test("a mixed drop sends readable paths and invalid items through the same result channel", async () => {
  const harness = createControllerHarness();
  const { controller, editor, openedDrops } = harness;
  const event = {
    dataTransfer: makeFileTransfer([
      { path: "/tmp/valid.js" },
      { path: "" },
    ]),
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };

  controller.handleDrop(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(JSON.stringify(openedDrops), JSON.stringify([["/tmp/valid.js", ""]]));
  assert.equal(controller.state, "error");
  assert.match(controller.overlay.querySelector(".nce-external-drop-title").textContent, /Could not open/);
  assert.equal(editor.mainSection.children.at(-1), controller.overlay);
  controller.destroy();
});

test("dragover avoids layout reads and an expired error timer cannot hide a new drag", () => {
  const harness = createControllerHarness();
  const { controller, timers, clearedTimers, listeners, layout } = harness;
  const transfer = makeFileTransfer([{ path: "/tmp/a.js" }]);
  controller.showStatus("Old failure");
  const staleTimer = controller.statusTimer;
  const staleCallback = timers.get(staleTimer).callback;

  controller.handleDragEnter({ dataTransfer: transfer });
  const layoutReadsAfterDragEnter = layout.reads;
  const dragOver = { dataTransfer: transfer, preventDefault() {} };
  for (let index = 0; index < 1000; index++) controller.handleDragOver(dragOver);

  assert.equal(layout.reads, layoutReadsAfterDragEnter, "dragover events do not read layout");
  assert.equal(controller.state, "dragging");
  assert.ok(clearedTimers.includes(staleTimer));
  assert.equal(controller.overlay.classList.contains("nce-external-drop-visible"), true);
  assert.equal(controller.overlay.classList.contains("nce-external-drop-result"), false);
  assert.equal(controller.overlay.querySelector(".nce-external-drop-title").textContent, "Drop files to open");
  staleCallback();
  assert.equal(controller.state, "dragging", "a callback already queued before clear is ignored by its generation");
  assert.equal(controller.overlay.classList.contains("nce-external-drop-visible"), true);

  controller.destroy();
  assert.equal(controller.state, "hidden");
  assert.equal(listeners.size, 0);
});

test("dragleave keeps the overlay while the pointer moves within the document", () => {
  const { controller } = createControllerHarness();
  const transfer = makeFileTransfer([{ path: "/tmp/a.js" }]);
  controller.handleDragEnter({ dataTransfer: transfer });
  assert.equal(controller.state, "dragging");

  controller.handleDragLeave({ relatedTarget: new FakeElement() });
  assert.equal(controller.state, "dragging", "moving between document elements is not leaving the window");

  controller.handleDragLeave({ relatedTarget: { nodeType: 3 } });
  assert.equal(controller.state, "hidden", "leaving the document hides the overlay");
  controller.destroy();
});

test("a file-typed drop with no files clears the overlay without consuming the event", () => {
  const { controller } = createControllerHarness();
  const transfer = { types: ["Files"], items: [], files: [] };
  controller.handleDragEnter({ dataTransfer: transfer });
  assert.equal(controller.state, "dragging");

  const event = {
    dataTransfer: transfer,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  controller.handleDrop(event);

  assert.equal(controller.state, "hidden");
  assert.equal(controller.overlay.classList.contains("nce-external-drop-visible"), false);
  assert.equal(event.prevented, undefined, "empty file transfers keep their existing handlers");
  assert.equal(event.stopped, undefined);
  controller.destroy();
});

test("external-open acknowledgements carry the current delivery attempt and report progress", async () => {
  const harness = createControllerHarness();
  const { controller, editor, acknowledgements, progressReports } = harness;
  const opened = [];
  editor.tabManager.openFileWithPath = async (filePath) => { opened.push(filePath); return {}; };

  await controller.openExternalFiles({
    requestId: "delivery-1",
    attempt: 2,
    paths: ["/tmp/one.js", "/tmp/two.js"],
  });

  assert.deepEqual(opened, ["/tmp/one.js", "/tmp/two.js"]);
  assert.deepEqual(progressReports, [
    ["delivery-1", 2],
    ["delivery-1", 2],
  ], "each completed file keeps the main-process acknowledgement deadline alive");
  assert.equal(JSON.stringify(acknowledgements), JSON.stringify([["delivery-1", 2, {
    openedPaths: ["/tmp/one.js", "/tmp/two.js"],
    failures: [],
  }]]));
  controller.destroy();
});

test("invalid external paths still report progress before the final acknowledgement", async () => {
  const harness = createControllerHarness();
  const { controller, acknowledgements, progressReports } = harness;

  await controller.openExternalFiles({
    requestId: "delivery-invalid",
    attempt: 1,
    paths: [42, "/tmp/valid.js"],
  });

  assert.deepEqual(progressReports, [
    ["delivery-invalid", 1],
    ["delivery-invalid", 1],
  ]);
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0][2].failures[0].path, "");
  controller.destroy();
});

test("drop status reports mixed targets and distinguishes new windows from reused folders", () => {
  const { controller } = createControllerHarness();
  const title = controller.overlay.querySelector(".nce-external-drop-title");

  controller.showDropResult({
    openedFiles: 2,
    openedFolders: 1,
    focusedFolders: 1,
    failures: [],
  });
  assert.equal(
    title.textContent,
    "2 files opened in this window. 1 folder opened in new window. 1 folder focused in an existing window.",
  );

  controller.showDropResult({
    openedFiles: 0,
    openedFolders: 0,
    focusedFolders: 1,
    failures: [],
  });
  assert.equal(title.textContent, "1 folder focused in an existing window.");
  controller.destroy();
});

test("renderer deliveries stay ordered across retries of the same file", async () => {
  const harness = createControllerHarness();
  const { controller, editor, acknowledgements } = harness;
  const opened = [];
  let finishFirstOpen;
  editor.tabManager.openFileWithPath = async (filePath) => {
    opened.push(filePath);
    if (opened.length === 1) await new Promise((resolve) => { finishFirstOpen = resolve; });
    return {};
  };

  controller.onExternalFiles({ requestId: "retry", attempt: 1, paths: ["/tmp/retried.js"] });
  controller.onExternalFiles({ requestId: "retry", attempt: 2, paths: ["/tmp/retried.js"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["/tmp/retried.js"], "a retry waits for the current renderer open to finish");
  assert.equal(acknowledgements.length, 0);

  finishFirstOpen();
  await controller.externalFileOpenQueue;
  assert.deepEqual(opened, ["/tmp/retried.js", "/tmp/retried.js"]);
  assert.deepEqual(acknowledgements.map(([requestId, attempt]) => [requestId, attempt]), [
    ["retry", 1],
    ["retry", 2],
  ]);
  controller.destroy();
});
