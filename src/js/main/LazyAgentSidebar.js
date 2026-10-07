class LazyAgentSidebar extends Sidebar {
  constructor(editor) {
    super("agent", "Agent", "fi fi-rr-sparkles", "right", editor);
    this.loadingError = null;
    this.pendingConfigState = null;
    this.pendingScrollState = false;
  }

  ensureLoaded() {
    return this.editor.ensureAgentSidebar();
  }

  onOpen() {
    this.loadingError = null;
    void this.ensureLoaded().catch((error) => {
      this.loadingError = error;
      console.error("Failed to load Agent feature:", error);
    });
  }

  render() {
    const container = document.createElement("div");
    container.className = "agent-sidebar-loading";
    container.textContent = this.loadingError
      ? "Agent could not be loaded. Close and reopen this panel to retry."
      : "Loading Agent…";
    return container;
  }

  getConfigState() {
    return this.pendingConfigState;
  }

  loadConfigState(state) {
    if (state && typeof state === "object") this.pendingConfigState = state;
    return Promise.resolve();
  }

  restoreScrollState() {
    this.pendingScrollState = true;
  }

  refreshModelSelector() {}

  flushAllConversationSaves() {
    return Promise.resolve();
  }

  sendMessage(...args) {
    return this.ensureLoaded().then((sidebar) => sidebar.sendMessage(...args));
  }

  requestApiKey(...args) {
    return this.ensureLoaded().then((sidebar) => sidebar.requestApiKey(...args));
  }

  refreshProviderApiKey(...args) {
    return this.ensureLoaded().then((sidebar) => sidebar.refreshProviderApiKey(...args));
  }
}
