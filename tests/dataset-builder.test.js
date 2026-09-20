const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskSource } = require("../src/js/agent/dataset/TaskSource");
const { WorkspaceFactory } = require("../src/js/agent/dataset/WorkspaceFactory");
const { WorkspaceSnapshot } = require("../src/js/agent/dataset/WorkspaceSnapshot");
const { TrajectoryRecorder } = require("../src/js/agent/dataset/TrajectoryRecorder");
const { DatasetSanitizer } = require("../src/js/agent/dataset/DatasetSanitizer");
const { ObjectiveValidator } = require("../src/js/agent/dataset/ObjectiveValidator");
const { DatasetWriter } = require("../src/js/agent/dataset/DatasetWriter");
const { DatasetBuilder } = require("../src/js/agent/dataset/DatasetBuilder");
const { AgentHarness } = require("../src/js/agent/dataset/AgentHarness");

async function temporary(prefix = "nce-dataset-test-") { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }
async function withTemp(fn) { const root = await temporary(); try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); } }
function tool(name, args, id) { return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }; }
function complete(content = "done") { return { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }; }

test("TaskSource parses JSONL and rejects invalid, duplicate and missing fields with line numbers", async () => withTemp(async (root) => {
  const file = path.join(root, "tasks.jsonl");
  await fs.writeFile(file, `\n${JSON.stringify({ id: "a", prompt: "go", workspace: { template: "fixture" } })}\n`);
  assert.equal((await TaskSource.read(file)).tasks.length, 1);
  for (const [content, pattern] of [["{", /:1: invalid JSON/], [JSON.stringify({ id: "a", prompt: "x", workspace: { template: "f" } }) + "\n" + JSON.stringify({ id: "a", prompt: "y", workspace: { template: "f" } }), /:2: duplicate id/], [JSON.stringify({ prompt: "x", workspace: { template: "f" } }), /id is required/], [JSON.stringify({ id: "x", workspace: { template: "f" } }), /prompt is required/]]) { await fs.writeFile(file, content); await assert.rejects(TaskSource.read(file), pattern); }
}));

test("WorkspaceFactory copies hidden files, isolates attempts, rejects traversal/symlinks and cleans up", async () => withTemp(async (root) => {
  const fixture = path.join(root, "fixture"); await fs.mkdir(fixture); await fs.writeFile(path.join(fixture, ".hidden"), "original");
  const factory = new WorkspaceFactory({ baseDir: root }); const task = { id: "x", workspace: { template: "fixture" } };
  const a = await factory.create(task), b = await factory.create(task); await fs.writeFile(path.join(a.root, ".hidden"), "changed");
  assert.equal(await fs.readFile(path.join(fixture, ".hidden"), "utf8"), "original"); assert.equal(await fs.readFile(path.join(b.root, ".hidden"), "utf8"), "original");
  await assert.rejects(factory.create({ id: "bad", workspace: { template: "../escape" } }), /escapes/);
  if (process.platform !== "win32") { await fs.symlink(path.join(root, "outside"), path.join(fixture, "link")); await assert.rejects(factory.create(task), /symlinks/); await fs.unlink(path.join(fixture, "link")); }
  await a.cleanup(); await b.cleanup(); await assert.rejects(fs.access(a.root));
}));

test("WorkspaceSnapshot detects created, modified, deleted, unchanged and binary files", async () => withTemp(async (root) => {
  await fs.writeFile(path.join(root, "same.txt"), "same"); await fs.writeFile(path.join(root, "change.txt"), "old"); await fs.writeFile(path.join(root, "delete.txt"), "gone"); await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  const snapshots = new WorkspaceSnapshot(), before = await snapshots.capture(root); await fs.writeFile(path.join(root, "change.txt"), "new"); await fs.rm(path.join(root, "delete.txt")); await fs.writeFile(path.join(root, "create.txt"), "hi"); const after = await snapshots.capture(root), diff = snapshots.diff(before, after);
  assert.deepEqual(diff.created.map((x) => x.path), ["create.txt"]); assert.deepEqual(diff.modified.map((x) => x.path), ["change.txt"]); assert.deepEqual(diff.deleted.map((x) => x.path), ["delete.txt"]); assert.equal(after.files.find((x) => x.path === "binary.bin").content, undefined); assert.equal(diff.modified.some((x) => x.path === "same.txt"), false);
}));

test("TrajectoryRecorder pairs lifecycle events, sequences them, records retry and detects integrity issues without leaks", () => {
  const listeners = new Map(); const agent = { subscribe(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); } }; const emit = (name, payload) => { for (const fn of listeners.get(name) || []) fn(payload); };
  const recorder = new TrajectoryRecorder().attach(agent); emit("run:start", { runId: 1 }); emit("model:retry", { requestId: "r" }); emit("tool:start", { toolCallId: "t", toolName: "run_tests", arguments: {} }); emit("tool:end", { toolCallId: "t", toolName: "run_tests", status: "success", result: { status: "FAILED" } }); emit("run:end", { runId: 1, status: "completed" }); recorder.detach();
  const result = recorder.build(); assert.deepEqual(recorder.events.map((e) => e.seq), [1, 2, 3, 4, 5]); assert.equal(result.integrity.valid, true); assert.equal(result.trajectory.find((s) => s.kind === "tool").result.status, "FAILED"); assert.equal([...listeners.values()].every((set) => set.size === 0), true);
  const broken = new TrajectoryRecorder(); broken.record("tool:end", { toolCallId: "missing" }); assert.equal(broken.build().integrity.valid, false);
});

test("DatasetSanitizer removes credential sentinels and machine paths but preserves token metrics", () => {
  const root = path.join(os.tmpdir(), "very-secret-machine-path", "project"); const value = new DatasetSanitizer({ workspaceRoot: root, secrets: ["SUPER_SECRET_API_KEY"] }).sanitize({ apiKey: "SUPER_SECRET_API_KEY", headers: { Authorization: "Bearer SUPER_SECRET_TOKEN" }, error: `${root}/src/a.js SUPER_SECRET_API_KEY`, inputTokens: 12, totalTokens: 15 }); const json = JSON.stringify(value);
  assert.doesNotMatch(json, /SUPER_SECRET/); assert.doesNotMatch(json, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); assert.equal(value.inputTokens, 12); assert.equal(value.totalTokens, 15);
});

test("ObjectiveValidator handles filesystem, commands, timeout and changed-path policies", async () => withTemp(async (root) => {
  await fs.writeFile(path.join(root, "a.txt"), "hello"); const validator = new ObjectiveValidator({ defaultTimeoutMs: 50 });
  const result = await validator.validate({ workspaceRoot: root, diff: { created: [{ path: "a.txt" }, { path: "bad.txt" }], modified: [], deleted: [] }, task: { validation: { allowedChangedPaths: ["a.txt", "bad.txt"], forbiddenChangedPaths: ["locked/"], assertions: [{ type: "file_exists", path: "a.txt" }, { type: "file_not_exists", path: "missing" }, { type: "file_contains", path: "a.txt", text: "hell" }, { type: "file_not_contains", path: "a.txt", text: "nope" }, { type: "command", command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 2000 }, { type: "command", command: process.execPath, args: ["-e", "process.exit(2)"], timeoutMs: 2000 }, { type: "command", command: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"], timeoutMs: 20 }] } } });
  assert.equal(result.checks.slice(0, 5).every((x) => x.passed), true); assert.equal(result.checks[5].passed, false); assert.equal(result.checks[6].timedOut, true); assert.equal(result.passed, false);
}));

test("DatasetWriter creates valid append-only JSONL, resume state, artifacts and rejects duplicates", async () => withTemp(async (root) => {
  const writer = await new DatasetWriter(path.join(root, "output"), { artifacts: true }).initialize(); const sample = { schemaVersion: 1, sampleId: "a:1", task: { id: "a" } }; await writer.write(sample, { events: [{ seq: 1 }], validation: { passed: true } }); assert.equal(writer.hasTask("a"), true); await assert.rejects(writer.write(sample), /duplicate/); const next = await new DatasetWriter(path.join(root, "output")).initialize(); assert.equal(next.hasTask("a"), true); assert.deepEqual(JSON.parse((await fs.readFile(next.filePath, "utf8")).trim()), sample);
}));

test("integration: real AgentRunner and ToolExecutor modify an isolated workspace, validate, sanitize and write JSONL", async () => withTemp(async (root) => {
  const fixture = path.join(root, "fixture"); await fs.mkdir(fixture); await fs.writeFile(path.join(fixture, "keep.txt"), "fixture unchanged");
  const responses = [tool("create_file", { path: "answer.txt", content: "correct\n" }, "create"), tool("read_file", { path: "answer.txt" }, "verify"), tool("get_diff", { path: "answer.txt" }, "review"), tool("task_complete", { summary: "created", validation: "checked" }, "complete")]; let index = 0;
  const writer = await new DatasetWriter(path.join(root, "output")).initialize(); const builder = new DatasetBuilder({ writer, workspaceFactory: new WorkspaceFactory({ baseDir: root }), harness: new AgentHarness({ transport: async () => responses[index++] || complete() }), secrets: ["SUPER_SECRET_API_KEY"], agentConfig: { providerId: "mock", model: "mock-model", provider: { id: "mock", baseURL: "https://invalid", apiKey: "SUPER_SECRET_API_KEY", supportsTools: true, requiresApiKey: false } } });
  const [sample] = await builder.build([{ id: "real-agent", prompt: "Crée answer.txt avec le texte correct.", workspace: { template: "fixture" }, validation: { assertions: [{ type: "file_contains", path: "answer.txt", text: "correct" }] } }]);
  assert.equal(sample.outcome, "validated_success", JSON.stringify(sample.agentResult)); assert.equal(sample.validation.passed, true); assert.deepEqual(sample.trajectory.filter((s) => s.kind === "tool").map((s) => s.name), ["create_file", "read_file", "get_diff", "task_complete"]); assert.equal(await fs.readFile(path.join(fixture, "keep.txt"), "utf8"), "fixture unchanged"); const json = await fs.readFile(writer.filePath, "utf8"); assert.doesNotMatch(json, /SUPER_SECRET|nce-dataset-real-agent/); assert.equal(JSON.parse(json).sampleId, "real-agent:1");
}));

test("DatasetBuilder records false Agent success as failed_validation and continues across task failures", async () => withTemp(async (root) => {
  const fixture = path.join(root, "fixture"); await fs.mkdir(fixture); const writer = await new DatasetWriter(path.join(root, "output")).initialize();
  class ScriptHarness { async create(_workspace, config) { const { createAgent } = require("./helpers/agent-runtime"); const listeners = new Map(); const agent = { provider: { id: "mock" }, model: "mock", subscribe(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); }, async execute(_prompt, options) { const emit = (name, payload) => { for (const fn of listeners.get(name) || []) fn(payload); }; emit("run:start", { sessionId: options.sessionId, runId: 1, startedAt: Date.now() }); if (config.permissions === "fail") { emit("run:end", { sessionId: options.sessionId, runId: 1, status: "failed" }); throw new Error("provider failed"); } emit("run:end", { sessionId: options.sessionId, runId: 1, status: "completed", metrics: {} }); return { response: "claimed done" }; } }; void createAgent; return agent; } }
  const builder = new DatasetBuilder({ writer, workspaceFactory: new WorkspaceFactory({ baseDir: root }), harness: new ScriptHarness() }); const tasks = [{ id: "a", prompt: "a", workspace: { template: "fixture" }, validation: { assertions: [{ type: "file_exists", path: "missing" }] } }, { id: "b", prompt: "b", workspace: { template: "fixture" }, agent: { permissions: "fail" }, validation: {} }, { id: "c", prompt: "c", workspace: { template: "fixture" }, validation: {} }]; const samples = await builder.build(tasks);
  assert.deepEqual(samples.map((s) => s.outcome), ["failed_validation", "agent_failed", "validated_success"]); assert.equal((await fs.readFile(writer.filePath, "utf8")).trim().split("\n").length, 3);
}));

test("pilot: three deterministic real-Agent tasks produce two successes and one validation failure", async () => withTemp(async (root) => {
  const source = await TaskSource.read(path.join(__dirname, "../dataset/tasks/pilot.jsonl")); const positions = new Map();
  const transport = async (request) => {
    const id = request.sessionId.split(":")[0], index = positions.get(id) || 0; positions.set(id, index + 1);
    if (id === "pilot-b") return complete("claimed success without filesystem change");
    const content = id === "pilot-a" ? "alpha\n" : "gamma\n";
    return [tool("create_file", { path: "result.txt", content }, `${id}-create`), tool("read_file", { path: "result.txt" }, `${id}-read`), tool("get_diff", { path: "result.txt" }, `${id}-diff`), tool("task_complete", { summary: "done", validation: "reviewed" }, `${id}-complete`)][index] || complete();
  };
  const writer = await new DatasetWriter(path.join(root, "pilot-output")).initialize(); const builder = new DatasetBuilder({ writer, workspaceFactory: new WorkspaceFactory({ baseDir: source.baseDir }), harness: new AgentHarness({ transport }), agentConfig: { providerId: "mock", model: "mock-model", provider: { id: "mock", baseURL: "https://invalid", supportsTools: true, requiresApiKey: false } } }); const samples = await builder.build(source.tasks);
  assert.deepEqual(samples.map((sample) => sample.outcome), ["validated_success", "failed_validation", "validated_success"]); assert.equal(samples.every((sample) => sample.trajectory.length > 0), true); const lines = (await fs.readFile(writer.filePath, "utf8")).trim().split("\n").map(JSON.parse); assert.equal(lines.length, 3); assert.equal(new Set(lines.map((line) => line.sampleId)).size, 3); assert.equal(lines.every((line) => line.validation && !JSON.stringify(line).includes(root)), true);
}));
