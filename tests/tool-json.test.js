const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAgent } = require("./helpers/agent-runtime");
const { FileManager } = require("../dist/ts/addon/FileManager");

function bareAgent() {
  return createAgent({ api: {}, tabManager: { activeFile: null } });
}

function call(name, args, id = "call-1") {
  return { id, type: "function", function: { name, arguments: args } };
}

function response(calls, finish = "tool_calls") {
  return {
    choices: [
      {
        finish_reason: finish,
        message: { role: "assistant", content: null, tool_calls: calls },
      },
    ],
  };
}

// Deliberately put actual controls inside JSON strings, keeping other escapes intact.
function rawArguments(args) {
  return JSON.stringify(args)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");
}

test("strict JSON and existing escapes remain unchanged without repair", () => {
  const agent = bareAgent();
  const content =
    '"hello" C:\\folder\\file /\\d+/ `hello ${name}` {"a":1} é 你好 😀\n\t\r';
  const raw = JSON.stringify({ path: "a.js", content });
  assert.equal(agent.parseCanonicalToolArguments(raw).content, content);
  assert.equal(agent.agentProgress.metrics.toolArgumentRepairAttempts, 0);
  const literalEscape = '{"content":"hello\\\\nworld","unicode":"\\u0041"}';
  assert.equal(
    agent.parseCanonicalToolArguments(literalEscape).content,
    "hello\\nworld",
  );
  assert.equal(agent.parseCanonicalToolArguments(literalEscape).unicode, "A");
  assert.equal(agent.agentProgress.metrics.toolArgumentRepairAttempts, 0);
});

test("repair preserves every U+0000..U+001F control and surrounding whitespace", () => {
  const agent = bareAgent();
  for (let code = 0; code < 32; code++) {
    const content = `before${String.fromCharCode(code)}after`;
    const raw = `\n{\n\t"content":"${content}"\r\n}\n`;
    assert.throws(() => JSON.parse(raw));
    assert.equal(agent.parseCanonicalToolArguments(raw).content, content);
  }
  assert.equal(agent.agentProgress.metrics.toolArgumentRepairAttempts, 32);
  assert.equal(agent.agentProgress.metrics.toolArgumentRepairSuccesses, 32);
});

test("repair does not double escape quotes, backslashes, regex, templates or Unicode", () => {
  const agent = bareAgent();
  const content =
    '"hello" C:\\folder\\file /\\d+/ `hello ${name}` {"a":1} é 你好 😀';
  const raw = JSON.stringify({ content }).replace(
    '"content":"',
    '"content":"\n',
  );
  assert.equal(agent.parseCanonicalToolArguments(raw).content, `\n${content}`);
  assert.equal(agent.agentProgress.metrics.toolArgumentRepairSuccesses, 1);
});

test("objects bypass repair but retain all JSON safety validations", () => {
  const agent = bareAgent();
  const args = { content: "line\nline", nested: { n: 2 } };
  assert.equal(agent.parseCanonicalToolArguments(args), args);
  const circular = {};
  circular.self = circular;
  for (const invalid of [
    { x: undefined },
    { x: 1n },
    { x() {} },
    { x: Infinity },
    circular,
    [],
    "[]",
    '"text"',
    '{"x":1e999}',
  ]) {
    assert.throws(() => agent.parseCanonicalToolArguments(invalid));
  }
  assert.equal(agent.agentProgress.metrics.toolArgumentRepairAttempts, 0);
});

test("structural corruption and controls outside strings are never guessed", () => {
  const agent = bareAgent();
  for (const raw of [
    '{"content":"abc}',
    '{"content":"abc"',
    '{"path":"a" "content":"b"}',
    '{"path":',
    '{"content":"abc\n',
    '{"content":"a"}\u0001',
    '{"content":"a\n"\u0001}',
    '{"content":"a\\\nb"}',
  ]) {
    assert.throws(
      () => agent.parseResponse(response([call("create_file", raw)])),
      (error) =>
        ["TOOL_ARGUMENTS_MALFORMED", "TOOL_ARGUMENTS_TRUNCATED"].includes(
          error.code,
        ),
    );
    assert.equal(agent.executedToolCalls.size, 0);
  }
});

test("parse diagnostics never contain a payload excerpt or secret", () => {
  const agent = bareAgent();
  const secret = "PRIVATE_SECRET_123";
  assert.throws(
    () => agent.parseResponse(response([call("create_file", `${secret}!`)])),
    (error) => {
      assert.equal(error.code, "TOOL_ARGUMENTS_MALFORMED");
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

async function fixture(t, provider, fetchProvider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-tool-json-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new FileManager({});
  let writes = 0;
  const editor = {
    fileExplorer: { rootPath: root },
    tabManager: {
      activeFile: null,
      files: [],
      getFileByPath() {
        return null;
      },
    },
    api: {
      async agentFileOperation(...args) {
        if (["createFile", "saveFile"].includes(args[1])) writes++;
        return manager.agentFileOperation(...args);
      },
      getFileContent: manager.getFileContent.bind(manager),
      async pathExists(candidate) {
        try {
          await fs.stat(candidate);
          return true;
        } catch {
          return false;
        }
      },
    },
  };
  if (provider) editor.api.aiChat = provider;
  const agent = createAgent(editor, fetchProvider);
  agent.setProvider({ id: "mock", baseURL: "https://mock.invalid" });
  agent.setModel("mock-model");
  return { agent, root, writes: () => writes };
}

function reviewCalls() {
  return response([
    call("get_changed_files", {}, "review-files"),
    call("get_diff", {}, "review-diff"),
  ]);
}

function completeCall() {
  return response([
    call(
      "task_complete",
      { summary: "Done", validation: "Verified" },
      "complete",
    ),
  ]);
}

test("provider create_file repairs raw LF and creates exact content once with one tracked change", async (t) => {
  const content = 'function hello() {\n\tconsole.log("hello");\n}\n';
  const raw = rawArguments({ path: "generated.js", content });
  assert.throws(() => JSON.parse(raw));
  let requests = 0;
  const { agent, root, writes } = await fixture(t, async ({ payload }) => {
    assert.equal(payload.stream, false);
    return [
      response([call("create_file", raw)]),
      reviewCalls(),
      completeCall(),
    ][requests++];
  });
  let errors = 0;
  agent.callbacks.onError = () => errors++;
  await agent.execute("Create generated.js");
  assert.equal(
    await fs.readFile(path.join(root, "generated.js"), "utf8"),
    content,
  );
  assert.equal(writes(), 1);
  assert.equal(agent.runChangeTracker.current.changeVersion, 1);
  assert.equal(agent.runChangeTracker.current.changes.size, 1);
  assert.equal(agent.lastRunMetrics.toolArgumentRepairSuccesses, 1);
  assert.equal(errors, 0);
});

test("provider write_file_chunk repairs controls with exact append and explicit revision", async (t) => {
  const initial = "initial\n";
  const appended = "next\r\n\tline\n";
  let requests = 0;
  const { agent, root, writes } = await fixture(t, async () => {
    requests++;
    if (requests === 1)
      return response([
        call("create_file", { path: "a.js", content: initial }),
      ]);
    if (requests === 2)
      return response([
        call(
          "write_file_chunk",
          rawArguments({
            path: "a.js",
            content: appended,
            expectedRevision: agent.getContentRevision(initial),
          }),
          "append",
        ),
      ]);
    if (requests === 3)
      return response([call("read_file", { path: "a.js" }, "validate-append")]);
    if (requests === 4) return reviewCalls();
    return completeCall();
  });
  await agent.execute("Create a.js");
  assert.equal(
    await fs.readFile(path.join(root, "a.js"), "utf8"),
    initial + appended,
  );
  assert.equal(writes(), 2);
  const appendedResult = agent.executedToolCalls.get("append").result;
  assert.equal(
    appendedResult.previousRevision,
    agent.getContentRevision(initial),
  );
  assert.equal(
    appendedResult.revision,
    agent.getContentRevision(initial + appended),
  );
  assert.equal(appendedResult.appendedChars, appended.length);
  assert.equal(agent.lastRunMetrics.toolArgumentRepairSuccesses, 1);
});

test("malformed response executes no calls, recovers once, then completes without unresolved failures", async (t) => {
  let requests = 0;
  const { agent, root, writes } = await fixture(t, async ({ payload }) => {
    requests++;
    if (requests === 1)
      return response([
        call(
          "create_file",
          { path: "unexecuted.js", content: "must not execute" },
          "valid-sibling",
        ),
        call("create_file", '{"path":"a.js" "content":"bad"}', "invalid"),
      ]);
    if (requests === 2) {
      assert.equal(writes(), 0);
      assert.equal(agent.runChangeTracker.current.changeVersion, 0);
      assert.equal(agent.executedToolCalls.size, 0);
      assert.ok(
        payload.messages.some((m) =>
          m.content?.includes("[NCE TOOL ARGUMENT RECOVERY]"),
        ),
      );
      return response([
        call("create_file", { path: "a.js", content: "fixed" }, "retry-new-id"),
      ]);
    }
    if (requests === 3) return reviewCalls();
    return completeCall();
  });
  await agent.execute("Create a.js");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "fixed");
  assert.equal(writes(), 1);
  assert.equal(agent.runChangeTracker.current.unresolvedFailures.size, 0);
  assert.equal(agent.lastRunMetrics.toolArgumentRecoveryRequests, 1);
  assert.equal(agent.lastRunMetrics.toolArgumentRecoveryFailures, 0);
});

test("malformed recovery exhausts after two requests without mutations", async (t) => {
  let requests = 0;
  const { agent, writes } = await fixture(t, async () => {
    requests++;
    return response([
      call("create_file", '{"path":"a.js" "content":"bad"}', `bad-${requests}`),
    ]);
  });
  await assert.rejects(agent.execute("Create a.js"), {
    code: "TOOL_ARGUMENTS_MALFORMED",
    retryable: false,
  });
  assert.equal(requests, 3);
  assert.equal(writes(), 0);
  assert.equal(agent.runChangeTracker.current.changeVersion, 0);
  assert.equal(agent.runChangeTracker.current.changes.size, 0);
  assert.equal(agent.lastRunMetrics.toolArgumentRecoveryRequests, 2);
  assert.equal(agent.lastRunMetrics.toolArgumentRecoveryFailures, 1);
});

test("recovery preserves completed actions and does not cache an invalid call ID", async (t) => {
  let requests = 0;
  const { agent, root, writes } = await fixture(t, async () => {
    requests++;
    if (requests === 1)
      return response([
        call("create_file", { path: "a.js", content: "first" }, "completed"),
      ]);
    if (requests === 2)
      return response([
        call("create_file", '{"path":"b.js" "content":"bad"}', "retry"),
      ]);
    if (requests === 3) {
      assert.equal(writes(), 1);
      assert.equal(agent.runChangeTracker.current.changeVersion, 1);
      assert.equal(agent.executedToolCalls.has("retry"), false);
      assert.equal(agent.executedToolCalls.has("completed"), true);
      return response([
        call("create_file", { path: "b.js", content: "second" }, "retry"),
      ]);
    }
    if (requests === 4) return reviewCalls();
    return completeCall();
  });
  await agent.execute("Create two files");
  assert.equal(writes(), 2);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "first");
  assert.equal(await fs.readFile(path.join(root, "b.js"), "utf8"), "second");
  assert.equal(agent.runChangeTracker.current.changeVersion, 2);
  assert.equal(agent.lastRunMetrics.toolArgumentRecoveryRequests, 1);
});

test("abort during recovery stops further requests and never mutates files", async (t) => {
  let requests = 0;
  const { agent, writes } = await fixture(t, async () => {
    requests++;
    if (requests === 2) agent.abortController.abort();
    return response([call("create_file", '{"path":"a.js" "content":"bad"}')]);
  });
  await assert.rejects(agent.execute("Create a.js"), (error) =>
    agent.isAbortError(error),
  );
  assert.equal(requests, 2);
  assert.equal(writes(), 0);
});

test("output limit aliases classify truncation even with controls or a syntactically complete prefix", () => {
  const agent = bareAgent();
  for (const reason of [
    "length",
    "max_tokens",
    "max_output_tokens",
    "model_length",
    "token_limit",
  ]) {
    for (const args of [
      '{"path":"a.js","content":"partial\n',
      '{"path":"a.js","content":"prefix"}',
    ]) {
      assert.throws(
        () =>
          agent.parseResponse(response([call("create_file", args)], reason)),
        { code: "TOOL_ARGUMENTS_TRUNCATED" },
      );
    }
  }
  assert.equal(agent.agentProgress.metrics.toolArgumentRepairAttempts, 0);
});

test("truncation retains bounded large-write recovery without partial execution", async (t) => {
  let requests = 0;
  const { agent, writes } = await fixture(t, async () => {
    requests++;
    return response(
      [call("create_file", '{"path":"a.js","content":"partial\n')],
      "max_tokens",
    );
  });
  await assert.rejects(agent.execute("Create a.js"), {
    code: "WRITE_RECOVERY_EXHAUSTED",
  });
  assert.equal(requests, 6);
  assert.equal(writes(), 0);
  assert.equal(agent.runChangeTracker.current.changeVersion, 0);
});

test("truncation cause distinguishes output limit from incomplete model JSON", () => {
  const agent = bareAgent();
  const raw = '{"path":"a.js","content":"unfinished';
  for (const [finish, cause] of [["length", "output_limit"], ["stop", "incomplete_model_json"]]) {
    const result = response([call("create_file", raw)], finish);
    let error;
    try { agent.parseResponse(result); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.equal(agent.isRecoverableLargeWriteToolCallError(error, result), true);
    assert.equal(error.truncationCause, cause);
  }
});

test("three large malformed creates enforce a small create and a revisioned chunk", async (t) => {
  let requests = 0;
  let observedReplan = false;
  const { agent, root, writes } = await fixture(t, async () => {
    requests++;
    if (requests <= 3) {
      assert.equal(writes(), 0);
      return response([call("create_file", '{"path":"snake-game.html","content":"' + "a".repeat([6500, 6300, 6100][requests - 1]), `bad-${requests}`)], "length");
    }
    if (requests === 4) {
      assert.equal(agent.largeWriteState.strategyReplanRequired, true);
      assert.equal(agent.largeWriteState.strategyReplanCount, 1);
      assert.ok(agent.largeWriteState.temporaryRecoveryMax <= 2500);
      observedReplan = true;
      return response([call("create_file", JSON.stringify({ path: "snake-game.html", content: "a".repeat(6000) }), "rejected")]);
    }
    if (requests === 5) {
      assert.equal(writes(), 0);
      return response([call("create_file", JSON.stringify({ path: "snake-game.html", content: "a".repeat(1500) }), "small")]);
    }
    if (requests === 6) {
      assert.equal(agent.largeWriteState.strategyReplanRequired, false);
      assert.equal(agent.largeWriteState.strategyFailures, 0);
      return response([call("write_file_chunk", JSON.stringify({ path: "snake-game.html", content: "b".repeat(2000), expectedRevision: agent.largeWriteState.currentRevision }), "chunk")]);
    }
    if (requests === 7) return response([call("read_file", JSON.stringify({ path: "snake-game.html" }), "validate")]);
    if (requests === 8) return reviewCalls();
    return completeCall();
  });
  await agent.execute("Create snake-game.html");
  assert.equal(observedReplan, true);
  assert.equal(writes(), 2);
  assert.equal(await fs.readFile(path.join(root, "snake-game.html"), "utf8"), "a".repeat(1500) + "b".repeat(2000));
  assert.equal(agent.agentProgress.metrics.modelFallbacks, 0);
  assert.equal(agent.agentProgress.metrics.repeatedFailedStrategiesRejected, 1);
});

test("truncated create_file recovers through the existing large-write protocol", async (t) => {
  let requests = 0;
  const { agent, root, writes } = await fixture(t, async () => {
    requests++;
    if (requests === 1)
      return response(
        [call("create_file", '{"path":"a.js","content":"cut\n')],
        "length",
      );
    if (requests === 2) {
      assert.equal(writes(), 0);
      return response([
        call(
          "create_file",
          { path: "a.js", content: "complete\n" },
          "recovered",
        ),
      ]);
    }
    if (requests === 3)
      return response([call("read_file", { path: "a.js" }, "validate")]);
    if (requests === 4) return reviewCalls();
    return completeCall();
  });
  await agent.execute("Create a.js");
  assert.equal(
    await fs.readFile(path.join(root, "a.js"), "utf8"),
    "complete\n",
  );
  assert.equal(writes(), 1);
  assert.equal(agent.runChangeTracker.current.changeVersion, 1);
});

test("repaired arguments still obey permissions, schema, payload limits and revisions", async (t) => {
  const { agent, root, writes } = await fixture(t);
  const make = (args) =>
    agent.finalizeToolCall(call("create_file", rawArguments(args)));
  agent.permissions = "read";
  assert.equal(
    (await agent.executeToolCall(make({ path: "a.js", content: "a\n" }))).error
      .code,
    "TOOL_NOT_ALLOWED",
  );
  agent.permissions = "code";
  agent.largeFileWriting.maxChunkCharacters = 3;
  assert.equal(
    (await agent.executeToolCall(make({ path: "a.js", content: "long\n" })))
      .success,
    false,
  );
  assert.equal(
    (await agent.executeToolCall(make({ path: 42, content: "a\n" }))).success,
    false,
  );
  assert.equal(writes(), 0);
  await fs.writeFile(path.join(root, "a.js"), "old");
  const chunk = agent.finalizeToolCall(
    call(
      "write_file_chunk",
      rawArguments({ path: "a.js", content: "x\n", expectedRevision: "wrong" }),
    ),
  );
  assert.equal((await agent.executeToolCall(chunk)).success, false);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "old");
  assert.equal(writes(), 0);
});

test("HTTP fragments are fully assembled before parsing arguments, including split escapes and Unicode", async (t) => {
  let requests = 0;
  let bodyComplete = false;
  const content = 'é 你好 😀\n"quoted" C:\\folder /\\d+/\tend';
  const { agent, root } = await fixture(t, null, async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, false);
    const result = [
      response([call("create_file", rawArguments({ path: "a.js", content }))]),
      reviewCalls(),
      completeCall(),
    ][requests++];
    const bytes = new TextEncoder().encode(JSON.stringify(result));
    bodyComplete = false;
    let index = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (index < bytes.length)
            controller.enqueue(bytes.slice(index, ++index));
          else {
            bodyComplete = true;
            controller.close();
          }
        },
      }),
    );
  });
  const finalize = agent.finalizeToolCalls.bind(agent);
  agent.finalizeToolCalls = (...args) => {
    assert.equal(bodyComplete, true);
    return finalize(...args);
  };
  await agent.execute("Create a.js");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), content);
});
