const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createAgent } = require("./helpers/agent-runtime");

const source = fs.readFileSync(path.join(__dirname, "../src/js/sidebar/Agent.Sidebar.js"), "utf8");
const context = { Sidebar: class {} };
vm.runInNewContext(`${source}\nglobalThis.AgentSidebar = AgentSidebar;`, context);

function fixture() {
  const session = { id: "session", runId: 1, isGenerating: true, segments: [], messages: [] };
  const sidebar = Object.create(context.AgentSidebar.prototype);
  sidebar.getSession = () => session;
  sidebar.editor = { tabManager: { activeFile: null } };
  sidebar.messagesElement = null;
  sidebar.activityItems = new Map();
  sidebar.activityElements = new WeakMap();
  sidebar.activityItemElements = new Map();
  sidebar.pendingActivityItems = new Map();
  sidebar.deferredReadItems = new Map();
  sidebar._activityItemCounter = 0;
  const callbackContext = { sessionId: session.id, runId: 1, toolCallId: "read-1" };
  const read = (args, payload, id = "read-1") => {
    const current = { ...callbackContext, toolCallId: id };
    sidebar.handleToolStart("read_file", args, current);
    const result = payload.success === false ? payload : { success: true, result: payload };
    sidebar.handleToolEnd("read_file", result, current, result);
  };
  const cards = () => session.segments.flatMap((segment) => segment.items || []);
  return { sidebar, session, read, cards };
}

function testActivityFixture() {
  const { sidebar, session, cards } = fixture();
  const start = (toolName, args, id) => {
    const context = { sessionId: session.id, runId: 1, toolCallId: id };
    sidebar.handleToolStart(toolName, args, context);
    return context;
  };
  const end = (toolName, result, context) =>
    sidebar.handleToolEnd(toolName, result, context, result);
  return { sidebar, session, cards, start, end };
}

test("run_tests FAILED is an error activity, not a successful check", () => {
  const { sidebar, cards, start, end, session } = testActivityFixture();
  const context = start("run_tests", { path: "pythagore.py" }, "tests-1");
  end("run_tests", {
    success: true,
    result: {
      status: "FAILED",
      validation: { attempted: true, passed: false },
      runner: { name: "python-script" },
      target: "pythagore.py",
      exitCode: 1,
    },
  }, context);
  assert.equal(cards()[0].status, "error");
  assert.notEqual(sidebar.getActivityIcon(cards()[0]), "✓");
  assert.equal(session.segments[0].hasErrors, true);
  assert.match(cards()[0].title, /Tests failed/i);
});

test("run_tests PASSED remains a successful check", () => {
  const { sidebar, cards, start, end } = testActivityFixture();
  const context = start("run_tests", { path: "pythagore.py" }, "tests-2");
  end("run_tests", {
    success: true,
    result: {
      status: "PASSED",
      validation: { attempted: true, passed: true },
      runner: { name: "python-script" },
      target: "pythagore.py",
    },
  }, context);
  assert.equal(cards()[0].status, "success");
  assert.equal(sidebar.getActivityIcon(cards()[0]), "✓");
});

test("run_tests INVALID_TARGET never displays a success icon", () => {
  const { sidebar, cards, start, end } = testActivityFixture();
  const context = start("run_tests", { path: "missing.py" }, "tests-3");
  end("run_tests", {
    success: true,
    result: { status: "INVALID_TARGET", target: "missing.py" },
  }, context);
  assert.notEqual(cards()[0].status, "success");
  assert.notEqual(sidebar.getActivityIcon(cards()[0]), "✓");
});

test("read timeline shows delivered lines instead of requested lines", () => {
  const { sidebar, session, cards } = fixture();
  const args = { path: "snake-game.html", startLine: 1, endLine: 140 };
  sidebar.handleToolStart("read_file", args, { sessionId: "session", runId: 1, toolCallId: "read-1" });
  assert.equal(session.segments.length, 0);
  const payload = { success: true, path: "snake-game.html", content: "content",
    requestedRange: { startLine: 1, endLine: 140 },
    deliveredRange: { startLine: 1, endLine: 87 },
    contentStartLine: 1, contentEndLine: 87, startLine: 1, endLine: 140 };
  sidebar.handleToolEnd("read_file", { success: true, result: payload },
    { sessionId: "session", runId: 1, toolCallId: "read-1" });
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].detail, "lines 1–87");
});

test("already known and repeated redundant reads create no cards or empty groups", () => {
  const { read, cards, session } = fixture();
  read({ path: "snake-game.html", startLine: 35, endLine: 45 },
    { success: true, alreadyKnown: true, noNewInformation: true }, "known");
  read({ path: "snake-game.html", startLine: 35, endLine: 45 },
    { success: true, repeatedRedundantAction: true, noNewInformation: true }, "repeat");
  assert.equal(cards().length, 0);
  assert.equal(session.segments.length, 0);
});

test("hidden redundant reads keep useful reasoning without an empty activity group", () => {
  const { sidebar, read, session, cards } = fixture();
  sidebar.handleAgentReasoning("I should inspect the missing range.",
    { sessionId: "session", runId: 1 });
  read({ path: "snake-game.html", startLine: 35, endLine: 45 },
    { success: true, alreadyKnown: true, noNewInformation: true }, "known");
  assert.equal(cards().length, 0);
  assert.deepEqual(session.segments.map((segment) => segment.type), ["reasoning"]);
  assert.equal(session.segments[0].content, "I should inspect the missing range.");
});

test("restored cache content remains visible with its actual range", () => {
  const { read, cards } = fixture();
  read({ path: "snake-game.html", startLine: 1, endLine: 140 },
    { success: true, path: "snake-game.html", content: "restored",
      alreadyKnown: true, restoredFromCache: true, noNewInformation: false,
      contentStartLine: 35, contentEndLine: 45, startLine: 35, endLine: 45 }, "restored");
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].detail, "lines 35–45");
});

test("real read errors remain visible", () => {
  const { read, cards } = fixture();
  read({ path: "missing.html" },
    { success: false, error: { code: "FILE_NOT_FOUND", message: "File not found" } }, "error");
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].status, "error");
  assert.match(cards()[0].title, /Failed to read missing.html/);
});

test("paginated reads show two delivered ranges and hide the duplicate", () => {
  const { read, cards } = fixture();
  read({ path: "snake-game.html", startLine: 1, endLine: 140 },
    { success: true, path: "snake-game.html", content: "first", contentStartLine: 1, contentEndLine: 87 }, "first");
  read({ path: "snake-game.html", startLine: 88, endLine: 140 },
    { success: true, path: "snake-game.html", content: "second", contentStartLine: 88, contentEndLine: 140 }, "second");
  read({ path: "snake-game.html", startLine: 35, endLine: 45 },
    { success: true, alreadyKnown: true, noNewInformation: true }, "duplicate");
  assert.deepEqual(cards().map((item) => item.detail), ["lines 1–87", "lines 88–140"]);
});

test("partial long-line reads show delivered character columns", () => {
  const { read, cards } = fixture();
  read({ path: "long.txt", startLine: 1, endLine: 1 },
    { success: true, path: "long.txt", content: "a".repeat(4000),
      contentStartLine: 1, contentEndLine: 1, contentStartColumn: 0,
      contentEndColumn: 4000, lineTruncated: true, nextStartColumn: 4000 }, "partial");
  assert.equal(cards()[0].detail, "line 1, chars 1–4000");
});

test("read result normalizes requested and delivered ranges after output limiting", () => {
  const agent = createAgent({ api: {}, tabManager: { activeFile: null } });
  const limited = agent.toolExecutor.limitResult("read_file", {
    success: true, path: "snake-game.html", requestedStartLine: 1,
    requestedEndLine: 140, contentStartLine: 1, contentEndLine: 140,
    startLine: 1, endLine: 140, content: `${"a".repeat(50)}\n`.repeat(140), totalLines: 140,
  });
  assert.equal(limited.requestedRange.endLine, 140);
  assert.equal(limited.deliveredRange.endLine, limited.contentEndLine);
  assert.ok(limited.deliveredRange.endLine < 140);
});
