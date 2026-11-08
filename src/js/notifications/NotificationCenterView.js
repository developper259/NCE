const NOTIFICATION_CENTER_ICONS = Object.freeze({
  success: "fi-rr-check",
  error: "fi-rr-cross-circle",
  warning: "fi-rr-triangle-warning",
  info: "fi-rr-info",
});

class NotificationCenterView {
  static formatTimestamp(timestamp, now = Date.now()) {
    const elapsed = Math.max(0, now - timestamp);
    if (elapsed < 60_000) return "Just now";
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    try {
      return new Date(timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    } catch {
      return "";
    }
  }

  constructor(editor, manager, options = {}) {
    this.editor = editor;
    this.manager = manager;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.isOpen = false;
    this.destroyed = false;
    this.previousFocus = null;
    this.focusables = [];
    this.actionErrors = new Map();
    this.onDocumentPointerDown = (event) => this.handleDocumentPointerDown(event);
    this.onDocumentKeyDown = (event) => this.handleDocumentKeyDown(event);

    this.buildBell();
    this.buildCenter();
    this.unsubscribe = manager.subscribe((event) => this.handleManagerEvent(event));
    this.updateBadge();

    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
  }

  buildBell() {
    this.bellHost = document.querySelector?.(".nce-titlebar-drag-space") || null;
    this.bellContainer = document.createElement("div");
    this.bellContainer.className = "nce-titlebar-actions";

    this.bellButton = document.createElement("button");
    this.bellButton.type = "button";
    this.bellButton.className = "nce-notification-bell";
    this.bellButton.setAttribute("aria-label", "Notifications");
    this.bellButton.setAttribute("aria-haspopup", "dialog");
    this.bellButton.setAttribute("aria-expanded", "false");
    this.bellButton.title = "Notifications";
    this.bellButton.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M8 2.2a3.4 3.4 0 0 0-3.4 3.4v2.1L3.4 10.5h9.2L11.4 7.7V5.6A3.4 3.4 0 0 0 8 2.2Z" />' +
      '<path d="M6.6 11.9a1.5 1.5 0 0 0 2.8 0" />' +
      "</svg>";

    this.badge = document.createElement("span");
    this.badge.className = "nce-notification-badge";
    this.badge.setAttribute("aria-hidden", "true");
    this.badge.hidden = true;

    this.bellButton.appendChild(this.badge);
    this.bellButton.addEventListener("click", () => this.toggle());
    this.bellContainer.appendChild(this.bellButton);
    this.bellHost?.appendChild(this.bellContainer);
  }

  buildCenter() {
    this.element = document.createElement("div");
    this.element.className = "nce-notification-center";
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", "Notifications");
    this.element.setAttribute("aria-hidden", "true");
    this.element.tabIndex = -1;

    const header = document.createElement("div");
    header.className = "nce-notification-center-header";
    const title = document.createElement("span");
    title.className = "nce-notification-center-title";
    title.textContent = "Notifications";
    const count = document.createElement("span");
    count.className = "nce-notification-center-count";
    const headerActions = document.createElement("div");
    headerActions.className = "nce-notification-center-actions";

    this.markAllButton = document.createElement("button");
    this.markAllButton.type = "button";
    this.markAllButton.className = "nce-notification-center-action";
    this.markAllButton.title = "Mark all as read";
    this.markAllButton.setAttribute("aria-label", "Mark all notifications as read");
    const markAllGlyph = document.createElement("i");
    markAllGlyph.className = "fi fi-rr-check-double";
    markAllGlyph.setAttribute("aria-hidden", "true");
    this.markAllButton.appendChild(markAllGlyph);
    this.markAllButton.addEventListener("click", () => this.manager.markAllAsRead());

    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "nce-notification-center-action";
    this.clearButton.title = "Clear all notifications";
    this.clearButton.setAttribute("aria-label", "Clear all notifications");
    const clearGlyph = document.createElement("i");
    clearGlyph.className = "fi fi-rr-trash";
    clearGlyph.setAttribute("aria-hidden", "true");
    this.clearButton.appendChild(clearGlyph);
    this.clearButton.addEventListener("click", () => this.manager.clearHistory());

    headerActions.append(this.markAllButton, this.clearButton);
    header.append(title, count, headerActions);

    const list = document.createElement("div");
    list.className = "nce-notification-center-list";
    list.setAttribute("role", "list");

    const empty = document.createElement("div");
    empty.className = "nce-notification-center-empty";
    empty.textContent = "No notifications";

    this.element.append(header, list, empty);
    const host = document.body || document.querySelector?.(".main-section");
    host?.appendChild(this.element);

    this.list = list;
    this.empty = empty;
    this.count = count;
  }

  handleManagerEvent(event) {
    if (this.destroyed) return;
    this.updateBadge();
    if (this.actionErrors.size > 0) {
      const ids = new Set(this.manager.getNotifications().map((item) => item.id));
      for (const id of [...this.actionErrors.keys()]) {
        if (!ids.has(id)) this.actionErrors.delete(id);
      }
    }
    if (!this.isOpen) return;
    if (event && (
      event.type === "toast-dismissed" ||
      event.type === "toasts-changed" ||
      event.type === "toasts-cleared"
    )) return;
    this.render();
  }

  updateBadge() {
    const unread = this.manager.getUnreadCount();
    this.badge.hidden = unread === 0;
    this.badge.textContent = unread > 99 ? "99+" : String(unread);
    const label = unread === 0 ? "Notifications" : `Notifications, ${unread} unread`;
    this.bellButton.setAttribute("aria-label", label);
    this.bellButton.title = label;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen || this.destroyed) return false;
    this.isOpen = true;
    this.previousFocus = document.activeElement;
    this.element.classList.add("is-open");
    this.element.setAttribute("aria-hidden", "false");
    this.bellButton.setAttribute("aria-expanded", "true");
    this.render();
    this.element.focus?.();
    return true;
  }

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return false;
    this.isOpen = false;
    this.element.classList.remove("is-open");
    this.element.setAttribute("aria-hidden", "true");
    this.bellButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      const previous = this.previousFocus;
      const target = previous && previous !== document.body &&
        previous.isConnected !== false
        ? previous
        : this.bellButton;
      target?.focus?.();
    }
    this.previousFocus = null;
    return true;
  }

  render() {
    const scrollTop = this.list.scrollTop || 0;
    const activeId = this.documentActiveNotificationId();
    const notifications = this.manager.getNotifications()
      .slice()
      .sort((left, right) => right.timestamp - left.timestamp);
    const unread = this.manager.getUnreadCount();

    this.count.hidden = unread === 0;
    this.count.textContent = unread === 1 ? "1 unread" : `${unread} unread`;
    this.markAllButton.disabled = unread === 0;
    this.clearButton.disabled = notifications.length === 0;

    this.list.replaceChildren();
    this.focusables = [];
    for (const notification of notifications) {
      const item = this.createItem(notification);
      this.list.appendChild(item);
      this.focusables.push(item);
    }
    this.empty.hidden = notifications.length > 0;
    this.list.scrollTop = scrollTop;

    if (activeId) {
      const restored = this.focusables.find(
        (item) => item.dataset.notificationId === activeId,
      );
      restored?.focus?.();
    }
  }

  documentActiveNotificationId() {
    const active = document.activeElement;
    if (!active || !this.element.contains?.(active)) return null;
    return active.closest?.(".nce-notification-item")?.dataset?.notificationId ||
      active.dataset?.notificationId ||
      null;
  }

  createItem(notification) {
    const item = document.createElement("div");
    item.className = "nce-notification-item";
    item.dataset.notificationId = notification.id;
    item.dataset.type = notification.type;
    item.dataset.read = String(notification.read);
    item.tabIndex = 0;
    item.setAttribute("role", "listitem");
    item.setAttribute(
      "aria-label",
      `${notification.title}${notification.read ? "" : ", unread"}`,
    );

    const icon = document.createElement("span");
    icon.className = "nce-notification-item-icon";
    const glyph = document.createElement("i");
    glyph.className = `fi ${NOTIFICATION_CENTER_ICONS[notification.type] || NOTIFICATION_CENTER_ICONS.info}`;
    glyph.setAttribute("aria-hidden", "true");
    icon.appendChild(glyph);

    const content = document.createElement("div");
    content.className = "nce-notification-item-content";

    const titleRow = document.createElement("div");
    titleRow.className = "nce-notification-item-title-row";
    const dot = document.createElement("span");
    dot.className = "nce-notification-unread-dot";
    dot.hidden = notification.read;
    dot.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "nce-notification-item-title";
    title.textContent = notification.title;
    const count = document.createElement("span");
    count.className = "nce-notification-item-count";
    if (notification.count > 1) count.textContent = `×${notification.count}`;
    titleRow.append(dot, title, count);

    const message = document.createElement("div");
    message.className = "nce-notification-item-message";
    message.textContent = notification.message || "";
    message.hidden = !notification.message;

    const meta = document.createElement("div");
    meta.className = "nce-notification-item-meta";
    if (notification.source) {
      const source = document.createElement("span");
      source.className = "nce-notification-item-source";
      source.textContent = notification.source;
      meta.appendChild(source);
    }
    const time = document.createElement("span");
    time.className = "nce-notification-item-time";
    time.textContent = NotificationCenterView.formatTimestamp(
      notification.timestamp,
      this.now(),
    );
    meta.appendChild(time);

    content.append(titleRow, message, meta);

    const error = document.createElement("div");
    error.className = "nce-notification-item-error";
    error.hidden = !this.actionErrors.has(notification.id);
    if (!error.hidden) error.textContent = this.actionErrors.get(notification.id);
    content.appendChild(error);

    if (notification.actions.length > 0) {
      const actionRow = document.createElement("div");
      actionRow.className = "nce-notification-item-actions";
      const actionButtons = [];
      notification.actions.forEach((action, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "nce-notification-action";
        button.textContent = action.label;
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          void this.runAction(item, notification.id, index, actionButtons);
        });
        actionRow.appendChild(button);
        actionButtons.push(button);
      });
      item._actionButtons = actionButtons;
      content.appendChild(actionRow);
    }

    const controls = document.createElement("div");
    controls.className = "nce-notification-item-controls";
    if (!notification.read) {
      const readButton = document.createElement("button");
      readButton.type = "button";
      readButton.className = "nce-notification-item-control";
      readButton.title = "Mark as read";
      readButton.setAttribute("aria-label", "Mark notification as read");
      const readGlyph = document.createElement("i");
      readGlyph.className = "fi fi-rr-check";
      readGlyph.setAttribute("aria-hidden", "true");
      readButton.appendChild(readGlyph);
      readButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.manager.markAsRead(notification.id);
      });
      controls.appendChild(readButton);
    }
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "nce-notification-item-control";
    removeButton.title = "Remove notification";
    removeButton.setAttribute("aria-label", "Remove notification");
    const removeGlyph = document.createElement("i");
    removeGlyph.className = "fi fi-rr-trash";
    removeGlyph.setAttribute("aria-hidden", "true");
    removeButton.appendChild(removeGlyph);
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.manager.remove(notification.id);
    });
    controls.appendChild(removeButton);

    item.append(icon, content, controls);
    item._error = error;

    item.addEventListener("click", (event) => {
      if (event.target?.closest?.("button")) return;
      this.manager.markAsRead(notification.id);
    });
    item.addEventListener("keydown", (event) => {
      if (event.target !== item) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.manager.markAsRead(notification.id);
      } else if (event.key === "Delete") {
        event.preventDefault();
        this.manager.remove(notification.id);
      }
    });
    return item;
  }

  async runAction(item, id, index, buttons) {
    if (item._actionBusy) return;
    item._actionBusy = true;
    for (const button of buttons) button.disabled = true;
    item._error.hidden = true;
    this.actionErrors.delete(id);
    const succeeded = await this.manager.executeAction(id, index);
    if (this.destroyed) return;
    item._actionBusy = false;
    for (const button of buttons) button.disabled = false;
    if (succeeded) {
      this.actionErrors.delete(id);
      return;
    }
    this.actionErrors.set(id, "The action failed.");
    if (this.isOpen) this.render();
  }

  handleDocumentPointerDown(event) {
    if (!this.isOpen) return;
    if (this.element.contains?.(event.target)) return;
    if (this.bellButton.contains?.(event.target)) return;
    this.close();
  }

  handleDocumentKeyDown(event) {
    if (!this.isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (this.focusables.length === 0) return;
    const current = this.focusables.indexOf(document.activeElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + direction + this.focusables.length) % this.focusables.length;
    event.preventDefault();
    this.focusables[next].focus?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.close({ restoreFocus: false });
    this.bellContainer?.remove?.();
    this.element?.remove?.();
    this.bellHost = null;
    this.bellContainer = null;
    this.bellButton = null;
    this.element = null;
    this.list = null;
    this.empty = null;
  }
}
