const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const AgentSidebar = loadGlobal(
  "src/js/sidebar/Agent.Sidebar.js",
  "AgentSidebar",
  { Sidebar: class {} },
);

function createSidebar(overrides = {}) {
  const notifications = [];
  const opened = [];
  const sidebar = Object.create(AgentSidebar.prototype);
  Object.assign(sidebar, {
    isOpen: false,
    activeSessionId: "session-1",
    editor: {
      windowActive: true,
      sidebarManager: {
        rightActiveMenu: null,
        openMenu(menuId) { opened.push(menuId); },
      },
      notificationManager: {
        notify(options) {
          notifications.push(options);
          return { id: `notification-${notifications.length}`, ...options };
        },
      },
    },
    retryFailedMessage() {
      sidebar.retried = true;
      return Promise.resolve(true);
    },
    ...overrides,
  });
  return { sidebar, notifications, opened };
}

function sessionWithFailure() {
  const message = {
    role: "agent",
    content: "Rate limit exceeded",
    runId: 7,
    status: "error",
  };
  return {
    message,
    session: {
      id: "session-1",
      messages: [
        { role: "user", content: "Explain this file" },
        { role: "agent", content: "Working", runId: 7 },
        message,
      ],
    },
  };
}

test("Agent notifications fire for a failed background run with retry and open actions", async () => {
  const { sidebar, notifications, opened } = createSidebar();
  const { session, message } = sessionWithFailure();

  sidebar.notifyRunFailure(session, message);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.equal(notifications[0].title, "Agent run failed");
  assert.equal(notifications[0].source, "Agent");
  assert.equal(notifications[0].message, "Rate limit exceeded");
  assert.deepEqual(
    JSON.parse(JSON.stringify(notifications[0].actions.map((action) => action.label))),
    ["Retry", "Open Agent"],
  );

  notifications[0].actions[0].action();
  await new Promise(setImmediate);
  assert.equal(sidebar.retried, true);
  notifications[0].actions[1].action();
  assert.deepEqual(opened, ["agent"]);
});

test("Agent notifications stay silent while the active agent conversation is visible", () => {
  const { sidebar, notifications } = createSidebar();
  const { session, message } = sessionWithFailure();
  sidebar.isOpen = true;
  sidebar.editor.sidebarManager.rightActiveMenu = sidebar;

  assert.equal(sidebar.notifyRunFailure(session, message), null);
  assert.equal(notifications.length, 0);
});

test("Agent notifications fire for a background session even when another agent is visible", () => {
  const { sidebar, notifications } = createSidebar();
  const { session, message } = sessionWithFailure();
  sidebar.isOpen = true;
  sidebar.editor.sidebarManager.rightActiveMenu = sidebar;
  sidebar.activeSessionId = "session-2";

  sidebar.notifyRunFailure(session, message);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
});

test("Agent notifications fire for an approval request while the app is unfocused", () => {
  const { sidebar, notifications, opened } = createSidebar();
  sidebar.isOpen = true;
  sidebar.editor.sidebarManager.rightActiveMenu = sidebar;
  sidebar.editor.windowActive = false;

  sidebar.notifyApprovalNeeded({
    title: "Permission required",
    detail: "The agent wants to run a command.",
  }, { id: "session-1" });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.equal(notifications[0].title, "Agent needs your approval");
  assert.equal(notifications[0].message, "The agent wants to run a command.");
  assert.equal(notifications[0].source, "Agent");
  notifications[0].actions[0].action();
  assert.deepEqual(opened, ["agent"]);
});

test("Agent notifications skip approval requests for the focused active conversation", () => {
  const { sidebar, notifications } = createSidebar();
  sidebar.isOpen = true;
  sidebar.editor.sidebarManager.rightActiveMenu = sidebar;

  assert.equal(
    sidebar.notifyApprovalNeeded({ title: "Permission", detail: "Run?" }, { id: "session-1" }),
    null,
  );
  assert.equal(notifications.length, 0);
});

test("Agent conversation save failures produce a warning notification", async () => {
  const { sidebar, notifications } = createSidebar({
    conversationPersistenceReady: true,
    conversationSaveTimers: new Map(),
    conversationSaveQueues: new Map(),
    serializeSessionForPersistence() {
      return { id: "session-1" };
    },
    editor: {
      windowActive: true,
      sidebarManager: { rightActiveMenu: null, openMenu() {} },
      api: {
        async saveAgentConversation() {
          return false;
        },
      },
      notificationManager: {
        notify(options) {
          notifications.push(options);
          return { id: `notification-${notifications.length}`, ...options };
        },
      },
    },
  });

  sidebar.scheduleConversationSave({ id: "session-1", updatedAt: 0 }, true);
  await new Promise(setImmediate);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.equal(notifications[0].title, "Agent conversation not saved");
  assert.equal(notifications[0].source, "Agent");
});
