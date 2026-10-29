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
      this.refresh();
    });
  }

  render() {
    if (this.loadingError) return this.renderLoadError();
    return this.renderSkeleton();
  }

  renderSkeleton() {
    const container = document.createElement("div");
    container.className = "agent-sidebar-container agent-lazy-shell";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-label", "Chargement de l'Agent");

    const header = document.createElement("div");
    header.className = "sidebar-main-title agent-sidebar-header";
    const title = document.createElement("span");
    title.textContent = "AGENT";
    header.appendChild(title);
    container.appendChild(header);

    const tabs = document.createElement("div");
    tabs.className = "agent-sidebar-tabs agent-lazy-tabs";
    tabs.setAttribute("aria-hidden", "true");
    const tab = document.createElement("div");
    tab.className = "agent-sidebar-tab agent-sidebar-tab-active agent-lazy-tab";
    const tabLine = document.createElement("span");
    tabLine.className = "agent-lazy-line agent-lazy-line-tab";
    tab.appendChild(tabLine);
    const addButton = document.createElement("span");
    addButton.className = "agent-lazy-add";
    tabs.append(tab, addButton);
    container.appendChild(tabs);

    const messages = document.createElement("div");
    messages.className = "agent-sidebar-messages-viewport agent-lazy-messages";
    messages.setAttribute("aria-hidden", "true");
    messages.append(
      this.createLazyBubble("agent", ["agent-lazy-line-long", "agent-lazy-line-medium"]),
      this.createLazyBubble("user", ["agent-lazy-line-medium", "agent-lazy-line-short"]),
      this.createLazyBubble("agent", ["agent-lazy-line-short", "agent-lazy-line-long", "agent-lazy-line-medium"]),
    );
    container.appendChild(messages);

    const composer = document.createElement("div");
    composer.className = "agent-sidebar-input-area agent-lazy-composer";
    composer.setAttribute("aria-hidden", "true");
    const input = document.createElement("div");
    input.className = "agent-sidebar-input-wrapper agent-lazy-input";
    const lines = document.createElement("div");
    lines.className = "agent-lazy-input-lines";
    lines.append(
      this.createLazyLine("agent-lazy-line-medium"),
      this.createLazyLine("agent-lazy-line-short"),
    );
    const toolbar = document.createElement("div");
    toolbar.className = "agent-sidebar-input-toolbar agent-lazy-toolbar";
    for (let index = 0; index < 2; index += 1) {
      const chip = document.createElement("span");
      chip.className = "agent-lazy-chip";
      toolbar.appendChild(chip);
    }
    const send = document.createElement("span");
    send.className = "agent-lazy-send";
    toolbar.appendChild(send);
    input.append(lines, toolbar);
    composer.appendChild(input);
    container.appendChild(composer);

    return container;
  }

  createLazyBubble(role, lineClasses) {
    const bubble = document.createElement("div");
    bubble.className = `agent-lazy-bubble agent-lazy-bubble-${role}`;
    for (const lineClass of lineClasses)
      bubble.appendChild(this.createLazyLine(lineClass));
    return bubble;
  }

  createLazyLine(className) {
    const line = document.createElement("span");
    line.className = `agent-lazy-line ${className}`;
    return line;
  }

  renderLoadError() {
    const container = document.createElement("div");
    container.className = "agent-sidebar-container agent-lazy-shell";

    const header = document.createElement("div");
    header.className = "sidebar-main-title agent-sidebar-header";
    const title = document.createElement("span");
    title.textContent = "AGENT";
    header.appendChild(title);
    container.appendChild(header);

    const row = document.createElement("div");
    row.className = "agent-state-row";
    const card = document.createElement("div");
    card.className = "agent-state-card agent-state-error";
    card.setAttribute("role", "alert");
    card.setAttribute("aria-live", "assertive");

    const icon = document.createElement("div");
    icon.className = "agent-state-icon";
    icon.setAttribute("aria-hidden", "true");
    const iconElement = document.createElement("i");
    iconElement.className = "fi fi-rr-triangle-warning";
    icon.appendChild(iconElement);

    const copy = document.createElement("div");
    copy.className = "agent-state-copy";
    const heading = document.createElement("div");
    heading.className = "agent-state-title";
    heading.textContent = "L'Agent n'a pas pu être chargé";
    const description = document.createElement("div");
    description.className = "agent-state-description";
    description.textContent = "Le panneau Agent n'a pas pu être initialisé.";
    const hint = document.createElement("div");
    hint.className = "agent-state-hint";
    hint.textContent = "Fermez puis rouvrez le panneau pour réessayer.";
    copy.append(heading, description, hint);
    card.append(icon, copy);
    row.appendChild(card);
    container.appendChild(row);

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
