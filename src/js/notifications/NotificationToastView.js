const NOTIFICATION_ICONS = Object.freeze({
  success: "fi-rr-check",
  error: "fi-rr-cross-circle",
  warning: "fi-rr-triangle-warning",
  info: "fi-rr-info",
});

class NotificationToastView {
  constructor(editor, manager, options = {}) {
    this.editor = editor;
    this.manager = manager;
    this.exitDuration = Number.isFinite(options.exitDuration)
      ? Math.max(0, options.exitDuration)
      : 140;
    this.destroyed = false;
    this.elements = new Map();
    this.removalTimers = new Map();

    this.container = document.createElement("div");
    this.container.className = "nce-toast-host";
    this.container.setAttribute("role", "region");
    this.container.setAttribute("aria-label", "Notifications");
    this.container.setAttribute("aria-live", "polite");
    const host = document.body || document.querySelector?.(".main-section");
    host?.appendChild(this.container);

    this.unsubscribe = manager.subscribe(() => this.sync());
    this.sync();
  }

  sync() {
    if (this.destroyed) return;
    const toasts = this.manager.getToasts();
    const activeIds = new Set(toasts.map((notification) => notification.id));
    for (const id of [...this.elements.keys()]) {
      if (!activeIds.has(id) && !this.removalTimers.has(id))
        this.removeToast(id);
    }
    for (const notification of toasts) {
      const existing = this.elements.get(notification.id);
      if (existing) {
        this.updateToast(existing, notification);
        continue;
      }
      const element = this.createToast(notification);
      this.elements.set(notification.id, element);
      this.container.appendChild(element);
      this.revealToast(element);
    }
  }

  createToast(notification) {
    const element = document.createElement("div");
    element.className = "nce-toast";
    element.dataset.id = notification.id;
    element.dataset.type = notification.type;
    element.setAttribute("aria-label", `${notification.type}: ${notification.title}`);

    const icon = document.createElement("span");
    icon.className = "nce-toast-icon";
    const iconGlyph = document.createElement("i");
    iconGlyph.className = `fi ${NOTIFICATION_ICONS[notification.type] || NOTIFICATION_ICONS.info}`;
    iconGlyph.setAttribute("aria-hidden", "true");
    icon.appendChild(iconGlyph);

    const body = document.createElement("div");
    body.className = "nce-toast-body";

    const titleRow = document.createElement("div");
    titleRow.className = "nce-toast-title-row";
    const title = document.createElement("span");
    title.className = "nce-toast-title";
    title.textContent = notification.title;
    const count = document.createElement("span");
    count.className = "nce-toast-count";
    count.setAttribute("aria-hidden", "true");
    titleRow.append(title, count);

    const message = document.createElement("div");
    message.className = "nce-toast-message";

    const error = document.createElement("div");
    error.className = "nce-toast-error";
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "nce-toast-actions";

    const actionButtons = [];
    notification.actions.forEach((action, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nce-toast-action";
      button.textContent = action.label;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.runAction(element, notification.id, index, actionButtons);
      });
      actions.appendChild(button);
      actionButtons.push(button);
    });
    actions.hidden = actionButtons.length === 0;

    body.append(titleRow, message, error, actions);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "nce-toast-close";
    close.title = "Dismiss notification";
    close.setAttribute("aria-label", "Dismiss notification");
    const closeGlyph = document.createElement("i");
    closeGlyph.className = "fi fi-rr-cross-small";
    closeGlyph.setAttribute("aria-hidden", "true");
    close.appendChild(closeGlyph);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      this.manager.dismiss(notification.id);
    });

    element.append(icon, body, close);
    element._title = title;
    element._count = count;
    element._message = message;
    element._error = error;
    element._actions = actions;
    element._actionButtons = actionButtons;
    element._actionBusy = false;

    element.addEventListener("pointerenter", () => this.manager.pauseTimer(notification.id));
    element.addEventListener("pointerleave", () => this.manager.resumeTimer(notification.id));
    element.addEventListener("focusin", () => this.manager.pauseTimer(notification.id));
    element.addEventListener("focusout", (event) => {
      if (element.contains?.(event.relatedTarget)) return;
      this.manager.resumeTimer(notification.id);
    });

    this.updateToast(element, notification);
    return element;
  }

  updateToast(element, notification) {
    element._title.textContent = notification.title;
    element._count.textContent = notification.count > 1 ? `×${notification.count}` : "";
    element._count.hidden = notification.count <= 1;
    element._message.textContent = notification.message || "";
    element._message.hidden = !notification.message;
  }

  async runAction(element, id, index, buttons) {
    if (element._actionBusy) return;
    element._actionBusy = true;
    for (const button of buttons) button.disabled = true;
    element._error.hidden = true;
    const succeeded = await this.manager.executeAction(id, index);
    if (this.destroyed || this.elements.get(id) !== element) return;
    element._actionBusy = false;
    for (const button of buttons) button.disabled = false;
    if (!succeeded) {
      element._error.textContent = "The action failed.";
      element._error.hidden = false;
    }
  }

  revealToast(element) {
    const reveal = () => {
      if (!this.destroyed && this.elements.get(element.dataset.id) === element)
        element.classList.add("is-visible");
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
    else setTimeout(reveal, 0);
  }

  removeToast(id) {
    const element = this.elements.get(id);
    if (!element) return;
    this.elements.delete(id);
    element.classList.add("is-leaving");
    const finalize = () => {
      this.removalTimers.delete(id);
      const remaining = [...this.elements.values()];
      const previousRects = new Map();
      for (const other of remaining) {
        const rect = other.getBoundingClientRect?.();
        if (rect) previousRects.set(other, rect);
      }
      element.remove?.();
      for (const [other, rect] of previousRects) {
        const next = other.getBoundingClientRect?.();
        if (!next) continue;
        const delta = rect.top - next.top;
        if (!delta) continue;
        other.style.transition = "none";
        other.style.transform = `translateY(${delta}px)`;
        const clear = () => {
          other.style.transition = "";
          other.style.transform = "";
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(clear);
        else setTimeout(clear, 0);
      }
    };
    if (this.exitDuration <= 0) {
      finalize();
      return;
    }
    this.removalTimers.set(id, setTimeout(finalize, this.exitDuration));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.removalTimers.values()) clearTimeout(timer);
    this.removalTimers.clear();
    this.elements.clear();
    this.container.remove?.();
    this.container = null;
  }
}
