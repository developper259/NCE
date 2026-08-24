class AgentSidebar extends Sidebar {
  constructor(editor) {
    super("agent", "Agent", "fi fi-rr-sparkles", "right", editor);

    this.container = null;
    this.tabsElement = null;
    this.messagesElement = null;
    this.changesElement = null;
    this.inputElement = null;
    this.sendButton = null;

    this.pendingConfirmation = null;
    this.apiKeys = new Map();
    this.apiKeyPanel = null;

    this.agent = new Agent(editor);
    this.agent.setCallbacks({
      onToolStart: (toolName, args) => {
        this.appendToolReasoning(toolName, args);
      },
      onToolAskConfirmation: (toolName, args, accept, reject) => {
        this.pendingConfirmation = { toolName, args, accept, reject };
        this.refresh();
      },
      onToolEnd: (toolName, result) => {
        const payload = result?.result ?? result;

        if (
          toolName !== "modify_active_file" ||
          !payload ||
          payload.success !== true
        ) {
          return;
        }

        const session = this.getActiveSession();
        if (!session) return;

        const filePath = typeof payload.path === "string" ? payload.path : "";
        if (!filePath) return;

        const beforeText =
          typeof payload.beforeText === "string" ? payload.beforeText : "";
        const afterText =
          typeof payload.afterText === "string" ? payload.afterText : "";
        const beforeLines = beforeText ? beforeText.split("\n") : [];
        const afterLines = afterText ? afterText.split("\n") : [];

        const diffStats = this.getLineDiffStats(beforeLines, afterLines);

        const change = {
          path: filePath,
          name: filePath.split("/").pop() || "fichier",
          status: "modified",
          additions: diffStats.additions,
          deletions: diffStats.deletions,
        };

        const existingIndex = session.changes.findIndex(
          (entry) => entry.path === filePath,
        );
        if (existingIndex >= 0) {
          session.changes[existingIndex] = {
            ...session.changes[existingIndex],
            ...change,
          };
        } else {
          session.changes.push(change);
        }

        session.changesExpanded = true;
        this.refresh();
      },
    });

    this.currentAgentId = AgentAI.defaultAgent || "coder";
    const resolvedConfig = AgentAI.resolve(this.currentAgentId);

    this.currentProviderId = resolvedConfig.provider.id;
    this.currentModel = resolvedConfig.model;

    this.agent.setProvider({
      baseURL: resolvedConfig.provider.baseURL,
      apiKey: this.apiKeys.get(resolvedConfig.provider.id) || null,
    });
    this.agent.setModel(this.currentModel);
    this.agent.setSystemPrompt(resolvedConfig.systemPrompt);

    this.sessions = [];
    this.activeSessionId = null;
    this._sessionCounter = 0;

    this.createSession();
  }

  getConfigState() {
    return {
      currentAgentId: this.currentAgentId,
      currentProviderId: this.currentProviderId,
      currentModel: this.currentModel,
      apiKeys: Object.fromEntries(this.apiKeys),
    };
  }

  loadConfigState(state) {
    if (!state || typeof state !== "object") return;

    if (typeof state.currentAgentId === "string") {
      this.currentAgentId = state.currentAgentId;
    }
    if (typeof state.currentProviderId === "string") {
      this.currentProviderId = state.currentProviderId;
    }
    if (typeof state.currentModel === "string") {
      this.currentModel = state.currentModel;
    }

    if (state.apiKeys && typeof state.apiKeys === "object") {
      for (const [providerId, apiKey] of Object.entries(state.apiKeys)) {
        if (
          typeof providerId === "string" &&
          typeof apiKey === "string" &&
          apiKey.trim()
        ) {
          this.apiKeys.set(providerId, apiKey);
        }
      }
    }

    const provider = AgentAI.getProvider(this.currentProviderId);
    if (!provider) return;

    this.agent.setProvider({
      baseURL: provider.baseURL,
      apiKey: this.apiKeys.get(provider.id) || null,
    });
    this.agent.setModel(this.currentModel || provider.defaultModel);
    const mode = AgentAI.getAgent(this.currentAgentId);
    if (mode?.systemPrompt) {
      this.agent.setSystemPrompt(mode.systemPrompt);
    }
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

    const titleWrap = document.createElement("div");
    titleWrap.style.display = "flex";
    titleWrap.style.alignItems = "center";
    titleWrap.style.gap = "8px";

    const title = document.createElement("span");
    title.textContent = "AGENT";
    titleWrap.appendChild(title);

    header.appendChild(titleWrap);

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

  describeToolAction(toolName, args = {}) {
    const q = typeof args?.query === "string" ? args.query.trim() : "";
    const path = typeof args?.path === "string" ? args.path.trim() : "";
    const startLine = Number.isInteger(args?.startLine) ? args.startLine : null;
    const endLine = Number.isInteger(args?.endLine) ? args.endLine : null;
    const fileName = path ? path.split("/").pop() || path : "file";

    switch (toolName) {
      case "search_active_file":
        return q ? `search in file "${q}"` : 'search in file ""';
      case "search_project_files":
        return q ? `search in workspace "${q}"` : 'search in workspace ""';
      case "read_active_file":
        return startLine && endLine
          ? `read file "${fileName}" line ${startLine} to ${endLine}`
          : `read file "${fileName}" line 1`;
      case "read_file":
        return path
          ? `read file "${fileName}" line 1`
          : 'read file "file" line 1';
      case "list_project_files":
        return path ? `list files in "${path}"` : "list files in project";
      case "modify_active_file":
        return "modify active file";
      case "get_editor_context":
        return "get editor context";
      case "read_selection":
        return "read selection";
      default:
        return `${toolName}`;
    }
  }

  appendToolReasoning(toolName, args = {}) {
    const session = this.getActiveSession();
    if (!session) return;

    const summary = this.describeToolAction(toolName, args);
    session.messages.push({
      role: "agent",
      reasoning: summary,
      timestamp: this.formatTime(),
    });

    this.refresh();
    this.scrollMessagesToBottom();
  }

  renderInputArea() {
    const inputArea = document.createElement("div");
    inputArea.className = "agent-sidebar-input-area";

    const inputWrapper = document.createElement("div");
    inputWrapper.className = "agent-sidebar-input-wrapper";

    const textarea = document.createElement("textarea");
    textarea.className = "agent-sidebar-input";
    textarea.placeholder = "Describe what you want to build...";
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

    const toolbar = document.createElement("div");
    toolbar.className = "agent-sidebar-input-toolbar";

    const positionSelectorMenu = (menu, container) => {
      const containerRect = container.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = `${containerRect.left}px`;
      menu.style.right = "auto";
      menu.style.bottom = `${window.innerHeight - containerRect.top + 4}px`;

      requestAnimationFrame(() => {
        const menuRect = menu.getBoundingClientRect();
        const edgePadding = 8;
        let left = containerRect.left;

        if (menuRect.right > window.innerWidth - edgePadding) {
          left = window.innerWidth - menuRect.width - edgePadding;
        }

        menu.style.left = `${Math.max(edgePadding, left)}px`;
      });
    };

    const modeDropdownContainer = document.createElement("div");
    modeDropdownContainer.className =
      "agent-sidebar-model-dropdown-container agent-sidebar-mode-selector";

    const modeTrigger = document.createElement("button");
    modeTrigger.type = "button";
    modeTrigger.className =
      "agent-sidebar-model-trigger agent-sidebar-mode-trigger";
    modeTrigger.title = "Change mode";
    modeTrigger.setAttribute("aria-label", "Change mode");
    const currentAgent = AgentAI.getAgent(this.currentAgentId);
    modeTrigger.innerHTML = `
      <i class="fi fi-rr-settings-sliders"></i>
      <span class="trigger-label">${currentAgent?.name || "Mode"}</span>
    `;

    const modeMenu = document.createElement("div");
    modeMenu.className =
      "agent-sidebar-model-menu agent-sidebar-mode-menu hidden";
    const modeList = document.createElement("div");
    modeList.className = "agent-sidebar-model-list";
    modeMenu.appendChild(modeList);
    document.body.appendChild(modeMenu);

    const renderModes = () => {
      modeList.innerHTML = "";
      for (const mode of AgentAI.getAgents()) {
        const item = document.createElement("div");
        item.className = "agent-sidebar-model-item";
        if (mode.id === this.currentAgentId) item.classList.add("active");

        const icon = document.createElement("i");
        icon.className = "fi fi-rr-check";
        icon.style.opacity = mode.id === this.currentAgentId ? "1" : "0";

        const textWrap = document.createElement("div");
        textWrap.style.display = "flex";
        textWrap.style.flexDirection = "column";

        const name = document.createElement("span");
        name.textContent = mode.name;
        textWrap.appendChild(name);
        item.append(icon, textWrap);

        item.addEventListener("click", () => {
          const resolved = AgentAI.resolve(mode.id);
          this.currentAgentId = mode.id;
          this.agent.setModel(this.currentModel);
          this.agent.setSystemPrompt(resolved.systemPrompt);
          modeTrigger.querySelector(".trigger-label").textContent = mode.name;
          renderModes();
          modeMenu.classList.add("hidden");
          this.editor.statesManager?.save();
        });
        modeList.appendChild(item);
      }
    };

    renderModes();
    modeTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      dropdownMenu?.classList.add("hidden");
      modeMenu.classList.toggle("hidden");
      if (!modeMenu.classList.contains("hidden")) {
        positionSelectorMenu(modeMenu, modeDropdownContainer);
      }
    });
    modeDropdownContainer.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    modeDropdownContainer.appendChild(modeTrigger);
    toolbar.appendChild(modeDropdownContainer);

    const modelDropdownContainer = document.createElement("div");
    modelDropdownContainer.className =
      "agent-sidebar-model-dropdown-container agent-sidebar-model-selector";

    const triggerBtn = document.createElement("button");
    triggerBtn.type = "button";
    triggerBtn.className =
      "agent-sidebar-model-trigger agent-sidebar-model-trigger-button";
    triggerBtn.title = "Change model";
    triggerBtn.setAttribute("aria-label", "Change model");

    const availableModels = [];
    Object.values(AgentAI.providers).forEach((provider) => {
      Object.values(provider.models).forEach((model) => {
        availableModels.push({
          id: model.id,
          name: model.name,
          providerId: provider.id,
          providerName: provider.name,
          baseURL: provider.baseURL,
          apiKey: provider.apiKey,
        });
      });
    });

    const currentModelObj =
      availableModels.find((m) => m.id === this.currentModel) ||
      availableModels[0];
    const currentDisplayName = currentModelObj
      ? currentModelObj.name
      : this.currentModel;

    triggerBtn.innerHTML = `
      <i class="fi fi-rr-robot"></i> 
      <span class="trigger-label">${currentDisplayName}</span>
    `;

    const dropdownMenu = document.createElement("div");
    dropdownMenu.className = "agent-sidebar-model-menu hidden";

    const searchBox = document.createElement("input");
    searchBox.type = "text";
    searchBox.className = "agent-sidebar-model-search";
    searchBox.placeholder = "Search models";
    dropdownMenu.appendChild(searchBox);

    const listContainer = document.createElement("div");
    listContainer.className = "agent-sidebar-model-list";
    dropdownMenu.appendChild(listContainer);
    document.body.appendChild(dropdownMenu);

    const renderModelsList = (filterText = "") => {
      listContainer.innerHTML = "";
      const filtered = availableModels.filter(
        (m) =>
          m.name.toLowerCase().includes(filterText.toLowerCase()) ||
          m.id.toLowerCase().includes(filterText.toLowerCase()) ||
          m.providerName.toLowerCase().includes(filterText.toLowerCase()),
      );

      filtered.forEach((m) => {
        const item = document.createElement("div");
        item.className = "agent-sidebar-model-item";
        const isActive =
          m.id === this.currentModel && m.providerId === this.currentProviderId;
        if (isActive) item.classList.add("active");

        const checkIcon = document.createElement("i");
        checkIcon.className = "fi fi-rr-check";
        checkIcon.style.opacity = isActive ? "1" : "0";

        const textWrap = document.createElement("div");
        textWrap.style.display = "flex";
        textWrap.style.flexDirection = "column";
        textWrap.style.gap = "2px";

        const titleSpan = document.createElement("span");
        titleSpan.textContent = m.name;

        const subSpan = document.createElement("span");
        subSpan.style.fontSize = "9px";
        subSpan.style.opacity = "0.6";
        subSpan.textContent = m.providerName;

        textWrap.appendChild(titleSpan);
        textWrap.appendChild(subSpan);

        item.appendChild(checkIcon);
        item.appendChild(textWrap);

        item.addEventListener("click", () => {
          this.currentModel = m.id;
          this.currentProviderId = m.providerId;

          this.agent.setProvider({
            baseURL: m.baseURL,
            apiKey: this.apiKeys.get(m.providerId) || null,
          });
          this.agent.setModel(m.id);
          const selectedAgent = AgentAI.getAgent(this.currentAgentId);
          if (selectedAgent?.systemPrompt) {
            this.agent.setSystemPrompt(selectedAgent.systemPrompt);
          }

          this.editor.statesManager?.save();

          triggerBtn.querySelector(".trigger-label").textContent = m.name;
          renderModelsList();
          dropdownMenu.classList.add("hidden");
        });

        listContainer.appendChild(item);
      });

      const separator = document.createElement("div");
      separator.className = "agent-sidebar-model-separator";
      listContainer.appendChild(separator);

      const manageItem = document.createElement("div");
      manageItem.className = "agent-sidebar-model-manage";
      manageItem.textContent = "Manage Models...";
      listContainer.appendChild(manageItem);
    };

    renderModelsList();

    searchBox.addEventListener("input", (e) => {
      renderModelsList(e.target.value);
    });

    triggerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      modeMenu.classList.add("hidden");
      dropdownMenu.classList.toggle("hidden");
      if (!dropdownMenu.classList.contains("hidden")) {
        positionSelectorMenu(dropdownMenu, modelDropdownContainer);
        searchBox.value = "";
        renderModelsList();
        searchBox.focus();
      }
    });

    document.addEventListener("click", (e) => {
      if (
        !modelDropdownContainer.contains(e.target) &&
        !modeDropdownContainer.contains(e.target) &&
        !dropdownMenu.contains(e.target) &&
        !modeMenu.contains(e.target)
      ) {
        dropdownMenu.classList.add("hidden");
        modeMenu.classList.add("hidden");
      }
    });

    modelDropdownContainer.appendChild(triggerBtn);

    toolbar.appendChild(modelDropdownContainer);

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "agent-sidebar-send";
    sendButton.title = "Send";

    const sendIcon = document.createElement("i");
    sendIcon.className = "fi fi-rr-arrow-up";
    sendButton.appendChild(sendIcon);

    sendButton.addEventListener("click", () => {
      this.handleSendClick();
    });

    this.sendButton = sendButton;
    toolbar.appendChild(sendButton);

    inputWrapper.appendChild(toolbar);
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

  normalizeReasoningValue(value) {
    if (!value) return "";

    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) {
      return value
        .map((entry) => this.normalizeReasoningValue(entry))
        .filter(Boolean)
        .join("\n");
    }
    if (typeof value === "object") {
      for (const key of [
        "text",
        "content",
        "value",
        "reasoning",
        "reasoning_content",
      ]) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          const extracted = this.normalizeReasoningValue(value[key]);
          if (extracted) return extracted;
        }
      }
      try {
        return JSON.stringify(value);
      } catch {
        return "";
      }
    }
    return String(value).trim();
  }

  createMessageElement(message, options = {}) {
    const row = document.createElement("div");
    const role = message?.role || "agent";
    row.className = `agent-sidebar-message agent-sidebar-message-${role}`;
    if (options.queued) {
      row.classList.add("agent-sidebar-message-queued");
    }

    const bubble = document.createElement("div");
    bubble.className = "agent-sidebar-bubble";

    const reasoning = this.normalizeReasoningValue(
      message?.reasoning ??
        message?.reasoning_content ??
        message?.reasoningText,
    );

    if (reasoning) {
      const reasoningToggle = document.createElement("button");
      reasoningToggle.type = "button";
      reasoningToggle.className = "agent-sidebar-reasoning-toggle";
      reasoningToggle.setAttribute("aria-expanded", "false");

      const reasoningIcon = document.createElement("i");
      reasoningIcon.className = "fi fi-rr-angle-small-right";
      reasoningToggle.appendChild(reasoningIcon);

      const reasoningLabel = document.createElement("span");
      reasoningLabel.textContent = "Reasoning";
      reasoningToggle.appendChild(reasoningLabel);

      const reasoningEl = document.createElement("div");
      reasoningEl.className = "agent-sidebar-reasoning";
      reasoningEl.textContent = reasoning;
      reasoningEl.hidden = true;

      reasoningToggle.addEventListener("click", () => {
        const expanded =
          reasoningToggle.getAttribute("aria-expanded") === "true";
        reasoningToggle.setAttribute("aria-expanded", String(!expanded));
        reasoningEl.hidden = expanded;
      });

      bubble.appendChild(reasoningToggle);
      bubble.appendChild(reasoningEl);
    }

    const contentValue =
      typeof message?.content === "string" ? message.content : "";
    if (contentValue) {
      const contentEl = document.createElement("div");
      contentEl.className = "agent-sidebar-content";
      contentEl.textContent = contentValue;
      bubble.appendChild(contentEl);
    }

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
    if (
      this.editor &&
      this.editor.tabManager &&
      typeof this.editor.tabManager.openFileWithPath === "function"
    ) {
      this.editor.tabManager.openFileWithPath(change.path);
    } else {
      console.warn(
        "tabManager.openFileWithPath n'est pas disponible pour ouvrir :",
        change.path,
      );
    }
  }

  getLineDiffStats(beforeLines = [], afterLines = []) {
    const source = Array.isArray(beforeLines) ? beforeLines : [];
    const target = Array.isArray(afterLines) ? afterLines : [];

    const rows = source.length + 1;
    const cols = target.length + 1;
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = source.length - 1; i >= 0; i -= 1) {
      for (let j = target.length - 1; j >= 0; j -= 1) {
        if (source[i] === target[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = 0;
    let j = 0;
    let additions = 0;
    let deletions = 0;

    while (i < source.length && j < target.length) {
      if (source[i] === target[j]) {
        i += 1;
        j += 1;
        continue;
      }

      if (dp[i + 1][j] >= dp[i][j + 1]) {
        deletions += 1;
        i += 1;
      } else {
        additions += 1;
        j += 1;
      }
    }

    while (i < source.length) {
      deletions += 1;
      i += 1;
    }

    while (j < target.length) {
      additions += 1;
      j += 1;
    }

    return { additions, deletions };
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
          icon.className = "fi fi-rr-arrow-up";
          this.sendButton.title = "Add to queue";
        } else {
          icon.className = "fi fi-rr-arrow-up";
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

  requestApiKey(provider) {
    if (!this.container) return Promise.resolve("");

    if (this.apiKeyPanel) {
      this.apiKeyPanel.input.focus();
      return this.apiKeyPanel.promise;
    }

    const overlay = document.createElement("div");
    overlay.className = "agent-sidebar-api-key-overlay";

    const panel = document.createElement("form");
    panel.className = "agent-sidebar-api-key-panel";

    const title = document.createElement("h3");
    title.textContent = `${provider.name} API key`;
    panel.appendChild(title);

    const description = document.createElement("p");
    description.textContent = "Enter your API key to use this model.";
    panel.appendChild(description);

    const input = document.createElement("input");
    input.type = "password";
    input.required = true;
    input.autocomplete = "off";
    input.placeholder = "API key";
    input.className = "agent-sidebar-api-key-input";
    panel.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "agent-sidebar-api-key-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.className = "agent-sidebar-api-key-cancel";

    const confirmButton = document.createElement("button");
    confirmButton.type = "submit";
    confirmButton.textContent = "Use key";
    confirmButton.className = "agent-sidebar-api-key-confirm";

    actions.append(cancelButton, confirmButton);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let resolveRequest;
    const promise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const close = (value) => {
      if (!this.apiKeyPanel) return;
      this.apiKeyPanel = null;
      overlay.remove();
      resolveRequest(value);
    };

    this.apiKeyPanel = { input, promise };
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (value) close(value);
    });
    cancelButton.addEventListener("click", () => close(""));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close("");
    });

    input.focus();
    return promise;
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
      abortController: null,
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

    if (session.abortController) {
      session.abortController.abort();
    }
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

    this.agent.stop();

    if (session.abortController) {
      session.abortController.abort();
      session.abortController = null;
    }

    if (session.pendingTimeout) {
      clearTimeout(session.pendingTimeout);
      session.pendingTimeout = null;
    }

    session.isGenerating = false;

    session.messages.push({
      role: "agent",
      content: "Génération interrompue.",
      timestamp: this.formatTime(),
    });

    this.processQueue(session.id);
    this.refresh();
  }

  cancelQueuedMessage(sessionId, index) {
    const session = this.getSession(sessionId);
    if (!session || !session.queue) return;

    session.queue.splice(index, 1);
    this.refresh();
  }

  async sendMessage(content, sessionId = this.activeSessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const provider = AgentAI.getProvider(this.currentProviderId);
    if (provider?.requiresApiKey && !this.apiKeys.get(provider.id)) {
      const apiKey = await this.requestApiKey(provider);
      if (!apiKey) return;
      this.apiKeys.set(provider.id, apiKey);
      this.agent.setProvider({
        baseURL: provider.baseURL,
        apiKey,
      });
      this.editor.statesManager?.save();
    }

    const messageHistory = session.messages
      .filter((m) => m && (m.role === "user" || m.role === "agent"))
      .filter((m) => {
        const text = typeof m.content === "string" ? m.content : "";
        return !text.startsWith("❌") && !text.startsWith("🚫");
      })
      .map((m) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : "",
      }));

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

    try {
      const result = await this.agent.execute(content, {
        history: messageHistory,
      });

      const agentReply =
        typeof result === "string"
          ? result
          : typeof result?.response === "string"
            ? result.response
            : "";
      const agentReasoning =
        typeof result === "object" && result
          ? this.normalizeReasoningValue(
              result.reasoning ??
                result.reasoning_content ??
                result.reasoningText,
            )
          : "";

      if (session.isGenerating) {
        session.messages.push({
          role: "agent",
          content: agentReply,
          reasoning: agentReasoning || undefined,
          timestamp: this.formatTime(),
        });
      }
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Requête Agent annulée par l'utilisateur.");
      } else {
        console.error("Erreur avec Agent:", error);
        session.messages.push({
          role: "agent",
          content: `Erreur de connexion à l'Agent: ${error.message}`,
          timestamp: this.formatTime(),
        });
      }
    } finally {
      session.isGenerating = false;

      this.processQueue(session.id);
      this.refresh();
      this.scrollMessagesToBottom();
    }
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
