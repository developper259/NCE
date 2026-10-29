const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const AgentStatePresenter = loadGlobal(
  "src/js/agent/AgentStatePresenter.js",
  "AgentStatePresenter",
);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { for (const value of values) this.values.add(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : force === true;
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.classList = new FakeClassList();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this._text = "";
    this.style = {};
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() { return this._text || this.children.map((child) => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  remove() { this.removed = true; }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  click() {
    for (const handler of this.listeners.get("click") || [])
      handler({ stopPropagation() {} });
  }
}

const document = { createElement: (tag) => new FakeElement(tag) };

const AgentSidebar = loadGlobal(
  "src/js/sidebar/Agent.Sidebar.js",
  "AgentSidebar",
  {
    Sidebar: class Sidebar {},
    AgentStatePresenter,
    AgentAI: {
      getProvider: (id) => ({ id, name: "Modal Qwen", requiresApiKey: false }),
    },
    document,
  },
);

function createSidebarSession() {
  return {
    id: "session-1",
    title: "New chat",
    messages: [],
    segments: [],
    queue: [],
    draft: "",
    isGenerating: false,
    runId: null,
    streamingMessage: null,
    workState: null,
    currentSegment: null,
    cancelledRunId: null,
    usage: {
      runs: 0, userMessages: 0, modelRequests: 0, actualPromptTokens: 0,
      estimatedPromptTokens: 0, completedRuns: 0, cancelledRuns: 0,
      failedRuns: 0, requestKeys: new Set(),
    },
  };
}

function createSidebarHarness({ execute } = {}) {
  const session = createSidebarSession();
  const calls = { execute: [], rendered: [], refreshed: 0, saved: 0 };
  const sidebar = Object.assign(Object.create(AgentSidebar.prototype), {
    editor: {
      api: {
        async setAgentApiKey() {},
        async loadAgentConversations() { return { status: { available: true }, sessions: [], activeSessionId: null }; },
      },
      fileExplorer: { rootPath: "/workspace" },
      sidebarManager: { rightScroller: null },
    },
    sessions: [session],
    activeSessionId: session.id,
    currentProviderId: "modalQwen",
    currentModel: "qwen",
    apiKeys: new Map(),
    conversationPersistencePromise: Promise.resolve(),
    apiKeyLoadPromise: Promise.resolve(),
    conversationPersistenceAvailable: true,
    conversationLoadError: null,
    conversationLoadRetrying: false,
    stateCardSequence: 0,
    thinkingStateRow: null,
    messageElements: new Map(),
    activityElements: new Map(),
    workLogElements: new Map(),
    messagesElement: null,
    agent: null,
    ensureInitialized() {},
    getSession(id) { return this.sessions.find((entry) => entry.id === id) || null; },
    getActiveSession() { return this.getSession(this.activeSessionId); },
    refresh() { calls.refreshed += 1; },
    scrollMessagesToBottom() {},
    focusInput() {},
    showLatestConversation() {},
    scheduleConversationSave() { calls.saved += 1; },
    scheduleRestoredBottomScroll() {},
    renameSessionFromContent() {},
    updateSessionInfoPopover() {},
    startAgentWork() {},
    finishActivityGroup() {},
    processQueue() {},
    formatTime() { return "12:00"; },
    renderConversationMessageIfVisible(_session, message) {
      calls.rendered.push(message);
      return true;
    },
    removeThinkingState() {},
    getRunSegment(session, runId, type, create = false, context = {}) {
      const key = context.segmentId || null;
      let segment = session.segments.find((entry) => entry.runId === runId && entry.segmentKey === key);
      if (segment || !create) return segment || null;
      segment = {
        id: `${session.id}:${runId}:${type}:${session.segments.length}`,
        role: "agent",
        type,
        runId,
        segmentKey: key,
        content: "",
        status: "streaming",
      };
      session.segments.push(segment);
      session.messages.push(segment);
      return segment;
    },
  });
  let runCounter = 0;
  sidebar.agent = {
    async execute(content, options) {
      calls.execute.push({ content, options });
      runCounter += 1;
      sidebar.agent.runId = runCounter;
      return execute(content, options, runCounter);
    },
  };
  return { sidebar, session, calls };
}

test("Agent state presenter redacts secrets and normalizes errors", () => {
  assert.equal(
    AgentStatePresenter.redact("api_key=SECRET-123 bearer abcDEF.ghiJKL.mnoPQR sk-live-1234567890"),
    "api_key=[redacted] Bearer [redacted] sk-[redacted]",
  );
  assert.match(
    AgentStatePresenter.redact("Authorization: Bearer abcdefghijklmnop"),
    /Authorization: \[redacted\]/,
  );
  assert.match(
    AgentStatePresenter.redact("token: eyJhbGciOiJIUzI1NiJ9.payloadpart.signaturepart"),
    /\[redacted-token\]/,
  );
  assert.equal(AgentStatePresenter.redact(null), "");
  const long = AgentStatePresenter.redact("x".repeat(5000));
  assert.equal(long.length, AgentStatePresenter.MAX_DETAIL_LENGTH);

  const info = AgentStatePresenter.normalizeError({
    code: "NETWORK_ERROR",
    category: "NETWORK_ERROR",
    userMessage: "Impossible de joindre le fournisseur",
    technicalMessage: "api_key=abc123 failed",
    provider: { id: "openrouter", name: "OpenRouter" },
    statusCode: 502,
    retryable: true,
    failures: [{}, {}],
  });
  assert.equal(info.provider, "OpenRouter");
  assert.equal(info.statusCode, 502);
  assert.equal(info.failureCount, 2);
  assert.equal(info.technicalMessage.includes("abc123"), false);
  assert.equal(info.retryable, true);
});

test("Agent state presenter classifies request failures by known category", () => {
  const auth = AgentStatePresenter.classifyRequestError(
    AgentStatePresenter.normalizeError({
      code: "AUTH_ERROR", category: "AUTH_ERROR", statusCode: 401,
      userMessage: "Clé API invalide", provider: { name: "OpenRouter" },
    }),
    { canRetry: true, providerRequiresKey: true },
  );
  assert.equal(auth.variant, "unavailable");
  assert.match(auth.title, /n'est pas disponible/);
  assert.match(auth.description, /OpenRouter/);
  assert.equal(auth.actions.map((action) => action.id).join(","), "configure,retry");
  assert.ok(auth.details.some((detail) => detail.value === "AUTH_ERROR"));
  assert.ok(auth.details.some((detail) => detail.value === "401"));

  const authWithoutKey = AgentStatePresenter.classifyRequestError(
    { code: "AUTH_ERROR", category: "AUTH_ERROR" },
    { canRetry: false, providerRequiresKey: false },
  );
  assert.equal(authWithoutKey.actions.length, 0);

  const limited = AgentStatePresenter.classifyRequestError(
    { category: "MODEL_RATE_LIMITED", code: "MODEL_RATE_LIMITED" },
    { canRetry: true },
  );
  assert.equal(limited.variant, "warning");
  assert.equal(limited.actions[0].id, "retry");

  const unavailableModel = AgentStatePresenter.classifyRequestError(
    { category: "ALL_MODELS_UNAVAILABLE" },
    { canRetry: true },
  );
  assert.equal(unavailableModel.variant, "unavailable");

  const network = AgentStatePresenter.classifyRequestError(
    { category: "NETWORK_ERROR" },
    { canRetry: true, retrying: true },
  );
  assert.equal(network.variant, "error");
  assert.equal(network.actions[0].disabled, true);
  assert.match(network.actions[0].label, /Nouvelle tentative/);

  const contextTooLong = AgentStatePresenter.classifyRequestError(
    { category: "CONTEXT_LENGTH_EXCEEDED" },
    { canRetry: true },
  );
  assert.equal(contextTooLong.variant, "warning");
  assert.equal(contextTooLong.actions.length, 0);

  const unknown = AgentStatePresenter.classifyRequestError(
    AgentStatePresenter.normalizeError(new Error("boom")),
    { canRetry: true },
  );
  assert.equal(unknown.title, "Une erreur est survenue");
  assert.equal(unknown.actions[0].id, "retry");
});

test("Agent state presenter maps conversation and context failures", () => {
  const insecure = AgentStatePresenter.classifyConversationError({ reason: "INSECURE_STORAGE_BACKEND" });
  assert.equal(insecure.variant, "warning");
  assert.equal(insecure.actions.length, 0);

  const store = AgentStatePresenter.classifyConversationError({ reason: "STORE_ERROR", retrying: true });
  assert.equal(store.actions[0].disabled, true);
  assert.match(store.description, /stockage local/);
  assert.doesNotMatch(store.description, /corrompue|supprimée/);

  const missing = AgentStatePresenter.classifyConversationError({ reason: "NOT_FOUND" });
  assert.equal(missing.variant, "warning");
  assert.match(missing.description, /retrouvée/);

  const context = AgentStatePresenter.classifyContextError({
    reason: "CONTEXT_RESOLVE_FAILED",
    labels: ["src/app.js", "README.md"],
  });
  assert.equal(context.variant, "warning");
  assert.ok(context.details.some((detail) => detail.value.includes("src/app.js")));
  assert.equal(context.actions.length, 0);

  const thinking = AgentStatePresenter.createThinkingState();
  assert.equal(thinking.variant, "loading");
  assert.match(thinking.title, /réfléchit/);
});

test("Agent state card renders accessible actions and real details", () => {
  const { sidebar } = createSidebarHarness({
    execute: async () => { throw new Error("not used"); },
  });
  let retried = 0;
  const spec = AgentStatePresenter.classifyRequestError(
    AgentStatePresenter.normalizeError({
      code: "AUTH_ERROR",
      category: "AUTH_ERROR",
      statusCode: 401,
      userMessage: "Clé invalide",
      technicalMessage: "api_key=super-secret-value",
      provider: { name: "OpenRouter" },
    }),
    { canRetry: true, providerRequiresKey: true },
  );
  const card = sidebar.createAgentStateCard(spec, {
    retry: () => { retried += 1; },
    configure: () => { retried += 10; },
  });
  assert.match(card.className, /agent-state-card/);
  assert.match(card.className, /agent-state-unavailable/);
  assert.equal(card.getAttribute("role"), "alert");
  assert.equal(card.getAttribute("aria-live"), "assertive");
  assert.match(card.textContent, /L'agent n'est pas disponible/);

  const actionRow = card.children[1].children.find((child) =>
    String(child.className).includes("agent-state-actions"));
  const buttons = actionRow.children;
  assert.equal(buttons.length, 2);
  buttons[0].click();
  buttons[1].click();
  assert.equal(retried, 11);

  const detailsToggle = card.children[1].children.find((child) =>
    String(child.className).includes("agent-state-details-toggle"));
  const detailsRegion = card.children[1].children.find((child) =>
    String(child.className).split(/\s+/).includes("agent-state-details"));
  assert.equal(detailsToggle.getAttribute("aria-expanded"), "false");
  assert.equal(detailsRegion.hidden, true);
  assert.doesNotMatch(detailsRegion.textContent, /super-secret-value/);
  assert.match(detailsRegion.textContent, /\[redacted\]/);
  detailsToggle.click();
  assert.equal(detailsToggle.getAttribute("aria-expanded"), "true");
  assert.equal(detailsRegion.hidden, false);
  assert.equal(detailsToggle.textContent, "Masquer les détails");
});

test("Agent send failure keeps the request error structured without secrets", async () => {
  const failure = Object.assign(new Error("Clé API invalide"), {
    name: "AgentModelError",
    code: "AUTH_ERROR",
    category: "AUTH_ERROR",
    statusCode: 401,
    userMessage: "Clé API invalide",
    technicalMessage: "Authorization: Bearer secret-token-value",
    provider: { name: "OpenRouter" },
  });
  const { sidebar, session, calls } = createSidebarHarness({
    execute: async () => { throw failure; },
  });
  await sidebar.sendMessage("Bonjour");
  const errorMessage = session.messages.find((message) => message.hasErrors);
  assert.ok(errorMessage, "the failure must stay in the conversation");
  assert.equal(errorMessage.status, "error");
  assert.equal(errorMessage.errorInfo.code, "AUTH_ERROR");
  assert.equal(errorMessage.errorInfo.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(errorMessage.errorInfo), /secret-token-value/);
  assert.equal(calls.rendered.includes(errorMessage), true);
  assert.equal(session.messages.filter((message) => message.role === "user").length, 1);
});

test("Retrying a failed run reuses the user message and removes the old error", async () => {
  let attempts = 0;
  const { sidebar, session, calls } = createSidebarHarness({
    execute: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("Réseau indisponible");
        error.code = "NETWORK_ERROR";
        error.category = "NETWORK_ERROR";
        throw error;
      }
      return { response: "Réponse valide" };
    },
  });
  await sidebar.sendMessage("Explique ce fichier");
  const errorMessage = session.messages.find((message) => message.hasErrors);
  assert.ok(errorMessage);
  assert.equal(await sidebar.retryFailedMessage(session, errorMessage), true);
  assert.equal(session.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(session.messages.filter((message) => message.hasErrors).length, 0);
  assert.equal(session.messages.some((message) => message.content === "Réponse valide"), true);
  assert.equal(calls.execute.length, 2);
  assert.equal(calls.execute[1].options.history.filter((entry) => entry.role === "user").length, 1);
  assert.equal(calls.execute[1].options.history.some((entry) => entry.content.includes("Réseau indisponible")), false);
  assert.equal(session.usage.runs, 2);
  assert.equal(session.usage.userMessages, 1);
  assert.equal(session.isRetrying, false);
  assert.equal(await sidebar.retryFailedMessage(session, errorMessage), false, "the removed error cannot be retried twice");
});

test("Retry is blocked while a run or another retry is active", async () => {
  const { sidebar, session } = createSidebarHarness({
    execute: async () => { throw new Error("boom"); },
  });
  await sidebar.sendMessage("test");
  const errorMessage = session.messages.find((message) => message.hasErrors);
  session.isGenerating = true;
  assert.equal(await sidebar.retryFailedMessage(session, errorMessage), false);
  session.isGenerating = false;
  session.isRetrying = true;
  assert.equal(await sidebar.retryFailedMessage(session, errorMessage), false);
});

test("Conversation load failure is explicit, retryable, and keeps the active id", async () => {
  let calls = 0;
  const { sidebar, session } = createSidebarHarness({
    execute: async () => ({ response: "ok" }),
  });
  sidebar.editor.api.loadAgentConversations = async () => {
    calls += 1;
    if (calls === 1) throw new Error("storage failed");
    return {
      status: { available: true },
      sessions: [
        { id: "session-1", title: "Kept", createdAt: 1, updatedAt: 2, messages: [] },
        { id: "session-2", title: "Other", createdAt: 3, updatedAt: 4, messages: [] },
      ],
      activeSessionId: "session-2",
    };
  };
  const loaded = await sidebar.loadConversationStore();
  assert.equal(loaded, false);
  assert.equal(sidebar.conversationLoadError.reason, "STORE_ERROR");
  assert.equal(sidebar.activeSessionId, session.id);

  const retried = await sidebar.retryConversationLoad();
  assert.equal(retried, true);
  assert.equal(sidebar.conversationLoadError, null);
  assert.equal(sidebar.activeSessionId, "session-1", "the preserved conversation wins over the stored active id");
  assert.equal(sidebar.sessions.length, 2);

  sidebar.editor.api.loadAgentConversations = async () => ({
    status: { available: false, reason: "INSECURE_STORAGE_BACKEND" },
    sessions: [],
  });
  assert.equal(await sidebar.loadConversationStore(), false);
  assert.equal(sidebar.conversationLoadError.reason, "INSECURE_STORAGE_BACKEND");
});

test("Agent states use the shared design tokens and reduced motion", () => {
  const variables = fs.readFileSync(path.join(root, "src/css/var.css"), "utf8");
  const agentCss = fs.readFileSync(path.join(root, "src/css/sidebar/agent.css"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, "src/js/main/renderer-agent-scripts.json"),
    "utf8",
  ));
  assert.match(variables, /--state-info:\s*var\(--accent-primary\)/);
  assert.match(variables, /--state-warning:\s*var\(--git-conflict\)/);
  assert.match(variables, /--state-error:\s*var\(--git-deleted\)/);
  assert.match(agentCss, /\.agent-state-card\s*\{/);
  assert.match(agentCss, /\.agent-state-unavailable/);
  assert.match(agentCss, /\.agent-state-loading \.agent-state-icon i\s*\{\s*animation:/);
  assert.match(agentCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(agentCss, /\.agent-state-button:focus-visible/);
  assert.ok(manifest.indexOf("js/agent/AgentStatePresenter.js") >= 0);
  assert.ok(
    manifest.indexOf("js/agent/AgentStatePresenter.js") <
    manifest.indexOf("js/sidebar/Agent.Sidebar.js"),
  );
});
