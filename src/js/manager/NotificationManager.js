const NOTIFICATION_TYPES = Object.freeze(["success", "error", "warning", "info"]);

const NOTIFICATION_DEFAULT_DURATIONS = Object.freeze({
  success: 4000,
  info: 5000,
  warning: 6000,
  error: 7000,
});

const NOTIFICATION_CONFIG = Object.freeze({
  maxVisible: 4,
  historyLimit: 100,
  dedupe: true,
  dedupeWindowMs: 4000,
  minDurationMs: 1000,
  maxDurationMs: 60000,
  titleLimit: 200,
  messageLimit: 2000,
  sourceLimit: 120,
  maxActions: 3,
  actionLabelLimit: 40,
  maxCount: 999,
  storageKey: "nce.notifications.history.v1",
  storageVersion: 1,
  persistDelayMs: 300,
});

class NotificationManager {
  static TYPES = NOTIFICATION_TYPES;
  static DEFAULT_DURATIONS = NOTIFICATION_DEFAULT_DURATIONS;

  constructor(options = {}) {
    this.config = {
      ...NOTIFICATION_CONFIG,
      ...Object.fromEntries(
        Object.entries(options).filter(([key]) =>
          key in NOTIFICATION_CONFIG && key !== "storageKey"),
      ),
    };
    this.config.storageKey = typeof options.storageKey === "string" && options.storageKey
      ? options.storageKey
      : NOTIFICATION_CONFIG.storageKey;
    this.durations = this.normalizeDurations(options.durations);
    this.storage = options.storage !== undefined
      ? options.storage
      : this.resolveStorage();
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.listeners = new Set();
    this.notifications = [];
    this.visibleIds = [];
    this.pendingIds = [];
    this.timers = new Map();
    this.runningActions = new Set();
    this.idCounter = 0;
    this.persistTimer = null;
    this.destroyed = false;
    this.onBeforeUnload = () => this.flushPersist();
    if (typeof window !== "undefined" && typeof window.addEventListener === "function")
      window.addEventListener("beforeunload", this.onBeforeUnload);
    this.loadHistory();
  }

  success(title, message, options = {}) {
    return this.notify({ ...options, type: "success", title, message });
  }

  error(title, message, options = {}) {
    return this.notify({ ...options, type: "error", title, message });
  }

  warning(title, message, options = {}) {
    return this.notify({ ...options, type: "warning", title, message });
  }

  info(title, message, options = {}) {
    return this.notify({ ...options, type: "info", title, message });
  }

  notify(options) {
    if (this.destroyed || !options || typeof options !== "object") return null;
    const type = NOTIFICATION_TYPES.includes(options.type) ? options.type : null;
    const title = typeof options.title === "string" ? options.title.trim() : "";
    if (!type || !title || title.length > this.config.titleLimit) return null;
    const message = typeof options.message === "string"
      ? options.message.trim().slice(0, this.config.messageLimit)
      : "";
    const persistent = options.persistent === true;
    const source = typeof options.source === "string"
      ? options.source.trim().slice(0, this.config.sourceLimit)
      : "";
    const actions = this.normalizeActions(options.actions);
    const timestamp = this.now();

    if (this.config.dedupe !== false &&
        options.dedupe !== false &&
        actions.length === 0) {
      const duplicate = this.findDuplicate(type, title, message, source, timestamp);
      if (duplicate) {
        duplicate.timestamp = timestamp;
        duplicate.count = Math.min(this.config.maxCount, duplicate.count + 1);
        duplicate.read = false;
        this.enqueueToast(duplicate);
        this.emit("updated", duplicate);
        this.schedulePersist();
        return this.snapshot(duplicate);
      }
    }

    const notification = {
      id: this.createId(),
      type,
      title,
      message,
      timestamp,
      read: false,
      persistent,
      duration: persistent ? 0 : this.normalizeDuration(options.duration, type),
      source,
      count: 1,
      actions,
    };
    this.notifications.unshift(notification);
    this.trimHistory();
    this.enqueueToast(notification);
    this.emit("added", notification);
    this.schedulePersist();
    return this.snapshot(notification);
  }

  dismiss(id) {
    if (typeof id !== "string") return false;
    const notification = this.findById(id);
    if (!notification) return false;
    const visible = this.visibleIds.includes(id);
    const pending = this.pendingIds.includes(id);
    if (!visible && !pending) return false;
    this.clearToastState(id);
    this.emit("toast-dismissed", notification);
    this.pumpToasts();
    return true;
  }

  clear() {
    if (this.visibleIds.length === 0 && this.pendingIds.length === 0) return false;
    for (const id of [...this.visibleIds, ...this.pendingIds]) this.clearTimer(id);
    this.visibleIds = [];
    this.pendingIds = [];
    this.emit("toasts-cleared", null);
    return true;
  }

  clearHistory() {
    if (this.notifications.length === 0) return false;
    for (const notification of this.notifications) this.clearTimer(notification.id);
    this.visibleIds = [];
    this.pendingIds = [];
    this.notifications = [];
    this.emit("cleared", null);
    this.schedulePersist();
    return true;
  }

  remove(id) {
    const index = this.notifications.findIndex((notification) => notification.id === id);
    if (index < 0) return false;
    const [notification] = this.notifications.splice(index, 1);
    this.clearToastState(id);
    this.emit("removed", notification);
    this.pumpToasts();
    this.schedulePersist();
    return true;
  }

  markAsRead(id) {
    const notification = this.findById(id);
    if (!notification || notification.read) return false;
    notification.read = true;
    this.emit("read", notification);
    this.schedulePersist();
    return true;
  }

  markAllAsRead() {
    let changed = 0;
    for (const notification of this.notifications) {
      if (notification.read) continue;
      notification.read = true;
      changed += 1;
    }
    if (!changed) return 0;
    this.emit("read-all", null);
    this.schedulePersist();
    return changed;
  }

  getNotifications() {
    return this.notifications.map((notification) => this.snapshot(notification));
  }

  getToasts() {
    return this.visibleIds.flatMap((id) => {
      const notification = this.findById(id);
      return notification ? [this.snapshot(notification)] : [];
    });
  }

  getUnreadCount() {
    let unread = 0;
    for (const notification of this.notifications) {
      if (!notification.read) unread += 1;
    }
    return unread;
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pauseTimer(id) {
    const timer = this.timers.get(id);
    if (!timer || !timer.timeout) return false;
    clearTimeout(timer.timeout);
    timer.timeout = null;
    timer.remaining = Math.max(0, timer.remaining - (this.now() - timer.startedAt));
    return true;
  }

  resumeTimer(id) {
    const timer = this.timers.get(id);
    if (!timer || timer.timeout) return false;
    if (timer.remaining <= 0) {
      this.dismiss(id);
      return true;
    }
    this.startTimerRecord(id, timer.remaining);
    return true;
  }

  async executeAction(id, index) {
    const notification = this.findById(id);
    const action = notification?.actions[index];
    if (!notification || !action) return false;
    const key = `${id}:${index}`;
    if (this.runningActions.has(key)) return false;
    this.runningActions.add(key);
    this.markAsRead(id);
    this.pauseTimer(id);
    try {
      await action.action();
      this.runningActions.delete(key);
      if (this.findById(id)) this.dismiss(id);
      return true;
    } catch (error) {
      this.runningActions.delete(key);
      console.error("[Notifications] Notification action failed", error);
      this.resumeTimer(id);
      this.emit("action-error", notification);
      return false;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.flushPersist();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function")
      window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.onBeforeUnload = null;
    this.destroyed = true;
    for (const timer of this.timers.values()) clearTimeout(timer.timeout);
    this.timers.clear();
    this.visibleIds = [];
    this.pendingIds = [];
    this.listeners.clear();
  }

  snapshot(notification) {
    return {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      timestamp: notification.timestamp,
      read: notification.read,
      persistent: notification.persistent,
      duration: notification.duration,
      source: notification.source,
      count: notification.count,
      actions: notification.actions.map((action) => ({ label: action.label })),
    };
  }

  emit(type, notification) {
    if (this.listeners.size === 0) return;
    const event = {
      type,
      notification: notification ? this.snapshot(notification) : null,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[Notifications] Subscriber failed", error);
      }
    }
  }

  findById(id) {
    return this.notifications.find((notification) => notification.id === id) || null;
  }

  createId() {
    let id;
    do {
      this.idCounter += 1;
      id = `nce-${this.now().toString(36)}-${this.idCounter.toString(36)}`;
    } while (this.findById(id));
    return id;
  }

  normalizeDurations(durations) {
    const result = { ...NOTIFICATION_DEFAULT_DURATIONS };
    if (!durations || typeof durations !== "object") return result;
    for (const type of NOTIFICATION_TYPES) {
      const value = durations[type];
      if (Number.isSafeInteger(value) && value >= 1 && value <= 60000) result[type] = value;
    }
    return result;
  }

  normalizeDuration(value, type) {
    if (!Number.isSafeInteger(value)) return this.durations[type];
    if (value < this.config.minDurationMs || value > this.config.maxDurationMs)
      return this.durations[type];
    return value;
  }

  normalizeActions(actions) {
    if (!Array.isArray(actions)) return [];
    const normalized = [];
    for (const action of actions) {
      if (normalized.length >= this.config.maxActions) break;
      if (!action || typeof action !== "object" || typeof action.action !== "function")
        continue;
      const label = typeof action.label === "string" ? action.label.trim() : "";
      if (!label || label.length > this.config.actionLabelLimit) continue;
      normalized.push({ label, action: action.action });
    }
    return normalized;
  }

  findDuplicate(type, title, message, source, timestamp) {
    for (const notification of this.notifications) {
      if (notification.actions.length > 0) continue;
      if (notification.type !== type ||
          notification.title !== title ||
          notification.message !== message ||
          notification.source !== source) continue;
      if (timestamp - notification.timestamp > this.config.dedupeWindowMs) continue;
      return notification;
    }
    return null;
  }

  enqueueToast(notification) {
    if (this.visibleIds.includes(notification.id)) {
      this.restartTimer(notification);
      return;
    }
    if (!this.pendingIds.includes(notification.id))
      this.pendingIds.push(notification.id);
    this.pumpToasts();
  }

  pumpToasts() {
    let changed = false;
    while (
      this.visibleIds.length < this.config.maxVisible &&
      this.pendingIds.length > 0
    ) {
      const id = this.pendingIds.shift();
      if (!this.findById(id)) continue;
      this.visibleIds.push(id);
      this.startTimer(id);
      changed = true;
    }
    if (changed) this.emit("toasts-changed", null);
  }

  startTimer(id) {
    const notification = this.findById(id);
    if (!notification) return;
    this.clearTimer(id);
    if (notification.persistent || notification.duration <= 0) return;
    this.restartTimer(notification);
  }

  restartTimer(notification) {
    this.clearTimer(notification.id);
    if (notification.persistent || notification.duration <= 0) return;
    this.startTimerRecord(notification.id, notification.duration);
  }

  startTimerRecord(id, duration) {
    this.clearTimer(id);
    const timer = {
      timeout: null,
      startedAt: this.now(),
      remaining: duration,
    };
    timer.timeout = setTimeout(() => {
      if (this.timers.get(id) !== timer) return;
      this.timers.delete(id);
      this.dismiss(id);
    }, duration);
    this.timers.set(id, timer);
  }

  clearTimer(id) {
    const timer = this.timers.get(id);
    if (!timer) return;
    if (timer.timeout) clearTimeout(timer.timeout);
    this.timers.delete(id);
  }

  clearToastState(id) {
    this.clearTimer(id);
    this.visibleIds = this.visibleIds.filter((candidate) => candidate !== id);
    this.pendingIds = this.pendingIds.filter((candidate) => candidate !== id);
  }

  trimHistory() {
    while (this.notifications.length > this.config.historyLimit) {
      const removed = this.notifications.pop();
      if (removed) this.clearToastState(removed.id);
    }
  }

  resolveStorage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  }

  loadHistory() {
    if (!this.storage) return;
    let raw;
    try {
      raw = this.storage.getItem(this.config.storageKey);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[Notifications] Ignoring corrupted notification history");
      return;
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.notifications)
        ? parsed.notifications
        : null;
    if (!entries) return;
    const seen = new Set();
    const restored = [];
    for (const entry of entries) {
      if (restored.length >= this.config.historyLimit) break;
      const notification = this.sanitizePersisted(entry, seen);
      if (notification) restored.push(notification);
    }
    restored.sort((left, right) => right.timestamp - left.timestamp);
    this.notifications = restored;
  }

  sanitizePersisted(value, seen) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = typeof value.id === "string" ? value.id : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || seen.has(id)) return null;
    const type = NOTIFICATION_TYPES.includes(value.type) ? value.type : null;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    if (!type || !title || title.length > this.config.titleLimit) return null;
    if (!Number.isSafeInteger(value.timestamp) || value.timestamp < 0) return null;
    seen.add(id);
    return {
      id,
      type,
      title,
      message: typeof value.message === "string"
        ? value.message.slice(0, this.config.messageLimit)
        : "",
      timestamp: value.timestamp,
      read: value.read === true,
      persistent: value.persistent === true,
      duration: Number.isSafeInteger(value.duration) &&
        value.duration >= 0 && value.duration <= this.config.maxDurationMs
        ? value.duration
        : this.durations[type],
      source: typeof value.source === "string"
        ? value.source.slice(0, this.config.sourceLimit)
        : "",
      count: Number.isSafeInteger(value.count) &&
        value.count >= 1 && value.count <= this.config.maxCount
        ? value.count
        : 1,
      actions: [],
    };
  }

  schedulePersist() {
    if (!this.storage || this.destroyed) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.saveHistory();
    }, this.config.persistDelayMs);
  }

  saveHistory() {
    if (!this.storage) return false;
    try {
      const payload = {
        version: NOTIFICATION_CONFIG.storageVersion,
        notifications: this.notifications
          .slice(0, this.config.historyLimit)
          .map((notification) => ({ ...this.snapshot(notification), actions: [] })),
      };
      this.storage.setItem(this.config.storageKey, JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn("[Notifications] Unable to persist notification history", error);
      return false;
    }
  }

  flushPersist() {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.storage) this.saveHistory();
  }
}
