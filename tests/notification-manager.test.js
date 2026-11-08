const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const quietConsole = { ...console, warn() {}, error() {} };
const NotificationManager = loadGlobal(
  "src/js/manager/NotificationManager.js",
  "NotificationManager",
  { console: quietConsole },
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (value) => JSON.parse(JSON.stringify(value));

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

function createManager(options = {}) {
  return new NotificationManager({
    storage: createStorage(),
    minDurationMs: 1,
    ...options,
  });
}

test("NotificationManager creates the four types with their default durations", () => {
  const manager = createManager();
  try {
    const success = manager.success("Saved", "The file was saved.");
    const error = manager.error("Failed", "The operation failed.");
    const warning = manager.warning("Careful", "This may be slow.");
    const info = manager.info("Heads up", "A new version is available.");

    assert.deepEqual(
      plain([success.type, error.type, warning.type, info.type]),
      ["success", "error", "warning", "info"],
    );
    assert.deepEqual(
      plain([
        success.duration,
        error.duration,
        warning.duration,
        info.duration,
      ]),
      [4000, 7000, 6000, 5000],
    );
    assert.equal(manager.getNotifications().length, 4);
    assert.equal(manager.getUnreadCount(), 4);
    assert.equal(new Set(manager.getNotifications().map((item) => item.id)).size, 4);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager validates malformed input without throwing", () => {
  const manager = createManager();
  try {
    assert.equal(manager.notify(null), null);
    assert.equal(manager.notify({ type: "unknown", title: "Title" }), null);
    assert.equal(manager.notify({ type: "info", title: "   " }), null);
    assert.equal(manager.notify({ type: "info", title: "x".repeat(201) }), null);

    const action = () => {};
    const created = manager.notify({
      type: "info",
      title: "Valid",
      message: 42,
      duration: 0,
      actions: [
        { label: "Retry", action },
        { label: "", action },
        { label: "No function" },
        { label: "Open", action },
        { label: "Details", action },
      ],
    });
    assert.equal(created.type, "info");
    assert.equal(created.message, "", "a non-string message is ignored");
    assert.equal(created.duration, 5000, "an invalid duration falls back to the type default");
    assert.deepEqual(
      plain(created.actions.map((item) => item.label)),
      ["Retry", "Open", "Details"],
      "only valid actions within the limit are kept",
    );
    assert.equal(manager.getNotifications().length, 1);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager expires temporary toasts but keeps their history", async () => {
  const manager = createManager({ durations: { success: 30 } });
  try {
    manager.success("Saved");
    assert.equal(manager.getToasts().length, 1);
    assert.equal(manager.timers.size, 1, "a timer is scheduled for the toast");
    await delay(90);
    assert.equal(manager.getToasts().length, 0);
    assert.equal(manager.getNotifications().length, 1);
    assert.equal(manager.getUnreadCount(), 1, "an expired toast stays unread");
    assert.equal(manager.timers.size, 0);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager keeps persistent notifications visible", async () => {
  const manager = createManager({ durations: { error: 20 } });
  try {
    manager.error("Offline", "The remote is unreachable.", { persistent: true });
    await delay(70);
    assert.equal(manager.getToasts().length, 1);
    assert.equal(manager.getNotifications()[0].persistent, true);
    assert.equal(manager.getNotifications()[0].duration, 0);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager distinguishes dismiss, clear, and clearHistory", () => {
  const manager = createManager();
  try {
    const first = manager.success("First");
    manager.info("Second");
    assert.equal(manager.dismiss(first.id), true);
    assert.equal(manager.getToasts().length, 1);
    assert.equal(manager.getNotifications().length, 2, "dismiss keeps the history");
    assert.equal(manager.getUnreadCount(), 2);

    assert.equal(manager.clear(), true);
    assert.equal(manager.getToasts().length, 0);
    assert.equal(manager.getNotifications().length, 2, "clear keeps the history");

    assert.equal(manager.clearHistory(), true);
    assert.equal(manager.getNotifications().length, 0);
    assert.equal(manager.getUnreadCount(), 0);
    assert.equal(manager.clearHistory(), false);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager marks notifications as read", () => {
  const manager = createManager();
  try {
    const first = manager.success("First");
    manager.info("Second");
    manager.warning("Third");
    assert.equal(manager.markAsRead(first.id), true);
    assert.equal(manager.markAsRead(first.id), false);
    assert.equal(manager.getUnreadCount(), 2);
    assert.equal(manager.markAllAsRead(), 2);
    assert.equal(manager.getUnreadCount(), 0);
    assert.equal(manager.markAllAsRead(), 0);
    assert.equal(manager.getNotifications().every((item) => item.read), true);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager notifies subscribers until they unsubscribe", () => {
  const manager = createManager();
  const events = [];
  try {
    const unsubscribe = manager.subscribe((event) => events.push(event.type));
    const created = manager.success("Saved");
    manager.dismiss(created.id);
    assert.deepEqual(events, ["toasts-changed", "added", "toast-dismissed"]);
    unsubscribe();
    manager.info("Another");
    assert.equal(events.length, 3);
    assert.equal(
      manager.subscribe(null)(),
      undefined,
      "invalid subscribers return a safe unsubscribe",
    );
  } finally {
    manager.destroy();
  }
});

test("NotificationManager limits visible toasts and drains queued notifications", () => {
  const manager = createManager({ maxVisible: 2 });
  try {
    const first = manager.info("First");
    const second = manager.info("Second");
    const third = manager.info("Third", "", { persistent: true });
    assert.deepEqual(
      plain(manager.getToasts().map((item) => item.id)),
      [first.id, second.id],
    );
    assert.equal(manager.getNotifications().length, 3);

    manager.dismiss(first.id);
    assert.deepEqual(
      plain(manager.getToasts().map((item) => item.id)),
      [second.id, third.id],
      "the queued persistent notification takes the freed slot",
    );
    assert.equal(manager.getNotifications().length, 3);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager deduplicates identical notifications inside the window", () => {
  let now = 1_000;
  const manager = createManager({
    now: () => now,
    dedupeWindowMs: 50,
    durations: { info: 10_000, error: 10_000 },
  });
  try {
    const action = () => {};
    const first = manager.info("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
    });
    now += 10;
    const duplicate = manager.info("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.count, 2);
    assert.equal(manager.getNotifications().length, 1);

    const plainAgain = manager.info("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
    });
    assert.equal(plainAgain.id, first.id);
    assert.equal(plainAgain.count, 3);

    const withActionAfterPlain = manager.info("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
      actions: [{ label: "Retry", action }],
    });
    assert.notEqual(
      withActionAfterPlain.id,
      first.id,
      "a new action prevents deduplication against a plain notification",
    );

    now += 100;
    const later = manager.info("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
    });
    assert.notEqual(later.id, first.id);
    assert.equal(manager.getNotifications().length, 3);

    const withAction = manager.error("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
      actions: [{ label: "Retry", action }],
    });
    now += 10;
    const actionDuplicate = manager.error("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
      actions: [{ label: "Retry", action }],
    });
    assert.notEqual(
      actionDuplicate.id,
      withAction.id,
      "notifications with actions are never merged",
    );

    const optedOut = manager.info("Sync failed", "Network timeout", {
      source: "Git",
      duration: 10_000,
      dedupe: false,
    });
    assert.notEqual(optedOut.id, first.id);

    const disabledManager = createManager({
      storage: createStorage(),
      dedupe: false,
      now: () => now,
      durations: { info: 10_000 },
    });
    try {
      const a = disabledManager.info("Repeated", "", { duration: 10_000 });
      const b = disabledManager.info("Repeated", "", { duration: 10_000 });
      assert.notEqual(a.id, b.id, "dedupe can be disabled globally");
    } finally {
      disabledManager.destroy();
    }
  } finally {
    manager.destroy();
  }
});

test("NotificationManager enforces the history limit from the oldest entry", () => {
  const manager = createManager({ historyLimit: 2 });
  try {
    const first = manager.info("First");
    const second = manager.info("Second");
    const third = manager.info("Third");
    assert.deepEqual(
      plain(manager.getNotifications().map((item) => item.id)),
      [third.id, second.id],
    );
    assert.equal(
      manager.getToasts().some((item) => item.id === first.id),
      false,
      "a trimmed notification cannot keep a toast",
    );
    assert.equal(manager.getNotifications().length, 2);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager persists history without actions and restores read state", () => {
  const storage = createStorage();
  const firstManager = new NotificationManager({ storage, minDurationMs: 1 });
  const first = firstManager.success("Saved", "Done.", {
    source: "Editor",
    actions: [{ label: "Open", action: () => {} }],
  });
  firstManager.error("Failed", "Nope.");
  firstManager.markAsRead(first.id);
  firstManager.destroy();

  const raw = storage.getItem("nce.notifications.history.v1");
  assert.match(raw, /"version":1/);
  assert.doesNotMatch(raw, /"label"/, "action labels are not persisted");
  assert.doesNotMatch(raw, /function/i);

  const secondManager = new NotificationManager({ storage });
  try {
    const restored = secondManager.getNotifications();
    assert.equal(restored.length, 2);
    const restoredFirst = restored.find((item) => item.id === first.id);
    assert.equal(restoredFirst.read, true);
    assert.deepEqual(plain(restoredFirst.actions), []);
    assert.equal(secondManager.getToasts().length, 0);
  } finally {
    secondManager.destroy();
  }
});

test("NotificationManager survives corrupted, invalid, and unavailable storage", () => {
  const corrupted = createStorage({ "nce.notifications.history.v1": "{not json" });
  const corruptedManager = new NotificationManager({ storage: corrupted });
  try {
    assert.equal(corruptedManager.getNotifications().length, 0);
    assert.ok(corruptedManager.info("Still", "works"));
  } finally {
    corruptedManager.destroy();
  }

  const invalid = createStorage({
    "nce.notifications.history.v1": JSON.stringify({
      version: 1,
      notifications: [
        { id: "valid-1", type: "info", title: "Valid", timestamp: 1 },
        { id: "valid-1", type: "info", title: "Duplicate id", timestamp: 2 },
        { id: "bad", type: "nope", title: "Bad type", timestamp: 3 },
        { id: "bad-title", type: "info", title: "", timestamp: 4 },
        { id: "../escape", type: "info", title: "Bad id", timestamp: 5 },
        { id: "valid-2", type: "success", title: "Second", timestamp: 6, read: true },
      ],
    }),
  });
  const invalidManager = new NotificationManager({ storage: invalid });
  try {
    assert.deepEqual(
      plain(invalidManager.getNotifications().map((item) => item.id)),
      ["valid-2", "valid-1"],
    );
    assert.equal(invalidManager.getUnreadCount(), 1);
  } finally {
    invalidManager.destroy();
  }

  const failing = {
    getItem() { throw new Error("unavailable"); },
    setItem() { throw new Error("unavailable"); },
  };
  const failingManager = new NotificationManager({ storage: failing, minDurationMs: 1 });
  try {
    assert.ok(failingManager.warning("Memory only"));
    assert.equal(failingManager.getNotifications().length, 1);
    failingManager.destroy();
  } catch (error) {
    failingManager.destroy();
    throw error;
  }
});

test("NotificationManager runs actions once and reports failures", async () => {
  const manager = createManager({ durations: { info: 10_000 } });
  try {
    let calls = 0;
    const created = manager.info("Action", "", {
      duration: 10_000,
      actions: [{ label: "Retry", action: async () => { calls += 1; } }],
    });
    assert.equal(await manager.executeAction(created.id, 0), true);
    assert.equal(calls, 1);
    assert.equal(manager.getToasts().length, 0, "a successful action dismisses the toast");
    assert.equal(manager.getNotifications()[0].read, true);
    assert.equal(manager.getNotifications().length, 1);

    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const slow = manager.info("Slow", "", {
      duration: 10_000,
      actions: [{ label: "Run", action: () => pending }],
    });
    const firstRun = manager.executeAction(slow.id, 0);
    assert.equal(await manager.executeAction(slow.id, 0), false, "double clicks are ignored");
    release();
    assert.equal(await firstRun, true);

    const events = [];
    manager.subscribe((event) => events.push(event.type));
    const failing = manager.error("Broken", "", {
      duration: 10_000,
      actions: [{ label: "Fail", action: async () => { throw new Error("boom"); } }],
    });
    assert.equal(await manager.executeAction(failing.id, 0), false);
    assert.equal(manager.getToasts().some((item) => item.id === failing.id), true);
    assert.equal(manager.getNotifications().find((item) => item.id === failing.id).read, true);
    assert.ok(events.includes("action-error"));
    assert.equal(await manager.executeAction("missing", 0), false);
    assert.equal(await manager.executeAction(failing.id, 3), false);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager pauses and resumes toast timers", async () => {
  const manager = createManager({ durations: { info: 60 } });
  try {
    const created = manager.info("Hover");
    assert.equal(manager.pauseTimer(created.id), true);
    await delay(100);
    assert.equal(manager.getToasts().length, 1, "a paused toast does not expire");
    assert.equal(manager.resumeTimer(created.id), true);
    await delay(140);
    assert.equal(manager.getToasts().length, 0);
    assert.equal(manager.getNotifications().length, 1);
  } finally {
    manager.destroy();
  }
});

test("NotificationManager clears timers on dismissal and destruction", async () => {
  const manager = createManager({ durations: { info: 100 } });
  try {
    const created = manager.info("Temporary");
    assert.equal(manager.timers.size, 1);
    manager.dismiss(created.id);
    assert.equal(manager.timers.size, 0);
    manager.info("Second");
    assert.equal(manager.timers.size, 1);
    manager.destroy();
    assert.equal(manager.timers.size, 0);
    await delay(140);
    assert.equal(manager.getToasts().length, 0);
  } finally {
    manager.destroy();
  }
});
