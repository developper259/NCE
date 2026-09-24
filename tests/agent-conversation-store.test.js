const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");
const { AgentConversationStore } = require("../dist/ts/manager/AgentConversationStore.js");

const AgentSidebar = loadGlobal("src/js/sidebar/Agent.Sidebar.js", "AgentSidebar", {
  Sidebar: class Sidebar {},
});

function fakeSafeStorage({ available = true, backend = "keychain" } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.from(`wrapped:${text}`),
    decryptString: (buffer) => {
      const value = buffer.toString();
      if (!value.startsWith("wrapped:")) throw new Error("bad wrapped key");
      return value.slice(8);
    },
  };
}

function snapshot(id, content = "SUPER_PRIVATE_MESSAGE_123") {
  return {
    version: 1,
    id,
    title: "PRIVATE_CONVERSATION_TITLE",
    createdAt: 1,
    updatedAt: 2,
    apiKey: "sk-private-key-123456",
    messages: [
      { role: "user", content, streaming: true },
      { type: "assistant", role: "agent", content: "Partial private response", streaming: true },
      { type: "activity", role: "activity", status: "running", items: [
        { type: "tool", title: "Running tests", status: "running", args: { code: "PRIVATE_ARGS" } },
        { type: "approval", title: "Allow execution?", status: "pending", approvalId: "approval-secret" },
      ] },
    ],
    usage: { runs: 3, userMessages: 1, modelRequests: 2, requestKeys: ["request-id"] },
    draft: "DO_NOT_PERSIST_DRAFT",
    queue: ["DO_NOT_PERSIST_QUEUE"],
  };
}

async function createStore(options) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-agent-store-"));
  const store = new AgentConversationStore(root, options || fakeSafeStorage());
  await store.initialize();
  return { root, store, restart: async () => {
    const next = new AgentConversationStore(root, options || fakeSafeStorage());
    await next.initialize();
    return next;
  } };
}

test("AgentConversationStore encrypts global conversation snapshots and restores runtime-safe data", async () => {
  const { root, store, restart } = await createStore();
  try {
    assert.equal(store.getStatus().available, true);
    await store.save(snapshot("session-a"));
    await store.setActive("session-a");
    const files = [];
    async function scan(dir) {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await scan(file);
        else files.push(await fsp.readFile(file));
      }
    }
    await scan(store.root);
    const disk = Buffer.concat(files).toString();
    for (const secret of ["SUPER_PRIVATE_MESSAGE_123", "PRIVATE_CONVERSATION_TITLE", "sk-private-key-123456", "PRIVATE_ARGS", "DO_NOT_PERSIST_DRAFT"]) {
      assert.equal(disk.includes(secret), false, `plaintext leaked: ${secret}`);
    }
    const keyEnvelope = await fsp.readFile(path.join(store.root, "master-key.json"), "utf8");
    assert.equal(keyEnvelope.includes("wrapped:"), false);
    const encryptedKey = JSON.parse(keyEnvelope).encryptedKey;
    const rawKeyBase64 = Buffer.from(fakeSafeStorage().decryptString(Buffer.from(encryptedKey, "base64")), "base64").toString("base64");
    assert.equal(disk.includes(rawKeyBase64), false, "raw AES key leaked");
    assert.equal(store.root, path.join(root, "agent-conversations"));
    assert.equal(await fsp.stat(path.join(root, ".nce")).catch(() => null), null);
    const restored = await restart();
    const loaded = await restored.load();
    assert.deepEqual(loaded.sessionIds, ["session-a"]);
    assert.equal(loaded.activeSessionId, "session-a");
    assert.equal(loaded.sessions[0].messages[0].content, "SUPER_PRIVATE_MESSAGE_123");
    assert.equal(loaded.sessions[0].messages[1].streaming, false);
    assert.equal(loaded.sessions[0].messages[2].status, "cancelled");
    assert.equal(loaded.sessions[0].messages[2].items.some((item) => item.type === "approval"), false);
    assert.equal(loaded.sessions[0].usage.runs, 3);
    assert.equal("requestKeys" in loaded.sessions[0].usage, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("AgentConversationStore rejects tampered ciphertext and keeps other sessions loadable", async () => {
  const { root, store, restart } = await createStore();
  try {
    await store.save(snapshot("good-a", "good content"));
    await store.save(snapshot("bad-b", "bad content"));
    const file = path.join(store.sessionsRoot, "bad-b.enc");
    const envelope = JSON.parse(await fsp.readFile(file, "utf8"));
    envelope.tag = Buffer.alloc(16, 0).toString("base64");
    await fsp.writeFile(file, JSON.stringify(envelope));
    const loaded = await (await restart()).load();
    assert.deepEqual(loaded.sessionIds, ["good-a"]);
    assert.equal(loaded.sessions[0].messages[0].content, "good content");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("AgentConversationStore refuses plaintext backends without creating conversation files", async () => {
  for (const storage of [fakeSafeStorage({ available: false }), fakeSafeStorage({ backend: "basic_text" })]) {
    const { root, store } = await createStore(storage);
    try {
      assert.equal(store.getStatus().available, false);
      assert.equal(await store.save(snapshot("session-a")), false);
      assert.equal(await fsp.stat(store.root).catch(() => null), null);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  }
});

test("AgentConversationStore serializes concurrent saves, rejects traversal IDs, and deletes sessions", async () => {
  const { root, store, restart } = await createStore();
  try {
    assert.equal(await store.save(snapshot("../../agent-secrets.json")), false);
    await Promise.all([
      store.save(snapshot("session-a", "version A")),
      store.save(snapshot("session-a", "version B")),
      store.save(snapshot("session-a", "version C")),
    ]);
    assert.equal((await (await restart()).load()).sessions[0].messages[0].content, "version C");
    assert.equal(await store.delete("session-a"), true);
    assert.equal((await (await restart()).load()).sessions.length, 0);
    assert.equal(await fsp.stat(path.join(store.sessionsRoot, "session-a.enc")).catch(() => null), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("AgentConversationStore preserves the prior encrypted session after an atomic write failure", async () => {
  const { root, store, restart } = await createStore();
  try {
    await store.save(snapshot("atomic-session", "durable version"));
    const file = path.join(store.sessionsRoot, "atomic-session.enc");
    const previous = await fsp.readFile(file, "utf8");
    const base = fsp;
    store.filesystem = new Proxy(base, {
      get(target, property) {
        if (property === "open") return async (filePath, ...args) => {
          const handle = await base.open(filePath, ...args);
          if (String(filePath).endsWith(".tmp")) {
            return {
              writeFile: async () => { throw new Error("simulated disk error"); },
              sync: handle.sync.bind(handle),
              close: handle.close.bind(handle),
            };
          }
          return handle;
        };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(store.save(snapshot("atomic-session", "must not replace")));
    assert.equal(await fsp.readFile(file, "utf8"), previous);
    assert.equal((await (await restart()).load()).sessions[0].messages[0].content, "durable version");
    assert.equal((await fsp.readdir(store.sessionsRoot)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("AgentConversationStore does not replace the master key when encrypted data already exists", async () => {
  const { root, store, restart } = await createStore();
  try {
    await store.save(snapshot("keep-session", "must remain encrypted"));
    const sessionFile = path.join(store.sessionsRoot, "keep-session.enc");
    const before = await fsp.readFile(sessionFile, "utf8");
    await fsp.rm(path.join(store.root, "master-key.json"));
    const unavailable = await restart();
    assert.equal(unavailable.getStatus().available, false);
    assert.equal(await fsp.readFile(sessionFile, "utf8"), before);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("AgentConversationStore does not rewrite the index for each conversation checkpoint", async () => {
  const { root, store } = await createStore();
  try {
    let indexWrites = 0;
    const base = fsp;
    store.filesystem = new Proxy(base, {
      get(target, property) {
        if (property === "rename") return async (from, to) => {
          if (String(to).endsWith("index.enc")) indexWrites++;
          return base.rename(from, to);
        };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await store.save(snapshot("checkpoint-session", "first"));
    await store.save(snapshot("checkpoint-session", "second"));
    await store.save(snapshot("checkpoint-session", "third"));
    assert.equal(indexWrites, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("AgentConversationStore keeps global session order and active selection across workspace changes", async () => {
  const { root, store, restart } = await createStore();
  try {
    for (const id of ["conversation-a", "conversation-b", "conversation-c"]) {
      await store.save(snapshot(id, id));
    }
    await store.setActive("conversation-b");
    const workspaceA = path.join(root, "project-a");
    const workspaceB = path.join(root, "project-b");
    await fsp.mkdir(workspaceA);
    await fsp.mkdir(workspaceB);
    const afterSwitch = await (await restart()).load();
    assert.deepEqual(afterSwitch.sessionIds, ["conversation-a", "conversation-b", "conversation-c"]);
    assert.equal(afterSwitch.activeSessionId, "conversation-b");
    assert.equal(await fsp.stat(path.join(workspaceA, ".nce")).catch(() => null), null);
    assert.equal(await fsp.stat(path.join(workspaceB, ".nce")).catch(() => null), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("AgentSidebar rehydrates persisted messages without restoring runtime or action state", () => {
  const sidebar = Object.create(AgentSidebar.prototype);
  const restored = sidebar.rehydratePersistedSession({
    version: 1,
    id: "session-restart",
    title: "Restarted chat",
    createdAt: 10,
    updatedAt: 20,
    messages: [
      { role: "user", content: "hello" },
      { role: "agent", type: "assistant", content: "partial", streaming: true },
      { role: "activity", type: "activity", status: "cancelled", items: [] },
    ],
    usage: { runs: 1 },
  });
  assert.equal(restored.isGenerating, false);
  assert.equal(restored.runId, null);
  assert.equal(restored.abortController, null);
  assert.equal(restored.pendingTimeout, null);
  assert.equal(restored.queue.length, 0);
  assert.equal(restored.draft, "");
  assert.equal(restored.streamingMessage, null);
  assert.equal(restored.changes.length, 0);
  assert.equal(restored.currentSegment, null);
  assert.equal(restored.messages[1].streaming, false);
  assert.equal(restored.manualContext.length, 0);
  assert.equal(restored.manualContextSnapshot, null);
  assert.equal(restored.segments[0], restored.messages[1]);
  assert.equal(restored.segments[1], restored.messages[2]);
  assert.equal(restored.usage.requestKeys instanceof Set, true);
});

test("AgentSidebar does not persist manual context descriptors or their contents", () => {
  const sidebar = Object.create(AgentSidebar.prototype);
  const session = {
    id: "manual-context-session", title: "Private context", createdAt: 1,
    messages: [{ role: "user", content: "hello", manualContextItems: [{ type: "file", label: "DISPLAY_ONLY_FILE" }] }],
    manualContext: [{ type: "selection", content: "SECRET_CONTEXT_CONTENT", absolutePath: "/private/file.js" }],
    manualContextSnapshot: { items: [{ content: "SECRET_CONTEXT_CONTENT" }] },
    usage: {},
  };
  const persisted = sidebar.serializeSessionForPersistence(session);
  const text = JSON.stringify(persisted);
  assert.equal(text.includes("manualContext"), false);
  assert.equal(text.includes("DISPLAY_ONLY_FILE"), false);
  assert.equal(text.includes("SECRET_CONTEXT_CONTENT"), false);
  assert.equal(text.includes("/private/file.js"), false);
});
