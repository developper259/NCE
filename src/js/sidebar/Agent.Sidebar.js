class AgentSidebar extends Sidebar {
  constructor(editor) {
    super("agent", "Agent", "fi fi-rr-sparkles", "right", editor);

    this.container = null;
    this.tabsElement = null;
    this.messagesElement = null;
    this.changesElement = null;
    this.inputElement = null;
    this.sendButton = null;

    this.sessions = [];
    this.activeSessionId = null;

    this._sessionCounter = 0;

    this.createSession();
  }

  render() {
    if (this.container) {
      this.updateView();
      return this.container;
    }

    const container = document.createElement("div");
    container.className = "agent-sidebar-container";
    this.container = container;

    container.appendChild(this.renderHeader());

    const tabs = document.createElement("div");
    tabs.className = "agent-sidebar-tabs";
    this.tabsElement = tabs;
    this.renderTabs(tabs);
    container.appendChild(tabs);

    const messages = document.createElement("div");
    messages.className = "agent-sidebar-messages";
    this.messagesElement = messages;
    this.renderMessages(messages);
    container.appendChild(messages);

    const changes = document.createElement("div");
    changes.className = "agent-sidebar-changes";
    this.changesElement = changes;
    this.renderChangesPanel(changes);
    container.appendChild(changes);

    container.appendChild(this.renderInputArea());

    return container;
  }

  renderHeader() {
    const header = document.createElement("div");
    header.className = "sidebar-main-title agent-sidebar-header";

    const title = document.createElement("span");
    title.textContent = "AGENT";
    header.appendChild(title);

    return header;
  }

  renderTabs(container) {
    container.innerHTML = "";

    for (const session of this.sessions) {
      container.appendChild(this.createTabElement(session));
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "agent-sidebar-tab-add";
    addButton.title = "New conversation";

    const addIcon = document.createElement("i");
    addIcon.className = "fi fi-rr-plus";
    addButton.appendChild(addIcon);

    addButton.addEventListener("click", () => {
      this.startNewConversation();
    });

    container.appendChild(addButton);
  }

  createTabElement(session) {
    const tab = document.createElement("div");
    tab.className = "agent-sidebar-tab";
    tab.classList.toggle(
      "agent-sidebar-tab-active",
      session.id === this.activeSessionId,
    );
    tab.dataset.sessionId = session.id;

    if (session.isGenerating) {
      const dot = document.createElement("span");
      dot.className = "agent-sidebar-tab-generating-dot";
      tab.appendChild(dot);
    }

    const title = document.createElement("span");
    title.className = "agent-sidebar-tab-title";
    title.textContent = session.title;
    tab.appendChild(title);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "agent-sidebar-tab-close";
    closeButton.title = "Close conversation";

    const closeIcon = document.createElement("i");
    closeIcon.className = "fi fi-rr-cross-small";
    closeButton.appendChild(closeIcon);

    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.closeSession(session.id);
    });

    tab.appendChild(closeButton);

    tab.addEventListener("click", () => {
      this.switchToSession(session.id);
    });

    return tab;
  }

  renderInputArea() {
    const inputArea = document.createElement("div");
    inputArea.className = "agent-sidebar-input-area";

    const inputWrapper = document.createElement("div");
    inputWrapper.className = "agent-sidebar-input-wrapper";

    const textarea = document.createElement("textarea");
    textarea.className = "agent-sidebar-input";
    textarea.placeholder = "Ask the agent…";
    textarea.rows = 1;
    textarea.value = this.getActiveSession()?.draft || "";
    this.inputElement = textarea;

    textarea.addEventListener("input", () => {
      const session = this.getActiveSession();
      if (session) {
        session.draft = textarea.value;
      }
      this.autoResizeInput();
      this.updateView();
    });

    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.handleSendClick();
      }
    });

    inputWrapper.appendChild(textarea);

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "agent-sidebar-send";
    sendButton.title = "Send";

    const sendIcon = document.createElement("i");
    sendIcon.className = "fi fi-rr-paper-plane";
    sendButton.appendChild(sendIcon);

    sendButton.addEventListener("click", () => {
      this.handleSendClick();
    });

    this.sendButton = sendButton;
    inputWrapper.appendChild(sendButton);

    inputArea.appendChild(inputWrapper);

    const hint = document.createElement("div");
    hint.className = "agent-sidebar-hint";
    this.hintElement = hint;
    inputArea.appendChild(hint);

    return inputArea;
  }

  renderMessages(container) {
    container.innerHTML = "";

    const session = this.getActiveSession();

    if (!session || (session.messages.length === 0 && !session.isGenerating)) {
      container.appendChild(this.createEmptyState());
      return;
    }

    for (const message of session.messages) {
      container.appendChild(this.createMessageElement(message));
    }

    if (session.isGenerating) {
      container.appendChild(this.createTypingIndicator());
    }

    if (session.queue && session.queue.length > 0) {
      session.queue.forEach((queuedContent, index) => {
        container.appendChild(
          this.createMessageElement(
            { role: "user", content: queuedContent },
            {
              queued: true,
              onCancel: () => this.cancelQueuedMessage(session.id, index),
            },
          ),
        );
      });
    }
  }

  createEmptyState() {
    const empty = document.createElement("div");
    empty.className = "agent-sidebar-empty-state";

    const icon = document.createElement("i");
    icon.className = "fi fi-rr-sparkles agent-sidebar-empty-icon";
    empty.appendChild(icon);

    const text = document.createElement("div");
    text.className = "agent-sidebar-empty-text";
    text.textContent = "Ask the agent anything about your project.";
    empty.appendChild(text);

    return empty;
  }

  createMessageElement(message, options = {}) {
    const row = document.createElement("div");
    row.className = `agent-sidebar-message agent-sidebar-message-${message.role}`;
    if (options.queued) {
      row.classList.add("agent-sidebar-message-queued");
    }

    const bubble = document.createElement("div");
    bubble.className = "agent-sidebar-bubble";
    bubble.textContent = message.content;

    bubble.style.userSelect = "text";
    bubble.style.WebkitUserSelect = "text";
    bubble.style.cursor = "text";

    row.appendChild(bubble);

    if (options.queued) {
      const status = document.createElement("div");
      status.className = "agent-sidebar-timestamp agent-sidebar-queued-label";

      const labelText = document.createElement("span");
      labelText.textContent = "En attente…";
      status.appendChild(labelText);

      if (options.onCancel) {
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.innerHTML = '<i class="fi fi-rr-cross-small"></i>';
        cancelBtn.title = "Annuler";
        cancelBtn.style.background = "none";
        cancelBtn.style.border = "none";
        cancelBtn.style.color = "inherit";
        cancelBtn.style.cursor = "pointer";
        cancelBtn.style.padding = "0";
        cancelBtn.style.display = "flex";
        cancelBtn.style.alignItems = "center";

        cancelBtn.addEventListener("click", options.onCancel);
        status.appendChild(cancelBtn);
      }

      row.appendChild(status);
    } else if (message.timestamp) {
      const time = document.createElement("div");
      time.className = "agent-sidebar-timestamp";
      time.textContent = message.timestamp;
      row.appendChild(time);
    }

    return row;
  }

  createTypingIndicator() {
    const row = document.createElement("div");
    row.className = "agent-sidebar-message agent-sidebar-message-agent";

    const bubble = document.createElement("div");
    bubble.className = "agent-sidebar-bubble agent-sidebar-typing";

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "agent-sidebar-typing-dot";
      bubble.appendChild(dot);
    }

    row.appendChild(bubble);
    return row;
  }

  renderChangesPanel(container) {
    container.innerHTML = "";

    const session = this.getActiveSession();

    if (!session || !session.changes || session.changes.length === 0) {
      container.classList.add("agent-sidebar-changes-hidden");
      return;
    }

    container.classList.remove("agent-sidebar-changes-hidden");
    container.classList.toggle(
      "agent-sidebar-changes-collapsed",
      !session.changesExpanded,
    );

    container.appendChild(this.createChangesHeader(session));
    container.appendChild(this.createChangesList(session));
  }

  createChangesHeader(session) {
    const header = document.createElement("button");
    header.type = "button";
    header.className = "agent-sidebar-changes-header";

    const chevron = document.createElement("i");
    chevron.className =
      "fi fi-rr-angle-small-right agent-sidebar-changes-chevron";
    header.appendChild(chevron);

    const label = document.createElement("span");
    label.className = "agent-sidebar-changes-label";
    const count = session.changes.length;
    label.textContent = `${count} ${count > 1 ? "fichiers modifiés" : "fichier modifié"}`;
    header.appendChild(label);

    const stats = this.getSessionChangeStats(session);

    const statsWrap = document.createElement("span");
    statsWrap.className = "agent-sidebar-changes-total-stats";

    if (stats.additions) {
      const add = document.createElement("span");
      add.className = "change-stat-add";
      add.textContent = `+${stats.additions}`;
      statsWrap.appendChild(add);
    }

    if (stats.deletions) {
      const del = document.createElement("span");
      del.className = "change-stat-del";
      del.textContent = `-${stats.deletions}`;
      statsWrap.appendChild(del);
    }

    header.appendChild(statsWrap);

    header.addEventListener("click", () => {
      this.toggleChangesPanel(session.id);
    });

    return header;
  }

  createChangesList(session) {
    const list = document.createElement("ul");
    list.className = "agent-sidebar-changes-list";

    for (const change of session.changes) {
      list.appendChild(this.createChangeElement(change));
    }

    return list;
  }

  getStatusLetter(status) {
    switch (status) {
      case "added":
        return "A";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "modified":
      default:
        return "M";
    }
  }

  createChangeElement(change) {
    const li = document.createElement("li");
    li.className = "agent-sidebar-change-el";
    li.dataset.path = change.path;

    const status = change.status || "modified";

    const statusSpan = document.createElement("span");
    statusSpan.className = `agent-sidebar-change-status agent-sidebar-change-status-${status}`;
    statusSpan.textContent = this.getStatusLetter(status);
    li.appendChild(statusSpan);

    const nameSpan = document.createElement("span");
    nameSpan.className = "agent-sidebar-change-name";
    nameSpan.textContent = change.name || change.path.split("/").pop();
    nameSpan.title = change.path;
    li.appendChild(nameSpan);

    const statsSpan = document.createElement("span");
    statsSpan.className = "agent-sidebar-change-stats";

    if (change.additions) {
      const add = document.createElement("span");
      add.className = "change-stat-add";
      add.textContent = `+${change.additions}`;
      statsSpan.appendChild(add);
    }

    if (change.deletions) {
      const del = document.createElement("span");
      del.className = "change-stat-del";
      del.textContent = `-${change.deletions}`;
      statsSpan.appendChild(del);
    }

    li.appendChild(statsSpan);

    li.addEventListener("click", () => {
      this.openChange(change);
    });

    return li;
  }

  getSessionChangeStats(session) {
    let additions = 0;
    let deletions = 0;

    if (session.changes) {
      for (const change of session.changes) {
        if (change.additions) additions += change.additions;
        if (change.deletions) deletions += change.deletions;
      }
    }

    return { additions, deletions };
  }

  toggleChangesPanel(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.changesExpanded = !session.changesExpanded;
    this.refresh();
  }

  openChange(change) {
    this.editor.tabManager.openFileWithPath(change.path);
  }

  addSimulatedChange(sessionId, path, status, additions, deletions) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const name = path.split("/").pop();

    session.changes.push({
      path,
      name,
      status,
      additions,
      deletions,
    });

    this.refresh();
  }

  updateView() {
    if (this.tabsElement) {
      this.renderTabs(this.tabsElement);
    }

    if (this.messagesElement) {
      this.renderMessages(this.messagesElement);
      this.scrollMessagesToBottom();
    }

    if (this.changesElement) {
      this.renderChangesPanel(this.changesElement);
    }

    const session = this.getActiveSession();

    if (this.sendButton) {
      const icon = this.sendButton.querySelector("i");
      const isGenerating = !!session?.isGenerating;
      const draft = (session?.draft || "").trim();

      if (icon) {
        if (isGenerating && draft === "") {
          icon.className = "fi fi-rr-square";
          this.sendButton.title = "Stop";
        } else if (isGenerating && draft !== "") {
          icon.className = "fi fi-rr-paper-plane";
          this.sendButton.title = "Add to queue";
        } else {
          icon.className = "fi fi-rr-paper-plane";
          this.sendButton.title = "Send";
        }
      }

      this.sendButton.classList.toggle(
        "agent-sidebar-send-queue",
        isGenerating,
      );
    }

    if (this.messagesElement) {
      const hasQueue = !!session?.queue?.length;
      this.messagesElement.classList.toggle(
        "agent-sidebar-messages-has-queue",
        hasQueue,
      );
    }

    if (this.inputElement) {
      const draft = session?.draft || "";
      if (this.inputElement.value !== draft) {
        this.inputElement.value = draft;
      }
      this.autoResizeInput();
    }

    if (this.hintElement) {
      const queueLength = session?.queue?.length || 0;
      if (queueLength > 0) {
        this.hintElement.textContent =
          queueLength === 1
            ? "1 message en file d'attente · sera envoyé après la réponse en cours"
            : `${queueLength} messages en file d'attente · seront envoyés après la réponse en cours`;
      } else {
        this.hintElement.textContent = "";
      }
    }
  }

  refresh() {
    if (!this.container) {
      return;
    }
    this.updateView();
  }

  autoResizeInput() {
    if (!this.inputElement) return;
    this.inputElement.style.height = "auto";
    this.inputElement.style.height = `${this.inputElement.scrollHeight}px`;
  }

  scrollMessagesToBottom() {
    if (!this.messagesElement) return;
    this.messagesElement.scrollTop = this.messagesElement.scrollHeight;
  }

  focusInput() {
    requestAnimationFrame(() => {
      if (this.inputElement) {
        this.inputElement.focus({ preventScroll: true });
      }
    });
  }

  formatTime(date = new Date()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  generateSessionId() {
    this._sessionCounter += 1;
    return `session-${Date.now()}-${this._sessionCounter}`;
  }

  handleSendClick() {
    const session = this.getActiveSession();
    if (!session) return;

    const content = (session.draft || "").trim();

    if (session.isGenerating) {
      if (!content) {
        this.stopGeneration(session.id);
      } else {
        this.queueMessage(session.id, content);
      }
      return;
    }

    if (!content) return;
    this.sendMessage(content);
  }

  createSession() {
    const session = {
      id: this.generateSessionId(),
      title: "New chat",
      messages: [],
      draft: "",
      isGenerating: false,
      pendingTimeout: null,
      queue: [],
      changes: [],
      changesExpanded: true,
    };

    this.sessions.push(session);
    this.activeSessionId = session.id;

    this.refresh();
    this.focusInput();

    return session;
  }

  getActiveSession() {
    return this.sessions.find((s) => s.id === this.activeSessionId) || null;
  }

  getSession(sessionId) {
    return this.sessions.find((s) => s.id === sessionId) || null;
  }

  switchToSession(sessionId) {
    if (sessionId === this.activeSessionId) return;
    if (!this.getSession(sessionId)) return;

    this.activeSessionId = sessionId;

    this.refresh();
    this.focusInput();
  }

  closeSession(sessionId) {
    const index = this.sessions.findIndex((s) => s.id === sessionId);
    if (index === -1) return;

    const session = this.sessions[index];
    if (session.pendingTimeout) {
      clearTimeout(session.pendingTimeout);
    }

    this.sessions.splice(index, 1);

    if (this.sessions.length === 0) {
      this.createSession();
      return;
    }

    if (this.activeSessionId === sessionId) {
      const fallback = this.sessions[Math.max(0, index - 1)];
      this.activeSessionId = fallback.id;
    }

    this.refresh();
  }

  startNewConversation() {
    this.createSession();
  }

  renameSessionFromContent(session, content) {
    if (session.title !== "New chat") return;
    const trimmed = content.trim();
    session.title = trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
  }

  stopGeneration(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    if (session.pendingTimeout) {
      clearTimeout(session.pendingTimeout);
      session.pendingTimeout = null;

      session.messages.push({
        role: "agent",
        content: "Génération interrompue.",
        timestamp: this.formatTime(),
      });
    }

    session.isGenerating = false;

    this.processQueue(session.id);

    this.refresh();
  }

  cancelQueuedMessage(sessionId, index) {
    const session = this.getSession(sessionId);
    if (!session || !session.queue) return;

    session.queue.splice(index, 1);
    this.refresh();
  }

  sendMessage(content, sessionId = this.activeSessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    session.messages.push({
      role: "user",
      content,
      timestamp: this.formatTime(),
    });

    this.renameSessionFromContent(session, content);

    if (session.id === this.activeSessionId) {
      session.draft = "";
    }
    session.isGenerating = true;

    this.refresh();
    this.focusInput();

    const fakeDelay = 1500 + Math.random() * 1500;

    session.pendingTimeout = setTimeout(() => {
      session.pendingTimeout = null;
      session.isGenerating = false;

      session.messages.push({
        role: "agent",
        content: this.generateFakeResponse(content),
        timestamp: this.formatTime(),
      });

      this.processQueue(session.id);
    }, fakeDelay);
  }

  generateFakeResponse(content) {
    return `Réponse simulée à : "${content}"`;
  }

  queueMessage(sessionId, content) {
    const session = this.getSession(sessionId);
    if (!session) return;

    session.queue = session.queue || [];
    session.queue.push(content);

    if (session.id === this.activeSessionId) {
      session.draft = "";
    }

    this.refresh();
    this.focusInput();
  }

  processQueue(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    if (session.queue && session.queue.length > 0) {
      const next = session.queue.shift();
      this.sendMessage(next, session.id);
      return;
    }

    this.refresh();
  }

  onOpen() {
    this.refresh();
    this.focusInput();
  }

  onClose() {}
}
