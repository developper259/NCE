class BottomPanelManager {
  constructor(editor) {
    this.editor = editor;
    this.panels = new Map();
    this.activePanelId = null;
    this.visible = false;
    this.height = BottomPanelManager.DEFAULT_HEIGHT;
    this.preferredHeight = BottomPanelManager.DEFAULT_HEIGHT;
    this.workspaceKey = "no-workspace";
    this.workspaceRoot = null;
    this.workspaceSnapshots = new Map();
    this.focusBeforeOpen = null;
    this.drag = null;
    this.activationGeneration = 0;
    this.destroyed = false;

    this.root = editor.domManager.getElement(".bottom-panel");
    this.resizeHandle = this.root?.querySelector(
      ".bottom-panel-resize-handle",
    );
    this.viewNavigation = this.root?.querySelector(".bottom-panel-views");
    this.contentElement = this.root?.querySelector(".bottom-panel-content");
    this.newButton = this.root?.querySelector(".bottom-panel-new");
    this.killButton = this.root?.querySelector(".bottom-panel-kill");
    this.terminalActionsSlot = this.root?.querySelector(
      ".bottom-panel-terminal-actions-slot",
    );
    this.closeButton = this.root?.querySelector(".bottom-panel-close");
    this.toggleButton = editor.domManager.getElement(
      ".bottomBar-terminal-toggle",
    );

    this.onToggleClick = () => this.togglePanel("terminal");
    this.onNewClick = () => this.runActiveAction("onNew");
    this.onKillClick = () => this.runActiveAction("onKill");
    this.onCloseClick = () => this.closePanel();
    this.onPointerDown = (event) => this.startResize(event);
    this.onPointerMove = (event) => this.moveResize(event);
    this.onPointerUp = (event) => this.finishResize(event);
    this.onPointerCancel = (event) => this.finishResize(event);
    this.onLostPointerCapture = (event) => this.finishResize(event);
    this.onWindowBlur = () => this.cancelResize();
    this.onResizeKeyDown = (event) => this.handleResizeKeyDown(event);
    this.onViewTabKeyDown = (event) => this.handleViewTabKeyDown(event);

    this.toggleButton?.addEventListener("click", this.onToggleClick);
    this.newButton?.addEventListener("click", this.onNewClick);
    this.killButton?.addEventListener("click", this.onKillClick);
    this.closeButton?.addEventListener("click", this.onCloseClick);
    this.viewNavigation?.addEventListener("keydown", this.onViewTabKeyDown);
    this.resizeHandle?.addEventListener("pointerdown", this.onPointerDown);
    this.resizeHandle?.addEventListener("pointermove", this.onPointerMove);
    this.resizeHandle?.addEventListener("pointerup", this.onPointerUp);
    this.resizeHandle?.addEventListener("pointercancel", this.onPointerCancel);
    this.resizeHandle?.addEventListener(
      "lostpointercapture",
      this.onLostPointerCapture,
    );
    this.resizeHandle?.addEventListener("keydown", this.onResizeKeyDown);
    window.addEventListener("blur", this.onWindowBlur);
    this.syncControls();
  }

  registerPanel(panel) {
    if (
      !panel ||
      typeof panel.id !== "string" ||
      !panel.id.trim() ||
      typeof panel.title !== "string" ||
      typeof panel.createView !== "function" ||
      this.panels.has(panel.id)
    ) return false;

    this.panels.set(panel.id, {
      ...panel,
      loadPromise: null,
      view: null,
      viewCreated: false,
      viewActive: false,
    });
    this.syncControls();
    return true;
  }

  unregisterPanel(panelId) {
    const panel = this.panels.get(panelId);
    if (!panel) return false;
    if (this.activePanelId === panelId) this.closePanel({ restoreFocus: false });
    panel.view?.destroy?.();
    panel.view = null;
    this.panels.delete(panelId);
    if (this.activePanelId === panelId) this.activePanelId = null;
    this.syncControls();
    this.notifyStateChanged();
    return true;
  }

  getActivePanel() {
    return this.panels.get(this.activePanelId) || null;
  }

  getPanelState() {
    const snapshot = this.workspaceSnapshots.get(this.workspaceKey) || {};
    const terminal = this.getActivePanel()?.view?.getPersistedState?.(this.workspaceKey) ||
      snapshot.terminal || { version: 1, activeTabIndex: 0, tabs: [] };
    return {
      visible: this.visible,
      height: this.preferredHeight,
      activePanelId: this.activePanelId,
      terminal,
    };
  }

  getWorkspacePanelState(workspaceKey) {
    if (workspaceKey === this.workspaceKey) return this.getPanelState();
    const snapshot = this.workspaceSnapshots.get(workspaceKey) || {};
    const terminal = this.getActivePanel()?.view?.getPersistedState?.(workspaceKey) ||
      snapshot.terminal || { version: 1, activeTabIndex: 0, tabs: [] };
    return {
      visible: snapshot.visible === true,
      height: Number.isFinite(snapshot.height) ? snapshot.height : BottomPanelManager.DEFAULT_HEIGHT,
      activePanelId: snapshot.activePanelId || "terminal",
      terminal,
    };
  }

  getWorkspaceRoot(workspaceKey) {
    if (workspaceKey === this.workspaceKey) return this.workspaceRoot;
    return this.workspaceSnapshots.get(workspaceKey)?.workspaceRoot || null;
  }

  suspendWorkspaceSwitch() {
    if (this.destroyed) return false;
    this.workspaceSnapshots.set(this.workspaceKey, {
      ...this.getPanelState(),
      workspaceRoot: this.workspaceRoot,
    });
    const panel = this.getActivePanel();
    panel?.view?.onDeactivate?.();
    if (panel) panel.viewActive = false;
    this.activationGeneration += 1;
    this.visible = false;
    this.applyLayout();
    this.scheduleLayout();
    this.syncControls();
    return true;
  }

  async setActivePanel(panelId, options = {}) {
    return this.openPanel(panelId, options);
  }

  async openPanel(panelId, { restoring = false, focus = true } = {}) {
    const panel = this.panels.get(panelId);
    if (!panel || this.destroyed) return false;
    const activation = ++this.activationGeneration;

    if (!this.visible) {
      this.focusBeforeOpen = document.activeElement;
      this.visible = true;
    }
    const changed = this.activePanelId !== panelId;
    if (changed) {
      const previous = this.getActivePanel();
      previous?.view?.onDeactivate?.();
      if (previous) previous.viewActive = false;
      this.activePanelId = panelId;
      if (this.contentElement && panel.view?.element) {
        this.contentElement.replaceChildren(panel.view.element);
      }
    }

    this.syncControls();
    this.applyLayout();
    this.scheduleLayout();
    this.notifyStateChanged();

    try {
      await this.ensurePanelView(panel);
      if (
        this.destroyed ||
        activation !== this.activationGeneration ||
        !this.visible ||
        this.activePanelId !== panelId
      )
        return false;
      if (focus) {
        panel.view?.focus?.();
        this.editor.domManager.requestFrame?.(() => {
          if (
            !this.destroyed &&
            activation === this.activationGeneration &&
            this.visible &&
            this.activePanelId === panelId
          ) panel.view?.focus?.();
        });
      }
      if (!panel.viewActive) {
        await panel.view?.onOpen?.({ restoring, focus });
        if (
          this.destroyed ||
          activation !== this.activationGeneration ||
          !this.visible ||
          this.activePanelId !== panelId
        ) return false;
        panel.view?.onActivate?.();
        panel.viewActive = true;
      }
      if (focus) panel.view?.focus?.();
      return true;
    } catch (error) {
      if (!this.destroyed && this.visible && this.activePanelId === panelId)
        this.showLoadError(panel, error);
      return false;
    }
  }

  async ensurePanelView(panel, { retry = false } = {}) {
    if (panel.viewCreated && panel.view) return panel.view;
    if (panel.loadPromise && !retry) return panel.loadPromise;

    panel.loadPromise = (async () => {
      this.showLoadingState();
      const view = await panel.createView(this.contentElement, this.editor);
      if (!view || typeof view !== "object")
        throw new Error(`The ${panel.title} panel did not initialize.`);
      panel.view = view;
      panel.viewCreated = true;
      view.activateWorkspace?.(
        this.workspaceKey,
        this.workspaceRoot,
        this.workspaceSnapshots.get(this.workspaceKey)?.terminal,
      );
      if (this.visible && this.activePanelId === panel.id && view.element) {
        this.contentElement?.replaceChildren(view.element);
      }
      return view;
    })();

    try {
      return await panel.loadPromise;
    } finally {
      panel.loadPromise = null;
    }
  }

  showLoadingState() {
    if (!this.contentElement) return;
    const message = document.createElement("div");
    message.className = "bottom-panel-message";
    message.setAttribute("role", "status");
    message.textContent = "Loading terminal…";
    this.contentElement.replaceChildren(message);
  }

  showLoadError(panel, error) {
    if (!this.contentElement) return;
    const message = document.createElement("div");
    message.className = "bottom-panel-message bottom-panel-error";
    const text = document.createElement("p");
    text.textContent = "The Terminal panel could not be loaded.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "bottom-panel-button";
    retry.textContent = "Retry";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        await this.ensurePanelView(panel, { retry: true });
        if (this.activePanelId !== panel.id || !this.visible) return;
        if (!panel.viewActive) {
          panel.view?.onOpen?.({ restoring: false });
          panel.view?.onActivate?.();
          panel.viewActive = true;
        }
        panel.view?.focus?.();
      } catch (retryError) {
        this.showLoadError(panel, retryError);
      }
    }, { once: true });
    message.append(text, retry);
    this.contentElement.replaceChildren(message);
    console.error("Failed to load Bottom Panel view:", error);
  }

  async togglePanel(panelId, options = {}) {
    if (this.visible && this.activePanelId === panelId) {
      return this.closePanel();
    }
    return this.openPanel(panelId, options);
  }

  closePanel({ restoreFocus = true } = {}) {
    if (!this.visible) return false;
    const panel = this.getActivePanel();
    panel?.view?.onDeactivate?.();
    panel?.view?.onClose?.();
    if (panel) panel.viewActive = false;
    this.activationGeneration += 1;
    this.visible = false;
    this.scheduleLayout();
    this.syncControls();
    this.notifyStateChanged();

    if (restoreFocus) {
      const target = this.focusBeforeOpen;
      this.focusBeforeOpen = null;
      if (target?.isConnected && !target.closest?.("[hidden]")) target.focus?.();
    }
    return true;
  }

  runActiveAction(action) {
    const callback = this.getActivePanel()?.[action];
    if (typeof callback !== "function") return false;
    callback.call(this.getActivePanel());
    return true;
  }

  handleViewTabKeyDown(event) {
    if (!event.target?.matches?.('[role="tab"]')) return false;
    const tabs = [...(this.viewNavigation?.querySelectorAll?.('[role="tab"]') || [])];
    if (!tabs.length) return false;
    const current = tabs.indexOf(event.target);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return false;
    event.preventDefault();
    const panelId = [...this.panels.keys()][next];
    void this.openPanel(panelId, { focus: false });
    tabs[next]?.focus();
    return true;
  }

  resize(height) {
    const bounds = this.getHeightBounds();
    if (!Number.isFinite(height) || bounds.max <= 0) return false;
    const next = Math.round(Math.min(bounds.max, Math.max(bounds.min, height)));
    if (next === this.height) return false;
    this.height = next;
    this.preferredHeight = next;
    this.syncControls();
    this.scheduleLayout();
    this.notifyStateChanged();
    return true;
  }

  getHeightBounds() {
    const mainSection = this.editor.domManager.getElement(".main-section");
    const measuredHeight = mainSection?.clientHeight ||
      mainSection?.getBoundingClientRect?.().height || 0;
    const windowHeight = this.editor.domManager.getWindowHeight?.() ||
      window.innerHeight || 0;
    const available = Math.max(0, measuredHeight || windowHeight - 36);
    const topTabs = BottomPanelManager.FILE_MANAGER_HEIGHT;
    const bottomBar = BottomPanelManager.BOTTOM_BAR_HEIGHT;
    const minimumEditorHeight = Math.min(
      BottomPanelManager.MIN_EDITOR_HEIGHT,
      Math.max(0, available - topTabs - bottomBar),
    );
    const max = Math.max(0, Math.floor(
      available - topTabs - bottomBar - minimumEditorHeight,
    ));
    return { min: Math.min(BottomPanelManager.MIN_HEIGHT, max), max };
  }

  onViewportResize() {
    const bounds = this.getHeightBounds();
    const clamped = Math.min(bounds.max, Math.max(bounds.min, this.height));
    if (clamped === this.height) return false;
    this.height = clamped;
    this.preferredHeight = clamped;
    this.syncControls();
    return true;
  }

  applyLayout() {
    const height = this.visible ? this.height : 0;
    document.documentElement.style.setProperty(
      "--bottom-panel-height",
      `${Math.max(0, Math.round(height))}px`,
    );
    if (this.root) {
      this.root.hidden = !this.visible;
      this.root.setAttribute("aria-hidden", String(!this.visible));
    }
  }

  scheduleLayout() {
    this.editor.domManager.scheduleLayout({ bottomPanel: true });
  }

  onLayoutResize() {
    if (!this.visible) return;
    this.getActivePanel()?.view?.onResize?.();
  }

  onThemeChanged() {
    for (const panel of this.panels.values()) panel.view?.onThemeChanged?.();
  }

  restoreState(state, workspaceKey = this.workspaceKey, workspaceRoot = null) {
    const safe = state && typeof state === "object" ? state : {};
    if (typeof workspaceKey === "string" && workspaceKey) {
      this.workspaceKey = workspaceKey;
      this.workspaceRoot = workspaceRoot || null;
    }
    const rawHeight = safe.height;
    const height = Number.isFinite(rawHeight)
      ? Math.min(1200, Math.max(BottomPanelManager.MIN_HEIGHT, rawHeight))
      : BottomPanelManager.DEFAULT_HEIGHT;
    const activePanelId = typeof safe.activePanelId === "string" &&
      this.panels.has(safe.activePanelId)
      ? safe.activePanelId
      : this.panels.has("terminal") ? "terminal" : null;

    this.visible = safe.visible === true && Boolean(activePanelId);
    this.activePanelId = activePanelId;
    this.preferredHeight = Math.round(height);
    this.height = this.preferredHeight;
    this.workspaceSnapshots.set(this.workspaceKey, {
      visible: this.visible,
      height: this.preferredHeight,
      activePanelId,
      terminal: safe.terminal || { version: 1, activeTabIndex: 0, tabs: [] },
      workspaceRoot: this.workspaceRoot,
    });
    const panel = this.panels.get("terminal");
    panel?.view?.activateWorkspace?.(
      this.workspaceKey,
      this.workspaceRoot,
      safe.terminal,
    );
    this.syncControls();
    this.scheduleLayout();
    if (this.visible) {
      void this.openPanel(activePanelId, { restoring: true, focus: false });
    }
    return this.getPanelState();
  }

  notifyStateChanged() {
    this.workspaceSnapshots.set(this.workspaceKey, this.getPanelState());
    this.editor.statesManager?.scheduleBottomPanelStateSave?.(this.workspaceKey);
  }

  syncControls() {
    const active = this.getActivePanel();
    if (this.viewNavigation) {
      const panels = [...this.panels.values()];
      const navigationVisible = panels.length > 1;
      this.viewNavigation.hidden = !navigationVisible;
      const existing = [...(this.viewNavigation.children || [])];
      const matches = existing.length === panels.length && existing.every(
        (tab, index) => tab.dataset?.panelId === panels[index]?.id,
      );
      if (!navigationVisible) {
        if (existing.length) this.viewNavigation.replaceChildren();
      } else if (!matches) {
        this.viewNavigation.replaceChildren();
        for (const panel of panels) {
          const tab = document.createElement("button");
          tab.type = "button";
          tab.className = "bottom-panel-view-tab";
          tab.id = `bottom-panel-view-${panel.id}`;
          tab.dataset.panelId = panel.id;
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-controls", "bottom-panel-content");
          tab.textContent = panel.title;
          tab.addEventListener("click", () => void this.openPanel(panel.id));
          this.viewNavigation.appendChild(tab);
        }
      }
      if (navigationVisible) {
        for (const tab of this.viewNavigation.querySelectorAll?.('[role="tab"]') || []) {
          const selected = tab.dataset.panelId === this.activePanelId;
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
        }
      }
    }
    if (this.newButton) this.newButton.hidden = typeof active?.onNew !== "function";
    if (this.killButton) this.killButton.disabled =
      typeof active?.onKill !== "function" || active.canKill?.() === false;
    if (this.terminalActionsSlot)
      this.terminalActionsSlot.hidden = active?.id !== "terminal";
    if (this.contentElement && active) {
      const panels = [...this.panels.values()];
      const labelId = panels.length > 1
        ? `bottom-panel-view-${active.id}`
        : "bottom-panel-title";
      this.contentElement.setAttribute("aria-labelledby", labelId);
    }
    if (this.toggleButton) {
      this.toggleButton.hidden = false;
      this.toggleButton.setAttribute("aria-expanded", String(this.visible));
    }
    if (this.resizeHandle) {
      const bounds = this.getHeightBounds();
      this.resizeHandle.setAttribute("aria-valuemin", String(bounds.min));
      this.resizeHandle.setAttribute("aria-valuemax", String(bounds.max));
      this.resizeHandle.setAttribute("aria-valuenow", String(this.height));
    }
  }

  startResize(event) {
    if (
      this.destroyed ||
      !this.visible ||
      this.drag ||
      event?.button !== 0 ||
      event?.pointerId === undefined
    ) return false;
    event.preventDefault?.();
    this.drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: this.height,
      target: event.currentTarget || this.resizeHandle,
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    try {
      this.drag.target?.setPointerCapture?.(event.pointerId);
    } catch {}
    return true;
  }

  moveResize(event) {
    if (!this.drag || event?.pointerId !== this.drag.pointerId) return false;
    event.preventDefault?.();
    return this.resize(this.drag.startHeight + this.drag.startY - event.clientY);
  }

  finishResize(event) {
    if (!this.drag || (event?.pointerId !== undefined &&
        event.pointerId !== this.drag.pointerId)) return false;
    const { pointerId, target } = this.drag;
    this.drag = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      if (target?.hasPointerCapture?.(pointerId))
        target.releasePointerCapture(pointerId);
    } catch {}
    return true;
  }

  cancelResize() {
    return this.finishResize();
  }

  handleResizeKeyDown(event) {
    const bounds = this.getHeightBounds();
    if (event.key === "ArrowUp") this.resize(this.height + 20);
    else if (event.key === "ArrowDown") this.resize(this.height - 20);
    else if (event.key === "Home") this.resize(bounds.min);
    else if (event.key === "End") this.resize(bounds.max);
    else return false;
    event.preventDefault();
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelResize();
    this.toggleButton?.removeEventListener("click", this.onToggleClick);
    this.newButton?.removeEventListener("click", this.onNewClick);
    this.killButton?.removeEventListener("click", this.onKillClick);
    this.closeButton?.removeEventListener("click", this.onCloseClick);
    this.viewNavigation?.removeEventListener("keydown", this.onViewTabKeyDown);
    this.resizeHandle?.removeEventListener("pointerdown", this.onPointerDown);
    this.resizeHandle?.removeEventListener("pointermove", this.onPointerMove);
    this.resizeHandle?.removeEventListener("pointerup", this.onPointerUp);
    this.resizeHandle?.removeEventListener("pointercancel", this.onPointerCancel);
    this.resizeHandle?.removeEventListener(
      "lostpointercapture",
      this.onLostPointerCapture,
    );
    this.resizeHandle?.removeEventListener("keydown", this.onResizeKeyDown);
    window.removeEventListener("blur", this.onWindowBlur);
    for (const panel of this.panels.values()) panel.view?.destroy?.();
    this.panels.clear();
    this.contentElement?.replaceChildren();
  }
}

BottomPanelManager.DEFAULT_HEIGHT = 250;
BottomPanelManager.MIN_HEIGHT = 120;
BottomPanelManager.MIN_EDITOR_HEIGHT = 120;
BottomPanelManager.FILE_MANAGER_HEIGHT = 38;
BottomPanelManager.BOTTOM_BAR_HEIGHT = 20;
