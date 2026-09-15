const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgent } = require("./helpers/agent-runtime");

function fixture(files) {
  const editor = {
    api: {
      async getFileContent(paths) {
        return Object.fromEntries(
          paths.map((path) => [
            path,
            files[path.replaceAll("\\", "/").split("/").pop()],
          ]),
        );
      },
    },
    fileExplorer: { rootPath: "/workspace" },
    tabManager: {
      activeFile: null,
      getFileByPath() {
        return null;
      },
    },
  };
  return createAgent(editor);
}

function visible(agent, results) {
  const messages = results.flatMap((result, index) => {
    const id = `read-${index}`;
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: result.path }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: id,
        content: JSON.stringify({ success: true, result }),
      },
    ];
  });
  agent.contextManager.updateModelFileVisibility(messages);
  return messages;
}

test("read stops at full-line boundaries and never caches a trailing partial line", async () => {
  const content = Array.from(
    { length: 20 },
    (_, index) => `${index + 1}:${"x".repeat(index < 14 ? 275 : 350)}`,
  ).join("\n");
  const agent = fixture({ "file.js": content });
  const first = await agent.readFile("file.js", { startLine: 1, endLine: 20 });
  assert.equal(first.success, true);
  assert.equal(first.contentEndLine, 14);
  assert.equal(first.completeLineRange.endLine, 14);
  assert.equal(first.nextStartLine, 15);
  assert.equal(first.nextStartColumn, 0);
  const entry = [...agent.fileKnowledge.files.values()][0];
  assert.equal(entry.contentLines.has(14), true);
  assert.equal(entry.contentLines.has(15), false);
  visible(agent, [first]);
  const next = await agent.readFile("file.js", { startLine: 1, endLine: 20 });
  assert.equal(next.contentStartLine, 15);
  assert.match(next.content, /^15:/);
});

test("a 50000-char line tracks columns and becomes complete only after all segments", async () => {
  const content = "0123456789".repeat(5000);
  const agent = fixture({ "min.js": content });
  const pages = [];
  const first = await agent.readFile("min.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 0,
  });
  pages.push(first);
  let entry = [...agent.fileKnowledge.files.values()][0];
  assert.equal(entry.ranges.length, 0);
  assert.equal(entry.contentLines.has(1), false);
  assert.equal(entry.partialSegments[0].endColumn, 4000);
  visible(agent, pages);
  const repeated = await agent.readFile("min.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 0,
  });
  assert.equal(repeated.noNewInformation, true);
  assert.equal(Object.hasOwn(repeated, "content"), false);
  let column = 4000;
  while (column < content.length) {
    const page = await agent.readFile("min.js", {
      startLine: 1,
      endLine: 1,
      startColumn: column,
    });
    assert.equal(page.contentStartColumn, column);
    assert.equal(page.partialSegment.startColumn, column);
    pages.push(page);
    column = page.contentEndColumn;
    visible(agent, pages);
  }
  entry = [...agent.fileKnowledge.files.values()][0];
  assert.equal(entry.contentLines.get(1), content);
  assert.equal(
    JSON.stringify(
      entry.ranges.map((range) => [range.startLine, range.endLine]),
    ),
    "[[1,1]]",
  );
  assert.equal(
    agent.fileKnowledge.isModelRangeVisible(entry.path, entry.revision, {
      startLine: 1,
      endLine: 1,
    }),
    true,
  );
});

test("executeToolCall preserves complete long-line pagination after result limiting", async () => {
  const original = "0123456789".repeat(5000);
  const agent = fixture({ "min.js": original });
  const modelMessages = [];
  let startColumn = 0;
  let rebuilt = "";
  let pageCount = 0;
  while (true) {
    const id = `read-tool-${pageCount}`;
    const call = {
      id,
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "min.js",
          startLine: 1,
          endLine: 1,
          startColumn,
        }),
      },
    };
    const executed = await agent.executeToolCall(call, { runId: agent.runId });
    assert.equal(executed.success, true);
    const page = executed.result;
    assert.ok(
      page.content.length <= agent.toolLimits.read_file.outputCharacters,
    );
    rebuilt += page.content;
    modelMessages.push(
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: id, content: JSON.stringify(executed) },
    );
    agent.contextManager.updateModelFileVisibility(modelMessages);
    pageCount += 1;
    if (pageCount === 1) {
      assert.equal(page.nextStartLine, 1);
      assert.equal(
        page.nextStartColumn,
        agent.toolLimits.read_file.outputCharacters,
      );
    }
    if (!page.hasMore) {
      assert.equal(page.nextStartLine, null);
      assert.equal(page.nextStartColumn, null);
      break;
    }
    startColumn = page.nextStartColumn;
    assert.equal(page.nextStartLine, 1);
  }
  assert.equal(rebuilt, original);
  assert.ok(pageCount > 1);
});

test("executeToolCall read_file hasMore only describes an incomplete request", async () => {
  const original = Array.from(
    { length: 500 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const agent = fixture({ "many.js": original });
  const complete = await agent.executeToolCall({
    id: "subset",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({
        path: "many.js",
        startLine: 1,
        endLine: 10,
      }),
    },
  });
  assert.equal(complete.result.contentEndLine, 10);
  assert.equal(complete.result.hasMore, false);
  assert.equal(complete.result.nextStartLine, null);
  const truncated = await agent.executeToolCall({
    id: "all",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({
        path: "many.js",
        startLine: 1,
        endLine: 500,
      }),
    },
  });
  assert.equal(truncated.result.hasMore, true);
  assert.equal(
    truncated.result.nextStartLine,
    truncated.result.contentEndLine + 1,
  );
});

test("executeToolCall does not create an empty end-of-line partial segment", async () => {
  const agent = fixture({ "lines.js": "abcdef\nghij" });
  const result = await agent.executeToolCall({
    id: "eol",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({
        path: "lines.js",
        startLine: 1,
        endLine: 1,
        startColumn: 6,
      }),
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.result.content, "");
  assert.equal(result.result.hasMore, false);
  assert.equal(result.result.nextStartLine, null);
  const entry = [...agent.fileKnowledge.files.values()][0];
  assert.equal(entry?.partialSegments?.length || 0, 0);
});

test("column overlap starts at the first uncovered visible boundary", async () => {
  const content = "x".repeat(12000);
  const agent = fixture({ "columns.js": content });
  const first = await agent.readFile("columns.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 0,
  });
  visible(agent, [first]);
  const overlap = await agent.readFile("columns.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 2000,
  });
  assert.equal(overlap.contentStartColumn, 4000);

  const second = await agent.readFile("columns.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 4000,
  });
  visible(agent, [first, second]);
  const laterOverlap = await agent.readFile("columns.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 3500,
  });
  assert.equal(laterOverlap.contentStartColumn, 8000);
});

test("column overlap preserves a missing hole and restores hidden runtime content", async () => {
  const content = "x".repeat(12000);
  const agent = fixture({ "columns.js": content });
  const first = await agent.readFile("columns.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 0,
  });
  const second = await agent.readFile("columns.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 4000,
  });
  const path = first.path;
  const revision = first.revision;
  agent.contextManager.updateModelFileVisibility([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "partial-a",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
        {
          id: "partial-b",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "partial-a",
      content: JSON.stringify({
        success: true,
        result: {
          success: true,
          path,
          revision,
          content: "x".repeat(2000),
          contentStartLine: 1,
          partialSegment: {
            line: 1,
            startColumn: 0,
            endColumn: 2000,
            lineLength: content.length,
          },
        },
      }),
    },
    {
      role: "tool",
      tool_call_id: "partial-b",
      content: JSON.stringify({
        success: true,
        result: {
          success: true,
          path,
          revision,
          content: "x".repeat(2000),
          contentStartLine: 1,
          partialSegment: {
            line: 1,
            startColumn: 4000,
            endColumn: 6000,
            lineLength: content.length,
          },
        },
      }),
    },
  ]);
  const restored = await agent.readFile("columns.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 1000,
  });
  assert.equal(restored.restoredFromCache, true);
  assert.equal(restored.contentStartColumn, 2000);
  assert.equal(restored.contentEndColumn, 4000);
});

test("closed-file long-line continuations reuse one source read per revision", async () => {
  const original = "x".repeat(50000);
  let fileReads = 0;
  const editor = {
    api: {
      async getFileContent(paths) {
        fileReads += 1;
        return Object.fromEntries(
          paths.map((path) => [path.split("/").pop(), original]),
        );
      },
    },
    fileExplorer: { rootPath: "/workspace" },
    tabManager: {
      activeFile: null,
      getFileByPath() {
        return null;
      },
    },
  };
  const agent = createAgent(editor);
  let column = 0;
  while (column < original.length) {
    const page = await agent.readFile("min.js", {
      startLine: 1,
      endLine: 1,
      startColumn: column,
    });
    if (!page.hasMore) break;
    column = page.nextStartColumn;
  }
  assert.equal(fileReads, 1);
  agent.fileKnowledge.invalidateFile(
    "/workspace/min.js",
    "changed",
    "external_change",
  );
  await agent.readFile("min.js", { startLine: 1, endLine: 1, startColumn: 0 });
  assert.equal(fileReads, 2);
});

test("tool schemas, runtime limits, and descriptions share the configured values", () => {
  const agent = fixture({ "limits.js": "ok" });
  const limits = agent.toolLimits;
  const read = agent.getTool("read_file");
  const search = agent.getTool("search_code");
  const map = agent.getTool("get_project_map");
  const diff = agent.getTool("get_diff");
  assert.equal(
    read.parameters.properties.path.maxLength,
    limits.common.pathCharacters,
  );
  assert.match(
    read.description,
    new RegExp(String(limits.read_file.outputCharacters)),
  );
  assert.equal(
    search.parameters.properties.query.maxLength,
    limits.search_code.queryCharacters,
  );
  assert.equal(
    search.parameters.properties.limit.maximum,
    limits.search_code.maxResults,
  );
  assert.equal(
    search.parameters.properties.offset.maximum,
    limits.search_code.maxOffset,
  );
  assert.equal(
    map.parameters.properties.maxDepth.maximum,
    limits.get_project_map.maxDepth,
  );
  assert.match(
    diff.description,
    new RegExp(String(limits.get_diff.outputCharacters)),
  );
  assert.equal(
    agent.toolExecutor.getToolOutputLimit("search_code").maxResults,
    limits.search_code.maxResults,
  );
});

test("a cached partial line is restored as a segment, never as a whole line", async () => {
  const agent = fixture({ "min.js": "x".repeat(10000) });
  const first = await agent.readFile("min.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 0,
  });
  visible(agent, [first]);
  agent.contextManager.updateModelFileVisibility([]);
  const restored = await agent.readFile("min.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 0,
  });
  assert.equal(restored.restoredFromCache, true);
  assert.equal(restored.partialSegment.endColumn, 4000);
  assert.equal(restored.completeLineRange, null);
  assert.equal(
    [...agent.fileKnowledge.files.values()][0].contentLines.has(1),
    false,
  );
  visible(agent, [restored]);
  const continuation = await agent.readFile("min.js", {
    startLine: 1,
    endLine: 1,
    startColumn: 4000,
  });
  assert.equal(continuation.contentStartColumn, 4000);
});

test("visible overlap is removed while a missing range remains allowed", async () => {
  const content = Array.from(
    { length: 180 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const agent = fixture({ "a.js": content });
  const first = await agent.readFile("a.js", { startLine: 1, endLine: 100 });
  visible(agent, [first]);
  const next = await agent.readFile("a.js", { startLine: 80, endLine: 140 });
  assert.equal(next.requestedStartLine, 80);
  assert.equal(next.contentStartLine, 101);
  assert.equal(next.contentEndLine, 140);
  assert.match(next.content, /^line-101\n/);
  assert.equal(next.content.includes("line-80\n"), false);
});

test("cached content absent after context compaction is restored", async () => {
  const agent = fixture({
    "a.js": Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join(
      "\n",
    ),
  });
  const first = await agent.readFile("a.js", { startLine: 1, endLine: 100 });
  visible(agent, [first]);
  agent.contextManager.updateModelFileVisibility([]);
  const restored = await agent.readFile("a.js", { startLine: 50, endLine: 60 });
  assert.equal(restored.restoredFromCache, true);
  assert.equal(restored.contentStartLine, 50);
  assert.equal(restored.contentEndLine, 60);
  assert.match(restored.content, /^line-50\n/);
});

test("an editor-buffer revision change invalidates previously visible coverage", async () => {
  const agent = fixture({ "a.js": "disk" });
  const openFile = {
    lines: ["before", "second"].map((text) => ({ getText: () => text })),
  };
  agent.editor.tabManager.getFileByPath = () => openFile;
  const first = await agent.readFile("a.js", { startLine: 1, endLine: 2 });
  visible(agent, [first]);
  openFile.lines = ["after", "second"].map((text) => ({ getText: () => text }));
  const changed = await agent.readFile("a.js", { startLine: 1, endLine: 2 });
  assert.equal(changed.readDecision, "NEW");
  assert.equal(changed.content, "after\nsecond");
  assert.notEqual(changed.revision, first.revision);
});

test("external filesystem invalidation prevents an old revision from blocking a read", async () => {
  const files = { "a.js": "before\nsecond" };
  const agent = fixture(files);
  const first = await agent.readFile("a.js", { startLine: 1, endLine: 2 });
  visible(agent, [first]);
  files["a.js"] = "after\nsecond";
  agent.fileKnowledge.invalidateFile(
    "/workspace/a.js",
    null,
    "external_change",
  );
  const changed = await agent.readFile("a.js", { startLine: 1, endLine: 2 });
  assert.equal(changed.content, "after\nsecond");
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.noNewInformation, undefined);
});

test("three zero-information subranges hard-block, then a new range and file work", async () => {
  const agent = fixture({
    "a.js": Array.from({ length: 200 }, (_, index) => `line-${index + 1}`).join(
      "\n",
    ),
    "b.js": "other-file",
  });
  const first = await agent.readFile("a.js", { startLine: 1, endLine: 140 });
  visible(agent, [first]);
  const decisions = [];
  for (const [startLine, endLine] of [
    [30, 40],
    [35, 50],
    [60, 80],
  ]) {
    const result = await agent.readFile("a.js", { startLine, endLine });
    decisions.push(result.readDecision);
    assert.equal(Object.hasOwn(result, "content"), false);
  }
  assert.deepEqual(decisions, [
    "ALREADY_AVAILABLE",
    "REPEATED_REDUNDANT_READ",
    "REDUNDANT_READ_HARD_BLOCK",
  ]);
  const missing = await agent.readFile("a.js", {
    startLine: 150,
    endLine: 170,
  });
  assert.equal(missing.success, true);
  assert.equal(missing.contentStartLine, 150);
  assert.equal(agent.fileKnowledge.consecutiveRedundantReads, 0);
  const other = await agent.readFile("b.js", { startLine: 1, endLine: 1 });
  assert.equal(other.success, true);
  assert.equal(other.content, "other-file");
});

test("a useful search resets only the consecutive redundant-read sequence", async () => {
  const agent = fixture({
    "a.js": Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join(
      "\n",
    ),
  });
  agent.editor.api.searchInFiles = async () => ({
    success: true,
    results: [{ path: "a.js", line: 90 }],
  });
  const first = await agent.readFile("a.js", { startLine: 1, endLine: 100 });
  visible(agent, [first]);
  const duplicate = await agent.readFile("a.js", {
    startLine: 30,
    endLine: 40,
  });
  assert.equal(duplicate.readDecision, "ALREADY_AVAILABLE");
  const search = await agent.executeToolCall({
    id: "search",
    type: "function",
    function: {
      name: "search_code",
      arguments: JSON.stringify({ query: "line" }),
    },
  });
  assert.equal(search.success, true);
  assert.equal(agent.fileKnowledge.consecutiveRedundantReads, 0);
  const after = await agent.readFile("a.js", { startLine: 35, endLine: 45 });
  assert.equal(after.readDecision, "ALREADY_AVAILABLE");
});

test("mixed visible, cached, and unknown coverage delivers only missing content", async () => {
  const content = Array.from(
    { length: 120 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const agent = fixture({ "a.js": content });
  const first = await agent.readFile("a.js", { startLine: 1, endLine: 80 });
  visible(agent, [
    {
      ...first,
      contentEndLine: 40,
      completeLineRange: { startLine: 1, endLine: 40 },
      content: content.split("\n").slice(0, 40).join("\n"),
    },
  ]);
  const restored = await agent.readFile("a.js", {
    startLine: 20,
    endLine: 100,
  });
  assert.equal(restored.restoredFromCache, true);
  assert.equal(restored.contentStartLine, 41);
  assert.equal(restored.contentEndLine, 100);
  assert.equal(restored.readDecision, "RESTORED_AND_NEW");
  assert.match(restored.content, /^line-41\n/);
  assert.match(restored.content, /\nline-81\n/);
  assert.equal(restored.content.includes("line-20\n"), false);
});

test("provider context proactively drops old complete redundant read exchanges", () => {
  const agent = fixture({ "a.js": "x" });
  const noops = Array.from({ length: 10 }, (_, index) => ({
    success: true,
    path: "a.js",
    alreadyKnown: true,
    noNewInformation: true,
    readDecision: index > 2 ? "REDUNDANT_READ_HARD_BLOCK" : "ALREADY_AVAILABLE",
    revision: "r1",
    requestedRange: { startLine: index + 1, endLine: index + 1 },
    message: "Already visible",
  }));
  const messages = visible(agent, noops);
  const trimmed =
    agent.contextManager.deduplicateRedundantReadExchanges(messages);
  assert.equal(trimmed.length, 2);
  const providerView = agent.buildModelContext(messages, {
    contextCompaction: { enabled: false, logMetrics: false },
  });
  assert.equal(providerView.length, 2);
  assert.ok(
    agent.estimateTokens(providerView) < agent.estimateTokens(messages) * 0.3,
  );
  const useful = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "useful",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "useful",
      content: JSON.stringify({
        success: true,
        result: {
          success: true,
          path: "a.js",
          revision: "r1",
          startLine: 1,
          contentStartLine: 1,
          contentEndLine: 1,
          completeLineRange: { startLine: 1, endLine: 1 },
          content: "SOURCE_CODE_UNIQUE",
        },
      }),
    },
  ];
  const withCode = agent.buildModelContext([...useful, ...messages], {
    contextCompaction: { enabled: false, logMetrics: false },
  });
  assert.equal(withCode.length, 4);
  assert.equal(
    JSON.stringify(withCode).split("SOURCE_CODE_UNIQUE").length - 1,
    1,
  );
  assert.equal(
    agent.contextManager.groupModelContextEntries(trimmed)[0].protocolValid,
    true,
  );
  assert.ok(
    agent.fileKnowledge.metrics.proactiveRedundantExchangesRemoved >= 9,
  );
  assert.ok(agent.fileKnowledge.metrics.redundantContextTokensAvoided > 0);
  const mixed = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "read",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
        {
          id: "search",
          type: "function",
          function: { name: "search_code", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "read",
      content: JSON.stringify({
        success: true,
        result: { noNewInformation: true },
      }),
    },
    {
      role: "tool",
      tool_call_id: "search",
      content: JSON.stringify({
        success: true,
        result: { results: ["useful"] },
      }),
    },
  ];
  assert.equal(
    agent.contextManager.deduplicateRedundantReadExchanges(mixed).length,
    3,
  );
});
