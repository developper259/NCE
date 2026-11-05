const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadGlobal } = require("./helpers/runtime");

const LspPositions = loadGlobal("src/js/lsp/LspPositions.js", "LspPositions");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFile(text, { finalNewline = true } = {}) {
  const lines = text.split("\n");
  if (finalNewline && lines[lines.length - 1] === "") lines.pop();
  return {
    lines: lines.map((value) => ({ getText: () => value })),
    hasFinalNewline: finalNewline,
  };
}

test("document text matches the edited buffer and exposes LSP positions", () => {
  assert.equal(LspPositions.documentText(makeFile("a\nb")), "a\nb\n");
  assert.equal(LspPositions.documentText(makeFile("a\nb", { finalNewline: false })), "a\nb");
  assert.deepEqual(plain(LspPositions.position(3, 2)), { line: 2, character: 2 });
  assert.deepEqual(plain(LspPositions.range({ row: 1, column: 0 }, { row: 2, column: 3 })), {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 3 },
  });
  assert.deepEqual(
    plain(LspPositions.editorRange({
      start: { line: 1, character: 4 },
      end: { line: 9, character: 2 },
    }, 3)),
    {
      start: { row: 2, column: 4 },
      end: { row: 3, column: 2 },
    },
  );
});

test("edit payloads produce minimal incremental changes", () => {
  const file = makeFile("const value = 1;\nnext");
  assert.deepEqual(plain(LspPositions.changeForEdit(file, {
    beforeRow: 1,
    beforeColumn: 6,
    beforeText: "value",
    afterText: "answer",
  })), [{
    range: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 },
    },
    text: "answer",
  }]);

  assert.deepEqual(plain(LspPositions.changeForEdit(file, {
    beforeRow: 1,
    beforeColumn: 0,
    beforeText: "a\nb\nc",
    afterText: "x",
  })), [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 2, character: 1 },
    },
    text: "x",
  }]);

  assert.deepEqual(plain(LspPositions.changeForEdit(file, {
    batch: true,
    beforeText: "ignored",
    afterText: "ignored",
  })), [{ text: "const value = 1;\nnext\n" }]);
});

test("word ranges respect Unicode letters and punctuation", () => {
  assert.deepEqual(plain(LspPositions.wordRangeAt("const café = 1", 9)), {
    start: 6,
    end: 10,
    text: "café",
  });
  assert.equal(LspPositions.isWordCharacter("é"), true);
  assert.equal(LspPositions.isWordCharacter("."), false);
  assert.deepEqual(plain(LspPositions.wordRangeAt("value.", 4)), {
    start: 0,
    end: 5,
    text: "value",
  });
});

test("renderer applies workspace resource operations through file APIs", async () => {
  const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController", { NCEPath });
  const calls = [];
  const controller = Object.create(LspController.prototype);
  controller.notify = (message, level) => calls.push(["notify", level, message]);
  controller.editor = {
    api: {
      async createFile(...args) { calls.push(["create", ...args]); return { success: true }; },
      async renameEntry(...args) { calls.push(["rename", ...args]); return { success: true }; },
      async moveToTrash(...args) { calls.push(["delete", ...args]); return { success: true }; },
    },
    tabManager: {
      async updateFilePath(...args) { calls.push(["rename-tab", ...args]); },
      markFileAsDeleted(...args) { calls.push(["delete-tab", ...args]); },
    },
  };
  assert.equal(await controller.applyResourceOperations({
    resources: [
      { kind: "create", path: "/ws/created.ts", uri: "file:///ws/created.ts" },
      { kind: "rename", path: "/ws/renamed.ts", uri: "file:///ws/renamed.ts", oldPath: "/ws/main.ts", oldUri: "file:///ws/main.ts" },
      { kind: "delete", path: "/ws/old.ts", uri: "file:///ws/old.ts" },
    ],
  }), true);
  assert.deepEqual(plain(calls), [
    ["create", "/ws", "created.ts", "", false],
    ["rename", "/ws/main.ts", "/ws/renamed.ts"],
    ["rename-tab", "/ws/main.ts", "/ws/renamed.ts"],
    ["delete", "/ws/old.ts"],
    ["delete-tab", "/ws/old.ts"],
  ]);
  controller.editor.api.createFile = async () => ({
    success: false,
    code: "PERMISSION_DENIED",
    error: "denied",
  });
  assert.equal(await controller.applyResourceOperations({
    resources: [{ kind: "create", path: "/ws/blocked.ts", uri: "file:///ws/blocked.ts" }],
  }), false);
  assert.deepEqual(calls.at(-1), ["notify", "error", "denied"]);
});

test("renderer derives completion and signature trigger characters from session status", () => {
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController");
  const controller = Object.create(LspController.prototype);
  controller.status = {
    sessions: [
      {
        state: "ready",
        capabilities: {
          completionTriggerCharacters: [".", "<"],
          signatureHelpTriggerCharacters: ["(", ","],
        },
      },
      {
        state: "failed",
        capabilities: {
          completionTriggerCharacters: ["ignored"],
          signatureHelpTriggerCharacters: ["ignored"],
        },
      },
    ],
  };
  assert.deepEqual(plain(controller.getTriggerCharacters("completion")), [".", "<"]);
  assert.deepEqual(plain(controller.getTriggerCharacters("signature")), ["(", ","]);
  controller.status = { sessions: [] };
  assert.deepEqual(plain(controller.getTriggerCharacters("completion")), ["."]);
});

test("typed trigger characters dispatch without throwing on ready sessions", () => {
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController");
  const file = { id: 1, path: "/ws/main.ts", lines: makeFile("main").lines };
  const scheduled = [];
  const controller = Object.create(LspController.prototype);
  controller.status = {
    sessions: [{
      state: "ready",
      capabilities: {
        completionTriggerCharacters: ["."],
        signatureHelpTriggerCharacters: ["("],
      },
    }],
  };
  controller.editor = { tabManager: { activeFile: file } };
  controller.documents = new Map([[file.id, { path: file.path }]]);
  controller.completionWidget = { isVisible: false };
  controller.queueChange = () => {};
  controller.scheduleAutoCompletion = (_file, character) => scheduled.push(["completion", character]);
  controller.scheduleSignatureHelp = () => scheduled.push(["signature"]);
  controller.hideHover = () => {};
  controller.handleChange({ afterText: ".", beforeText: "" });
  controller.handleChange({ afterText: "(", beforeText: "" });
  controller.handleChange({ afterText: "x", beforeText: "" });
  assert.deepEqual(scheduled, [["completion", "."], ["signature"]]);
});

test("workspace edits wait for file loading and skip identical text", async () => {
  const LspPositions = loadGlobal("src/js/lsp/LspPositions.js", "LspPositions");
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController", { LspPositions });
  const events = [];
  const file = {
    id: 1,
    path: "/ws/main.ts",
    lines: ["const value = 1;", ""].map((text) => ({ getText: () => text })),
    loadingState: { status: "loading" },
  };
  const editor = {
    tabManager: {
      activeFile: null,
      tabs: [],
      get files() {
        return this.tabs;
      },
      async openFileWithPath() {
        events.push("open");
        editor.tabManager.tabs.push(file);
        return file;
      },
      async setFocusTab(target) {
        events.push("focus");
        editor.tabManager.activeFile = target;
      },
    },
    fileLoader: {
      async waitForFileLoaded(target) {
        events.push(["loaded", target.loadingState?.status]);
        target.loadingState = { status: "loaded" };
      },
    },
    writerController: {
      applyRangeEdit(start, end, text, options) {
        events.push(["edit", start.column, end.column, text, options.source]);
        const current = file.lines[start.row - 1].getText();
        const next = current.slice(0, start.column) + text + current.slice(end.column);
        file.lines[start.row - 1] = { getText: () => next };
        return { row: start.row, column: start.column + text.length };
      },
    },
  };
  const controller = Object.create(LspController.prototype);
  controller.editor = editor;
  controller.documents = new Map();
  controller.editQueue = Promise.resolve(true);
  controller.notify = (message, level) => events.push(["notify", level, message]);
  assert.equal(await controller.applyWorkspaceEditNow({
    files: [{
      path: file.path,
      edits: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 16 } },
        newText: "const value = 1;",
      }],
    }],
  }), true);
  assert.deepEqual(events, [
    "open",
    "focus",
    ["loaded", "loading"],
  ]);
  assert.equal(await controller.applyWorkspaceEditNow({
    files: [{
      path: file.path,
      edits: [{
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        newText: "answer",
      }],
    }],
  }), true);
  assert.deepEqual(events.slice(-2), [
    ["loaded", "loaded"],
    ["edit", 6, 11, "answer", "lsp.edit"],
  ]);
  assert.equal(file.lines[0].getText(), "const answer = 1;");
});

test("renderer bundles and preload expose the LSP integration", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "src/js/main/renderer-scripts.json"),
    "utf8",
  ));
  for (const script of [
    "js/lsp/LspPositions.js",
    "js/lsp/LspPopover.js",
    "js/lsp/LspCompletionWidget.js",
    "js/lsp/ProblemsPanel.js",
    "js/lsp/LspController.js",
  ]) {
    assert.ok(manifest.includes(script), `${script} is bundled`);
    assert.ok(
      manifest.indexOf(script) < manifest.indexOf("js/main/Editor.js"),
      `${script} loads before the editor`,
    );
  }
  const preload = fs.readFileSync(
    path.join(__dirname, "..", "src/js/main/Preload.js"),
    "utf8",
  );
  for (const channel of [
    "Lsp:status", "Lsp:openDocument", "Lsp:changeDocument", "Lsp:saveDocument",
    "Lsp:closeDocument", "Lsp:completion", "Lsp:hover", "Lsp:definition",
    "Lsp:references", "Lsp:rename", "Lsp:codeActions", "Lsp:format",
    "Lsp:documentSymbols", "Lsp:workspaceSymbols", "Lsp:signatureHelp",
    "Lsp:restartServer", "Lsp:resolveCompletion", "Lsp:applyEditResult",
  ]) assert.match(preload, new RegExp(`"${channel}"`), `preload exposes ${channel}`);
  assert.match(preload, /ipcRenderer\.removeListener\("Lsp:diagnostics"/);
  assert.match(preload, /ipcRenderer\.removeListener\("Lsp:status"/);
  assert.match(preload, /ipcRenderer\.removeListener\("Lsp:applyEditRequest"/);
  assert.match(preload, /ipcRenderer\.removeListener\("Lsp:progress"/);
  assert.match(preload, /ipcRenderer\.removeListener\("Lsp:message"/);
  const editor = fs.readFileSync(
    path.join(__dirname, "..", "src/js/main/Editor.js"),
    "utf8",
  );
  assert.match(editor, /new LspController\(this\)/);
  assert.match(editor, /lspController\?\.destroy/);
  const lineController = fs.readFileSync(
    path.join(__dirname, "..", "src/js/controller/LineController.js"),
    "utf8",
  );
  assert.match(lineController, /diagnosticsOutputFast/);
  assert.match(lineController, /refreshDiagnosticsOverlay/);
});

test("completion opens the document before the first request", async () => {
  const LspPositions = loadGlobal("src/js/lsp/LspPositions.js", "LspPositions");
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController", { LspPositions });
  const file = {
    id: 7,
    path: "/ws/main.ts",
    row: 1,
    column: 3,
    editVersion: 0,
    lines: makeFile("cons").lines,
  };
  let shown = null;
  let completionPath = null;
  const controller = Object.create(LspController.prototype);
  controller.editor = { tabManager: { activeFile: file }, cD: null };
  controller.api = {
    async completion(payload) {
      completionPath = payload.path;
      return { success: true, items: [{ label: "console" }] };
    },
  };
  controller.documents = new Map();
  controller.ensureDocument = async (target) => {
    controller.documents.set(target.id, { path: target.path });
  };
  controller.requestToken = 0;
  controller.completionWidget = { show: (options) => { shown = options; } };
  controller.notify = () => {};

  const result = await controller.requestCompletion(1);

  assert.equal(result.success, true);
  assert.equal(completionPath, "/ws/main.ts");
  assert.equal(shown.items[0].label, "console");
  assert.equal(shown.session.file, file);
});

test("quick panel ownership pauses completion key handling", () => {
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController");
  const controller = Object.create(LspController.prototype);
  let hidden = 0;
  let handled = 0;
  controller.completionWidget = {
    isVisible: true,
    hide() { hidden += 1; },
    handleKeyDown() { handled += 1; return true; },
  };
  controller.hoverPopover = { isVisible: false };
  controller.signaturePopover = { isVisible: false };
  controller.editor = { quickPanel: { isOpen: () => true } };
  controller.handleKeyDown({ key: "ArrowDown", preventDefault() {}, stopPropagation() {} });
  assert.equal(hidden, 1);
  assert.equal(handled, 0);

  controller.editor.quickPanel = { isOpen: () => false };
  controller.handleKeyDown({ key: "ArrowDown", preventDefault() {}, stopPropagation() {} });
  assert.equal(handled, 1);
});

test("empty completion opens the suggestion menu without notifying", async () => {
  const LspPositions = loadGlobal("src/js/lsp/LspPositions.js", "LspPositions");
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController", { LspPositions });
  const file = {
    id: 8,
    path: "/ws/main.ts",
    row: 1,
    column: 0,
    editVersion: 0,
    lines: makeFile("").lines,
  };
  let shown = null;
  const notifications = [];
  const controller = Object.create(LspController.prototype);
  controller.editor = { tabManager: { activeFile: file }, cD: null };
  controller.api = { completion: async () => ({ success: true, items: [] }) };
  controller.documents = new Map([[file.id, { path: file.path }]]);
  controller.requestToken = 0;
  controller.completionWidget = { show: (options) => { shown = options; }, isVisible: true };
  controller.notify = (message, level) => notifications.push([level, message]);

  const result = await controller.requestCompletion(1);

  assert.equal(result.success, true);
  assert.equal(shown.items.length, 0);
  assert.equal(shown.session.record.path, file.path);
  assert.deepEqual(notifications, []);
});

test("empty completion leaves editor keys untouched", () => {
  const LspCompletionWidget = loadGlobal("src/js/lsp/LspCompletionWidget.js", "LspCompletionWidget");
  const widget = Object.create(LspCompletionWidget.prototype);
  widget.element = { hidden: false };
  widget.visibleItems = [];
  let hidden = 0;
  widget.hide = () => { hidden += 1; };
  const event = () => ({ preventDefault() {}, stopPropagation() {} });

  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Tab"]) {
    assert.equal(widget.handleKeyDown({ key, ...event() }), false, `${key} falls through`);
  }
  assert.equal(widget.handleKeyDown({ key: "Escape", ...event() }), true);
  assert.equal(hidden, 1);
});

async function applyCompletionEdits(text, column, item, resolvedItem = null) {
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController", { LspPositions });
  const file = {
    id: 9,
    path: "/ws/main.ts",
    row: 1,
    column,
    editVersion: 0,
    lines: makeFile(text).lines,
  };
  const record = { path: file.path };
  const edits = [];
  const controller = Object.create(LspController.prototype);
  controller.editor = {
    tabManager: { activeFile: file },
    writerController: {
      applyRangeEdit(start, end, value, options) {
        edits.push({ start, end, text: value, options });
      },
    },
  };
  controller.documents = new Map([[file.id, record]]);
  controller.api = resolvedItem
    ? { resolveCompletion: async () => ({ success: true, item: resolvedItem }) }
    : {};
  await controller.applyCompletion(item, { file, record, editVersion: 0 });
  return edits;
}

function applyTextEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((left, right) =>
    right.start.column - left.start.column)) {
    result = result.slice(0, edit.start.column) + edit.text + result.slice(edit.end.column);
  }
  return result;
}

test("member completion keeps the dot when resolve omits the text edit", async () => {
  const edits = await applyCompletionEdits("t.", 2, {
    id: "item-1",
    label: "print",
    source: "typescript-language-server",
    textEdit: {
      range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
      newText: ".print",
    },
  }, {
    label: "print",
    detail: "(method) Test.print(): void",
  });

  assert.equal(applyTextEdits("t.", edits), "t.print");
  assert.deepEqual(plain(edits.map(({ start, end, text }) => [start, end, text])), [[
    { row: 1, column: 1 },
    { row: 1, column: 2 },
    ".print",
  ]]);
});

test("completion fallback inserts after a trigger character", async () => {
  const afterDot = await applyCompletionEdits("t.", 2, {
    label: "print",
    insertText: "print",
    source: "plain-server",
  });
  assert.equal(applyTextEdits("t.", afterDot), "t.print");
  assert.deepEqual(plain(afterDot.map(({ start, end, text }) => [start, end, text])), [[
    { row: 1, column: 2 },
    { row: 1, column: 2 },
    "print",
  ]]);

  const afterPrefix = await applyCompletionEdits("t.pr", 4, {
    label: "print",
    source: "plain-server",
  });
  assert.equal(applyTextEdits("t.pr", afterPrefix), "t.print");
  assert.deepEqual(plain(afterPrefix.map(({ start, end, text }) => [start, end, text])), [[
    { row: 1, column: 2 },
    { row: 1, column: 4 },
    "print",
  ]]);
});

test("completion annotations show a method class or a value type", () => {
  const LspCompletionWidget = loadGlobal("src/js/lsp/LspCompletionWidget.js", "LspCompletionWidget");
  const describe = (item) => LspCompletionWidget.prototype.completionDescription(item);
  assert.equal(describe({ detail: "(method) Greeter.greet(value: string): boolean", kind: 2 }), "Greeter");
  assert.equal(describe({ detail: "Greeter.greet(): void", kind: 2 }), "Greeter");
  assert.equal(describe({ detail: "(method) greet(): void", kind: 2 }), "");
  assert.equal(describe({ detail: "(function) greet(): void", kind: 3 }), "");
  assert.equal(describe({ detail: "(property) Greeter.count: number", kind: 10 }), "number");
  assert.equal(describe({ detail: "const flag: boolean", kind: 6 }), "boolean");
  assert.equal(describe({ detail: "const obj: { a: string; b: number }", kind: 6 }), "object");
  assert.equal(
    describe({ detail: "var AbortController: { new (): AbortController; prototype: AbortController; }", kind: 6 }),
    "AbortController",
  );
  assert.equal(
    describe({ detail: "var Audio: new (src?: string | undefined) => HTMLAudioElement", kind: 6 }),
    "HTMLAudioElement",
  );
  assert.equal(describe({ detail: "var Array: ArrayConstructor", kind: 6 }), "ArrayConstructor");
  assert.equal(describe({ detail: null, kind: 6 }), "");
  assert.equal(describe({}), "");
});

test("completion details resolve only for supporting servers", async () => {
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController");
  const controller = Object.create(LspController.prototype);
  const resolved = [];
  let renders = 0;
  const supported = {
    token: 1,
    items: [
      { id: "a", source: "typescript-language-server" },
      { id: "b", source: "typescript-language-server", detail: "const known: string" },
      { id: "c", source: "plain-server" },
    ],
  };
  const plainOnly = { token: 2, items: [{ id: "d", source: "plain-server" }] };
  controller.api = {
    async resolveCompletion({ id }) {
      resolved.push(id);
      return { success: true, item: { detail: "(method) Greeter.greet(): boolean" } };
    },
  };
  controller.status = {
    sessions: [
      {
        serverId: "typescript-language-server",
        state: "ready",
        capabilities: { completionResolve: true },
      },
      { serverId: "plain-server", state: "ready", capabilities: { completionResolve: false } },
    ],
  };
  controller.completionWidget = { isVisible: true, render: () => { renders += 1; } };
  controller.completionSession = supported;

  await controller.resolveCompletionDetails(supported);

  assert.deepEqual(resolved, ["a"]);
  assert.equal(supported.items[0].detail, "(method) Greeter.greet(): boolean");
  assert.equal(supported.items[1].detail, "const known: string");
  assert.equal(renders, 1);

  resolved.length = 0;
  controller.completionSession = plainOnly;
  await controller.resolveCompletionDetails(plainOnly);
  assert.deepEqual(resolved, []);
  assert.equal(renders, 1);
});

test("hover is requested on demand only", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src/js/lsp/LspController.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /addEventListener\("pointermove"/);
  assert.doesNotMatch(source, /requestHoverAt|handlePointerMove/);
  assert.match(source, /async hover\(\)/);
});

test("definition navigation accepts Windows paths with a different drive-letter case", async () => {
  const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController", {
    NCEPath,
    LspPositions,
  });
  const controller = Object.create(LspController.prototype);
  const file = {
    id: 4,
    path: "C:\\workspace\\test.ts",
    lines: [
      { getText: () => "class Test {" },
      { getText: () => "  constructor(self, jsp) {" },
      { getText: () => "    self.jsp = jsp;" },
      { getText: () => "  }" },
      { getText: () => "}" },
    ],
  };
  const notifications = [];
  const positions = [];
  let clearedSelections = 0;
  controller.editor = {
    tabManager: {
      activeFile: file,
      openFileWithPath: async () => file,
    },
    cursorController: {
      setCursorPosition(row, column, options) {
        positions.push([row, column, options]);
      },
    },
    selectController: {
      unSelectAll() {
        clearedSelections += 1;
      },
    },
    focusOutput() {},
  };
  controller.documents = new Map([[file.id, { path: file.path }]]);
  controller.notify = (message) => notifications.push(message);

  const navigated = await controller.navigateTo({
    path: "c:\\workspace\\test.ts",
    authorized: true,
    range: {
      start: { line: 1, character: 2 },
      end: { line: 3, character: 3 },
    },
  });

  assert.equal(navigated, true);
  assert.deepEqual(notifications, []);
  assert.equal(clearedSelections, 1);
  assert.deepEqual(plain(positions), [[2, 2, { ensureVisible: true }]]);
});

test("Problems status shows progress without server readiness", () => {
  const LspController = loadGlobal("src/js/lsp/LspController.js", "LspController");
  const controller = Object.create(LspController.prototype);
  const statuses = [];
  controller.problemsPanel = { setServerStatus: (text) => statuses.push(text) };
  controller.status = {
    enabled: true,
    servers: [{ enabled: true, available: false }, { enabled: true, available: true }],
    sessions: [{ state: "ready" }],
  };
  controller.progressByServer = new Map([
    ["typescript-language-server::/ws", { title: "", message: "analysis", percentage: 50 }],
  ]);
  controller.updateProblemsStatus();
  assert.deepEqual(statuses, ["analysis (50%)"]);
  controller.progressByServer.clear();
  controller.updateProblemsStatus();
  assert.deepEqual(statuses, ["analysis (50%)", ""]);
});
