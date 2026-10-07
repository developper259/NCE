class PerformanceDashboard {
  constructor(editor) {
    this.editor = editor;
    this.host = null;
    this.dialog = null;
    this.output = null;
    this.status = null;
    this.closeButton = null;
    this.focusableElements = [];
    this.previousFocus = null;
    this.onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hide();
      } else if (event.key === "Tab" && this.focusableElements.length) {
        const currentIndex = this.focusableElements.indexOf(document.activeElement);
        const offset = event.shiftKey ? -1 : 1;
        const nextIndex = (currentIndex + offset + this.focusableElements.length) % this.focusableElements.length;
        event.preventDefault();
        this.focusableElements[nextIndex].focus();
      }
    };
  }

  getMetrics() {
    return this.editor.performanceMetrics || window.NCEPerformanceMetrics || null;
  }

  ensureDOM() {
    if (this.host) return true;
    if (!document.body) return false;

    const host = document.createElement("div");
    host.className = "nce-performance-dashboard-host";
    host.hidden = true;
    host.setAttribute("aria-hidden", "true");

    const dialog = document.createElement("section");
    dialog.className = "nce-performance-dashboard";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "nce-performance-dashboard-title");

    const header = document.createElement("header");
    header.className = "nce-performance-dashboard-header";
    const title = document.createElement("h2");
    title.id = "nce-performance-dashboard-title";
    title.textContent = "Developer: Performance";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "nce-performance-dashboard-close";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => this.hide());
    header.append(title, closeButton);

    const actions = document.createElement("div");
    actions.className = "nce-performance-dashboard-actions";
    const refreshButton = this.createButton("Refresh", () => this.refresh());
    const resetButton = this.createButton("Reset", () => this.reset());
    const copyButton = this.createButton("Copy report", () => void this.copyReport());
    this.focusableElements = [closeButton, refreshButton, resetButton, copyButton];
    actions.append(refreshButton, resetButton, copyButton);

    const output = document.createElement("div");
    output.className = "nce-performance-dashboard-output";
    output.setAttribute("aria-live", "polite");
    const status = document.createElement("p");
    status.className = "nce-performance-dashboard-status";
    status.setAttribute("role", "status");

    dialog.append(header, actions, output, status);
    host.appendChild(dialog);
    host.addEventListener("click", (event) => {
      if (event.target === host) this.hide();
    });
    host.addEventListener("keydown", this.onKeyDown);
    document.body.appendChild(host);

    this.host = host;
    this.dialog = dialog;
    this.output = output;
    this.status = status;
    this.closeButton = closeButton;
    return true;
  }

  createButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  show() {
    if (!this.ensureDOM()) return false;
    this.previousFocus = document.activeElement;
    this.host.hidden = false;
    this.host.setAttribute("aria-hidden", "false");
    this.refresh();
    this.closeButton?.focus();
    return true;
  }

  hide() {
    if (!this.host || this.host.hidden) return false;
    this.host.hidden = true;
    this.host.setAttribute("aria-hidden", "true");
    if (this.previousFocus?.isConnected && typeof this.previousFocus.focus === "function")
      this.previousFocus.focus();
    this.previousFocus = null;
    return true;
  }

  appendMetricGroup(title, entries) {
    const group = document.createElement("section");
    group.className = "nce-performance-dashboard-group";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const list = document.createElement("dl");
    for (const [label, value] of entries) {
      const term = document.createElement("dt");
      term.textContent = label;
      const definition = document.createElement("dd");
      definition.textContent = String(value);
      list.append(term, definition);
    }
    group.append(heading, list);
    this.output.appendChild(group);
  }

  formatMeasure(snapshot, name) {
    const measure = snapshot?.measures?.[name];
    if (!measure) return "—";
    return `${measure.count} · avg ${measure.averageMs.toFixed(1)} ms · max ${measure.maxMs.toFixed(1)} ms`;
  }

  refresh() {
    if (!this.output) return false;
    const snapshot = this.getMetrics()?.snapshot?.();
    this.output.replaceChildren();
    if (!snapshot) {
      this.status.textContent = "Performance metrics are unavailable.";
      return false;
    }
    const counters = snapshot.counters || {};
    const value = (name) => counters[name] ?? 0;
    const firstFileReady = snapshot.entries?.some(
      (entry) => entry.type === "mark" && entry.name === "files.first.initialChunkReady",
    ) === true;
    this.appendMetricGroup("Startup and restore", [
      ["Renderer ready", this.formatMeasure(snapshot, "startup.rendererReady")],
      ["Workspace restore", this.formatMeasure(snapshot, "workspace.restore")],
      ["First file ready", firstFileReady ? "Yes" : "No"],
      ["No-workspace restore", this.formatMeasure(snapshot, "workspace.restore.noWorkspace")],
    ]);
    this.appendMetricGroup("Bundles and workspace", [
      ["Agent bundle loads", value("renderer.bundle.agent.loads")],
      ["Markdown bundle loads", value("renderer.bundle.markdown.loads")],
      ["Quick Open list requests", value("quickOpen.fileListRequests")],
      ["Workspace Search requests", value("workspaceSearch.requests")],
      ["Workspace Search files scanned", value("workspaceSearch.filesScanned")],
      ["File read requests", value("files.read.requests")],
      ["Lines loaded", value("files.read.lines")],
    ]);
    this.appendMetricGroup("Layout and scrollers", [
      ["Layout requests", value("layout.requests")],
      ["Layout frames", value("layout.frames")],
      ["Layout flushes", value("layout.flushes")],
      ["Scroller refreshes", value("scrollers.refreshes")],
      ["Scroller metric reads", value("scrollers.metricReads")],
    ]);
    this.appendMetricGroup("Auto Save", [
      ["Schedules", value("autosave.schedules")],
      ["Flushes", value("autosave.flushes")],
      ["Write attempts", value("autosave.writeAttempts")],
      ["Persisted writes", value("autosave.persistedWrites")],
      ["Failures", value("autosave.failures")],
    ]);
    this.status.textContent = `Buffer: ${snapshot.eventCount} / ${snapshot.capacity} events · ${Object.keys(counters).length} counters`;
    return true;
  }

  reset() {
    const metrics = this.getMetrics();
    if (!metrics?.reset) return false;
    metrics.reset();
    this.refresh();
    this.status.textContent = "Performance metrics reset.";
    return true;
  }

  async copyReport() {
    const snapshot = this.getMetrics()?.snapshot?.();
    if (!snapshot || typeof this.editor.api?.writeClipboardText !== "function") {
      if (this.status) this.status.textContent = "Clipboard is unavailable.";
      return false;
    }
    const report = JSON.stringify(snapshot, null, 2);
    try {
      await this.editor.api.writeClipboardText(report);
      if (this.status)
        this.status.textContent = `Copied performance report (${new TextEncoder().encode(report).length} bytes).`;
      return true;
    } catch {
      if (this.status) this.status.textContent = "Could not copy performance report.";
      return false;
    }
  }

  destroy() {
    this.host?.remove();
    this.host = null;
    this.dialog = null;
    this.output = null;
    this.status = null;
    this.closeButton = null;
    this.focusableElements = [];
    this.previousFocus = null;
  }
}
