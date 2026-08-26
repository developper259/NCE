class AgentSidebar extends Sidebar {
  constructor(editor) {
    super("agent", "Agent", "fi fi-rr-sparkles", "right", editor);

    this.container = null;
    this.tabsElement = null;
    this.messagesElement = null;
    this.changesElement = null;
    this.inputElement = null;
    this.sendButton = null;
    this.typingIndicatorElement = null;
    this.markdownRenderer = new MarkdownRenderer({
      throttleMs: 50,
      getHighlightController: () => this.editor.highlightController,
    });
    this.messageElements = new WeakMap();
    this.activityElements = new WeakMap();
    this.activityItems = new Map();
    this.activityItemElements = new Map();
    this.pendingActivityItems = new Map();
    this._activityItemCounter = 0;

    this.apiKeys = new Map();
    this.apiKeyPanel = null;

    this.agent = editor.agent;
    this.agent.setCallbacks({
      onToken: (markdown, context) => {
        this.handleAgentToken(markdown, context);
      },
      onReasoning: (reasoning, context) => {
        this.handleAgentReasoning(reasoning, context);
      },
      onToolStart: (toolName, args, context) => {
        this.handleToolStart(toolName, args, context);
      },
      onToolEnd: (toolName, result, context, fullResult) => {
        this.handleToolEnd(toolName, result, context, fullResult);
      },
      onModelStatus: (event, context) => {
        this.handleModelStatus(event, context);
      },
      onFinish: (_result, context) => {
        this.finishActivityGroup(context);
      },
      onError: (_error, context) => {
        this.finishActivityGroup(context, "error");
      },
    });

    this.currentAgentId = AgentAI.defaultAgent || "coder";
    const resolvedConfig = AgentAI.resolve(this.currentAgentId);

    this.currentProviderId = resolvedConfig.provider.id;
    this.currentModel = resolvedConfig.model;

    this.agent.setModelConfigResolver((agentId, providerId, modelId) => {
      const resolved = AgentAI.resolve(agentId, providerId, modelId);
      return {
        ...resolved,
        provider: {
          ...resolved.provider,
          apiKey: this.apiKeys.get(resolved.provider.id) || null,
        },
      };
    });

    this.agent.setProvider({
      ...resolvedConfig.provider,
      apiKey: this.apiKeys.get(resolvedConfig.provider.id) || null,
    });
    this.agent.setModel(this.currentModel);
    this.agent.setSystemPrompt(resolvedConfig.systemPrompt);
    this.agent.setConfig(resolvedConfig);

    this.sessions = [];
    this.activeSessionId = null;
    this._sessionCounter = 0;

    this.createSession();
  }

  handleToolEnd(toolName, result, context = {}, fullResult = result) {
    const activityItem = this.completeActivityItem(toolName, result, context);

    const payload = fullResult?.result ?? fullResult;

    if (
      (toolName === "create_file" || toolName === "rename_file") &&
      payload?.success === true
    ) {
      this.recordFileOperationChange(toolName, payload, context);
      return;
    }

    if (
      (toolName !== "modify_active_file" && toolName !== "modify_file") ||
      !payload ||
      payload.success !== true
    ) {
      return;
    }

    const session = this.getSession(context?.sessionId);
    if (!session) return;

    const filePath = typeof payload.path === "string" ? payload.path : "";
    const absolutePath =
      typeof payload.absolutePath === "string"
        ? payload.absolutePath
        : this.editor?.tabManager?.activeFile?.path || "";
    if (!filePath && !absolutePath) return;

    const beforeText =
      typeof payload.beforeText === "string" ? payload.beforeText : "";
    const afterText =
      typeof payload.afterText === "string" ? payload.afterText : "";
    const beforeLines = beforeText ? beforeText.split("\n") : [];
    const afterLines = afterText ? afterText.split("\n") : [];

    const diffStats =
      activityItem?.lastDiffStats ||
      this.getLineDiffStats(beforeLines, afterLines);

    const change = {
      path: filePath || absolutePath,
      name: (filePath || absolutePath).split("/").pop() || "fichier",
      status: "modified",
      additions: diffStats.additions,
      deletions: diffStats.deletions,
      beforeText,
      afterText,
      cursorBefore: payload.cursorBefore || null,
      absolutePath,
    };

    const existingIndex = session.changes.findIndex(
      (entry) =>
        entry.status !== "renamed" &&
        (entry.path === filePath ||
          (absolutePath && entry.absolutePath === absolutePath)),
    );
    if (existingIndex >= 0) {
      const existingChange = session.changes[existingIndex];
      const originalBeforeText =
        typeof existingChange.beforeText === "string"
          ? existingChange.beforeText
          : beforeText;
      const cumulativeStats = this.getLineDiffStats(
        originalBeforeText ? originalBeforeText.split("\n") : [],
        afterText ? afterText.split("\n") : [],
      );
      session.changes[existingIndex] = {
        ...existingChange,
        ...change,
        status: existingChange.status === "created" ? "created" : change.status,
        beforeText: originalBeforeText,
        additions: cumulativeStats.additions,
        deletions: cumulativeStats.deletions,
      };
    } else {
      session.changes.push(change);
    }

    session.changesExpanded = true;
    if (session.id === this.activeSessionId && this.changesElement) {
      this.renderChangesPanel(this.changesElement);
    }
  }

  recordFileOperationChange(toolName, payload, context = {}) {
    const session = this.getSession(context.sessionId);
    if (!session) return;

    let change = null;
    if (toolName === "create_file") {
      const path = typeof payload.path === "string" ? payload.path : "";
      if (!path) return;
      change = {
        operation: "create",
        status: payload.overwritten ? "modified" : "created",
        path,
        name: path.replace(/\\/g, "/").split("/").pop() || path,
        absolutePath: payload.absolutePath || "",
        snapshotKey: payload.snapshotKey || null,
        created: payload.created === true,
        overwritten: payload.overwritten === true,
      };
    } else if (toolName === "rename_file") {
      const oldPath =
        typeof payload.oldPath === "string" ? payload.oldPath : "";
      const newPath =
        typeof payload.newPath === "string" ? payload.newPath : "";
      if (!oldPath || !newPath) return;
      const oldName = oldPath.replace(/\\/g, "/").split("/").pop();
      const newName = newPath.replace(/\\/g, "/").split("/").pop();
      change = {
        operation: "rename",
        status: "renamed",
        path: newPath,
        name: `${oldName} → ${newName}`,
        oldPath,
        newPath,
        oldAbsolutePath: payload.oldAbsolutePath || "",
        newAbsolutePath: payload.newAbsolutePath || "",
        absolutePath: payload.newAbsolutePath || "",
      };
      for (const existing of session.changes) {
        if (existing.status === "renamed") continue;
        if (
          existing.path === oldPath ||
          (payload.oldAbsolutePath &&
            existing.absolutePath === payload.oldAbsolutePath)
        ) {
          existing.path = newPath;
          existing.absolutePath = payload.newAbsolutePath || newPath;
          existing.name = newName || existing.name;
        }
      }
    }
    if (!change) return;

    session.changes.push(change);
    session.changesExpanded = true;
    if (session.id === this.activeSessionId && this.changesElement) {
      this.renderChangesPanel(this.changesElement);
    }
  }

  getConfigState() {
    return {
      currentAgentId: this.currentAgentId,
      currentProviderId: this.currentProviderId,
      currentModel: this.currentModel,
    };
  }

  async loadConfigState(state) {
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

    if (this.editor.api.getAgentApiKey) {
      for (const provider of AgentAI.getProviders()) {
        const apiKey = await this.editor.api.getAgentApiKey(provider.id);
        if (apiKey) this.apiKeys.set(provider.id, apiKey);
      }
    }

    const provider = AgentAI.getProvider(this.currentProviderId);
    if (!provider) return;

    this.agent.setProvider({
      ...provider,
      apiKey: this.apiKeys.get(provider.id) || null,
    });
    this.agent.setModel(this.currentModel || provider.defaultModel);
    const resolved = AgentAI.resolve(
      this.currentAgentId,
      this.currentProviderId,
      this.currentModel || provider.defaultModel,
    );
    this.agent.setConfig(resolved);
    this.agent.setSystemPrompt(resolved.systemPrompt);
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

  getActivityGroup(session, runId, create = false) {
    if (!session || !Number.isInteger(runId)) return null;
    if (!Array.isArray(session.segments)) session.segments = [];
    if (
      session.currentSegment?.runId === runId &&
      session.currentSegment?.type === "activity"
    ) {
      return session.currentSegment;
    }
    if (create) return this.getRunSegment(session, runId, "activity", true);
    let group = [...session.messages]
      .reverse()
      .find(
        (message) => message?.role === "activity" && message.runId === runId,
      );
    if (group || !create) return group || null;
    return null;
  }

  getRunSegment(session, runId, type, create = false) {
    if (!session || !Number.isInteger(runId)) return null;
    if (!Array.isArray(session.segments)) session.segments = [];
    const current = session.currentSegment;
    if (current?.runId === runId && current.type === type) return current;
    if (!create) return null;
    if (current) current.status = "complete";
    const segment = {
      id: `${session.id}:${runId}:segment-${session.segments.length}`,
      type,
      runId,
      sessionId: session.id,
      content: type === "reasoning" || type === "assistant" ? "" : undefined,
      status: "streaming",
      startedAt: Date.now(),
      finishedAt: null,
      hasErrors: false,
      items: type === "activity" ? [] : undefined,
      collapsed: type === "reasoning",
    };
    session.segments.push(segment);
    session.messages.push(segment);
    session.currentSegment = segment;
    return segment;
  }

  ensureSessionSegments(session) {
    if (!session) return [];
    if (Array.isArray(session.segments) && session.segments.length) {
      return session.segments;
    }
    session.segments = [];
    for (const message of session.messages || []) {
      if (message?.role === "activity" || message?.type === "activity") {
        session.segments.push(message);
        continue;
      }
      const reasoning = this.normalizeReasoningValue(
        message?.reasoning ??
          message?.reasoning_content ??
          message?.reasoningText,
      );
      if (reasoning) {
        session.segments.push({
          id: `${session.id}:legacy-reasoning-${session.segments.length}`,
          type: "reasoning",
          runId: message.runId ?? session.runId ?? 0,
          sessionId: session.id,
          content: reasoning,
          status: "complete",
          collapsed: true,
        });
      }
      if (message?.role === "agent" && typeof message.content === "string") {
        session.segments.push({
          id: `${session.id}:legacy-assistant-${session.segments.length}`,
          type: "assistant",
          runId: message.runId ?? session.runId ?? 0,
          sessionId: session.id,
          role: "agent",
          content: message.content,
          status: "complete",
          streaming: false,
        });
      }
    }
    return session.segments;
  }

  getActivityPendingKey(context = {}, toolName = "") {
    return `${context.sessionId || ""}:${context.runId || ""}:${toolName}`;
  }

  getActivityItemId(context = {}) {
    if (context.toolCallId) {
      return `${context.sessionId}:${context.runId}:${context.toolCallId}`;
    }
    this._activityItemCounter += 1;
    return `${context.sessionId}:${context.runId}:activity-${this._activityItemCounter}`;
  }

  handleToolStart(toolName, args = {}, context = {}) {
    const session = this.getSession(context.sessionId);
    const group = this.getActivityGroup(session, context.runId, true);
    if (!session || !group) return;
    group.role = "activity";
    group.status = "running";
    session.streamingMessage = null;

    const itemId = this.getActivityItemId(context);
    const activePath = this.editor?.tabManager?.activeFile?.path;
    const type = this.getActivityType(toolName);
    const previousItem = group.items[group.items.length - 1] || null;
    let item =
      type === "edit" && previousItem?.aggregate === "modifications"
        ? previousItem
        : null;
    const isNewItem = !item;

    if (!item) {
      item = {
        id: itemId,
        toolCallId: context.toolCallId || null,
        toolName,
        type,
        title: "",
        detail: "",
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        args: { ...args },
      };
      if (activePath) item.activePath = activePath;
      if (type === "edit") {
        item.aggregate = "modifications";
        item.modificationCount = 0;
        item.completedModifications = 0;
        item.failedModifications = 0;
        item.files = [];
        item.diffStats = { additions: 0, deletions: 0 };
        item.errors = [];
      }
      group.items.push(item);
    }

    if (item.aggregate === "modifications") {
      item.modificationCount += 1;
      item.status = "running";
      item.finishedAt = null;
      const fileName = this.getActivityFileName({ args, activePath }, {});
      if (!item.files.includes(fileName)) item.files.push(fileName);
      Object.assign(item, this.describeModificationAggregate(item));
    } else {
      Object.assign(item, this.describeActivityItem(item));
    }
    this.activityItems.set(itemId, {
      group,
      item,
      toolName,
      args: { ...args },
      activePath,
    });

    if (!context.toolCallId) {
      const pendingKey = this.getActivityPendingKey(context, toolName);
      const pending = this.pendingActivityItems.get(pendingKey) || [];
      pending.push(itemId);
      this.pendingActivityItems.set(pendingKey, pending);
    }

    if (session.id !== this.activeSessionId || !this.messagesElement) return;
    const shouldScroll = this.shouldAutoScrollMessages();
    this.removeEmptyState();
    if (this.typingIndicatorElement?.isConnected) {
      this.typingIndicatorElement.remove();
      this.typingIndicatorElement = null;
    }

    let groupRefs = this.activityElements.get(group);
    if (!groupRefs?.row?.isConnected) {
      const groupElement = this.createActivityElement(group);
      this.messagesElement.appendChild(groupElement);
      groupRefs = this.activityElements.get(group);
    } else if (isNewItem) {
      groupRefs.list.appendChild(this.createActivityItemElement(item));
      this.updateActivityHeader(group);
    } else {
      this.updateActivityItemElement(item);
    }

    if (shouldScroll) this.scrollMessagesToBottom();
  }

  handleModelStatus(event = {}, context = {}) {
    const session = this.getSession(context.sessionId);
    const group = this.getActivityGroup(session, context.runId, true);
    if (!session || !group || !event.userMessage) return;
    group.role = "activity";
    group.status = "running";
    session.streamingMessage = null;
    const classification = event.classification || {};
    const item = {
      id: this.getActivityItemId(context),
      toolName: "model_status",
      type: "model",
      modelEventKind: event.kind || "error",
      title: event.userMessage,
      detail:
        event.kind === "retry"
          ? `${classification.category || "Erreur temporaire"} · tentative ${event.attempt || 1}`
          : event.kind === "fallback"
            ? `${event.fromProvider || "provider"} → ${event.toProvider || "provider"}`
            : classification.category || "Erreur modèle",
      status: event.kind === "error" ? "error" : "success",
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    group.items.push(item);
    if (event.kind === "error") group.hasErrors = true;

    if (session.id !== this.activeSessionId || !this.messagesElement) return;
    const shouldScroll = this.shouldAutoScrollMessages();
    this.removeEmptyState();
    let groupRefs = this.activityElements.get(group);
    if (!groupRefs?.row?.isConnected) {
      this.messagesElement.appendChild(this.createActivityElement(group));
      groupRefs = this.activityElements.get(group);
    } else {
      groupRefs.list.appendChild(this.createActivityItemElement(item));
      this.updateActivityHeader(group);
    }
    if (shouldScroll) this.scrollMessagesToBottom();
  }

  handleAgentReasoning(reasoning, context = {}) {
    if (typeof reasoning !== "string" || !reasoning) return;
    const session = this.getSession(context.sessionId);
    if (!session || !session.isGenerating || session.runId !== context.runId) {
      return;
    }
    session.streamingMessage = null;
    const segment = this.getRunSegment(
      session,
      context.runId,
      "reasoning",
      true,
    );
    segment.content += reasoning;
    segment.status = "streaming";
    if (session.id !== this.activeSessionId || !this.messagesElement) return;

    const refs = this.messageElements.get(segment);
    const shouldScroll = this.shouldAutoScrollMessages();
    if (!refs?.row?.isConnected) {
      this.removeEmptyState();
      this.messagesElement.appendChild(this.createReasoningElement(segment));
    } else {
      refs.reasoning.textContent = segment.content;
    }
    if (shouldScroll) this.scrollMessagesToBottom();
  }

  completeActivityItem(toolName, result, context = {}) {
    const session = this.getSession(context.sessionId);
    const group = this.getActivityGroup(session, context.runId);
    if (!group) return null;

    let itemId = context.toolCallId
      ? `${context.sessionId}:${context.runId}:${context.toolCallId}`
      : null;
    if (!itemId) {
      const pendingKey = this.getActivityPendingKey(context, toolName);
      const pending = this.pendingActivityItems.get(pendingKey) || [];
      itemId = pending.shift() || null;
      if (pending.length) this.pendingActivityItems.set(pendingKey, pending);
      else this.pendingActivityItems.delete(pendingKey);
    }

    const itemRecord = this.activityItems.get(itemId);
    const item = itemRecord?.group === group ? itemRecord.item : null;
    if (!item) return null;

    const payload = result?.result ?? result;
    const failed = result?.success === false || payload?.success === false;
    if (item.aggregate === "modifications") {
      item.completedModifications += 1;
      if (failed) {
        item.failedModifications += 1;
        item.errors.push(this.getActivityError(result));
      }
      const beforeText = payload?.beforeText;
      const afterText = payload?.afterText;
      if (typeof beforeText === "string" && typeof afterText === "string") {
        item.lastDiffStats = this.getLineDiffStats(
          beforeText ? beforeText.split("\n") : [],
          afterText ? afterText.split("\n") : [],
        );
        item.diffStats.additions += item.lastDiffStats.additions;
        item.diffStats.deletions += item.lastDiffStats.deletions;
      } else {
        item.lastDiffStats = null;
      }
      const allCompleted =
        item.completedModifications >= item.modificationCount;
      item.status = !allCompleted
        ? "running"
        : item.failedModifications
          ? "error"
          : "success";
      item.finishedAt = allCompleted ? Date.now() : null;
      Object.assign(item, this.describeModificationAggregate(item));
    } else {
      item.status = failed ? "error" : "success";
      item.finishedAt = Date.now();
      Object.assign(item, this.describeActivityItem(item, result));
    }
    if (failed) group.hasErrors = true;

    this.activityItems.delete(itemId);
    this.updateActivityItemElement(item);
    this.updateActivityHeader(group);
    return item;
  }

  finishActivityGroup(context = {}, status = "success") {
    const session = this.getSession(context.sessionId);
    const group = this.getActivityGroup(session, context.runId);
    if (!group || group.status !== "running") return;

    for (const item of group.items) {
      if (item.status !== "running") continue;
      item.status = status === "error" ? "error" : "success";
      item.finishedAt = Date.now();
      Object.assign(
        item,
        item.aggregate === "modifications"
          ? this.describeModificationAggregate(item)
          : this.describeActivityItem(item),
      );
      this.updateActivityItemElement(item);
    }
    group.finishedAt = Date.now();
    group.status = status === "error" || group.hasErrors ? "error" : "success";
    const pendingPrefix = `${context.sessionId}:${context.runId}:`;
    for (const key of this.pendingActivityItems.keys()) {
      if (key.startsWith(pendingPrefix)) this.pendingActivityItems.delete(key);
    }
    this.updateActivityHeader(group);
  }

  setActivityGroupCollapsed(group, collapsed) {
    if (!group) return;
    group.collapsed = !!collapsed;
    const refs = this.activityElements.get(group);
    if (!refs?.row?.isConnected) return;
    refs.activity.classList.toggle("agent-activity-collapsed", group.collapsed);
    refs.header.setAttribute("aria-expanded", String(!group.collapsed));
    refs.list.hidden = group.collapsed;
  }

  collapseActivityGroup(context = {}) {
    const session = this.getSession(context.sessionId);
    const group = this.getActivityGroup(session, context.runId);
    this.setActivityGroupCollapsed(group, true);
  }

  setReasoningSegmentCollapsed(segment, collapsed) {
    if (!segment) return;
    segment.collapsed = !!collapsed;
    const refs = this.messageElements.get(segment);
    if (!refs?.row?.isConnected) return;
    refs.reasoningToggle?.setAttribute(
      "aria-expanded",
      String(!segment.collapsed),
    );
    if (refs.reasoning) refs.reasoning.hidden = segment.collapsed;
  }

  collapseRunDetails(session, runId) {
    if (!session || !Number.isInteger(runId)) return;
    const segments = new Set([
      ...(Array.isArray(session.segments) ? session.segments : []),
      ...(Array.isArray(session.messages) ? session.messages : []),
    ]);
    for (const segment of segments) {
      if (segment?.runId !== runId) continue;
      if (segment.type === "reasoning") {
        this.setReasoningSegmentCollapsed(segment, true);
      } else if (segment.type === "activity" || segment.role === "activity") {
        this.setActivityGroupCollapsed(segment, true);
      }
    }
  }

  getActivityType(toolName = "") {
    if (toolName === "create_file") return "create";
    if (toolName === "rename_file") return "rename";
    if (toolName.includes("search")) return "search";
    if (toolName.includes("read")) return "read";
    if (toolName.includes("modify") || toolName.includes("replace")) {
      return "edit";
    }
    if (toolName.includes("context") || toolName === "get_cursor") {
      return "context";
    }
    if (toolName.includes("list")) return "list";
    if (/verify|check|test|build/.test(toolName)) return "verify";
    return "other";
  }

  describeModificationAggregate(item) {
    const running = item.status === "running";
    const files = Array.isArray(item.files) ? item.files : [];
    const target =
      files.length === 1
        ? files[0]
        : `${files.length} ${files.length === 1 ? "file" : "files"}`;
    const title = `${running ? "Modifying" : "Modified"} ${target || "files"}${running ? "…" : ""}`;
    const details = [];
    if (item.modificationCount > 1) {
      details.push(`${item.modificationCount} modifications`);
    }
    const additions = item.diffStats?.additions || 0;
    const deletions = item.diffStats?.deletions || 0;
    if (additions || deletions) details.push(`+${additions} −${deletions}`);
    if (item.failedModifications) {
      details.push(`${item.failedModifications} failed`);
      const lastError = item.errors?.[item.errors.length - 1];
      if (lastError) details.push(lastError);
    }
    return { title, detail: details.join(" · ") };
  }

  getActivityFileName(item, payload = {}) {
    const path =
      (typeof payload?.path === "string" && payload.path) ||
      (typeof item.args?.path === "string" && item.args.path) ||
      item.activePath ||
      "";
    return path.replace(/\\/g, "/").split("/").pop() || "file";
  }

  getActivityResultCount(payload = {}) {
    for (const value of [
      payload.totalMatches,
      payload.total,
      payload.count,
      payload.resultCount,
    ]) {
      if (Number.isFinite(value)) return Math.max(0, value);
    }
    for (const value of [payload.results, payload.matches, payload.files]) {
      if (Array.isArray(value)) return value.length;
    }
    return null;
  }

  formatActivityCount(count, singular, plural = `${singular}s`) {
    if (count === 0) return `No ${plural}`;
    return `${count} ${count === 1 ? singular : plural}`;
  }

  getActivityError(result) {
    const error = result?.error ?? result?.result?.error;
    if (typeof error === "string") return error;
    if (typeof error?.message === "string") return error.message;
    return "The tool could not complete this action";
  }

  describeActivityItem(item, result = null) {
    const running = item.status === "running";
    const failed = item.status === "error";
    const payload = result?.result ?? result ?? {};
    const query =
      typeof item.args?.query === "string" ? item.args.query.trim() : "";
    const fileName = this.getActivityFileName(item, payload);
    const rangeStart = Number.isInteger(payload?.startLine)
      ? payload.startLine
      : Number.isInteger(item.args?.startLine)
        ? item.args.startLine
        : null;
    const rangeEnd = Number.isInteger(payload?.endLine)
      ? payload.endLine
      : Number.isInteger(item.args?.endLine)
        ? item.args.endLine
        : null;
    let title = "";
    let detail = "";

    switch (item.toolName) {
      case "search_project_files":
        title = `${running ? "Searching" : "Searched"} workspace${query ? ` for "${query}"` : ""}${running ? "…" : ""}`;
        break;
      case "search_active_file":
        title = `${running ? "Searching" : "Searched"} active file${query ? ` for "${query}"` : ""}${running ? "…" : ""}`;
        break;
      case "read_file":
      case "read_active_file":
        title = `${running ? "Reading" : "Read"} ${fileName}${running ? "…" : ""}`;
        if (rangeStart && rangeEnd) detail = `lines ${rangeStart}–${rangeEnd}`;
        else if (rangeStart) detail = `line ${rangeStart}`;
        break;
      case "read_selection":
        title = `${running ? "Reading" : "Read"} selection${running ? "…" : ""}`;
        break;
      case "list_project_files":
        title = `${running ? "Listing" : "Listed"} project files${running ? "…" : ""}`;
        break;
      case "create_file":
        title = `${running ? "Creating" : "Created"} ${fileName}${running ? "…" : ""}`;
        break;
      case "rename_file": {
        const oldPath =
          typeof payload?.oldPath === "string"
            ? payload.oldPath
            : item.args?.path || "";
        const newPath =
          typeof payload?.newPath === "string"
            ? payload.newPath
            : item.args?.newPath || "";
        const oldName = oldPath.replace(/\\/g, "/").split("/").pop();
        const newName = newPath.replace(/\\/g, "/").split("/").pop();
        title = `${running ? "Renaming" : "Renamed"} ${oldName || "file"} → ${newName || "file"}${running ? "…" : ""}`;
        break;
      }
      case "modify_file":
        title = `${running ? "Modifying" : "Modified"} ${fileName}${running ? "…" : ""}`;
        break;
      case "modify_active_file":
        title = `${running ? "Modifying" : "Modified"} active file${running ? "…" : ""}`;
        break;
      case "replace_text":
        title = `${running ? "Replacing" : "Replaced"} text in ${fileName}${running ? "…" : ""}`;
        break;
      case "get_editor_context":
        title = `${running ? "Inspecting" : "Inspected"} editor context${running ? "…" : ""}`;
        break;
      case "get_cursor":
        title = `${running ? "Inspecting" : "Inspected"} cursor position${running ? "…" : ""}`;
        break;
      default: {
        const readableName = item.toolName.replace(/_/g, " ");
        title = `${running ? "Running" : "Ran"} ${readableName}${running ? "…" : ""}`;
      }
    }

    if (!running && !failed && item.type === "search") {
      const count = this.getActivityResultCount(payload);
      if (count !== null) detail = this.formatActivityCount(count, "result");
    } else if (!running && !failed && item.type === "list") {
      const count = this.getActivityResultCount(payload);
      if (count !== null) detail = this.formatActivityCount(count, "file");
    } else if (!running && !failed && item.type === "edit") {
      const beforeText = payload?.beforeText;
      const afterText = payload?.afterText;
      if (typeof beforeText === "string" && typeof afterText === "string") {
        const stats = this.getLineDiffStats(
          beforeText ? beforeText.split("\n") : [],
          afterText ? afterText.split("\n") : [],
        );
        item.diffStats = stats;
        detail = `+${stats.additions} −${stats.deletions}`;
      }
    }

    if (failed) {
      const failedAction = {
        search_project_files: `search workspace${query ? ` for "${query}"` : ""}`,
        search_active_file: `search active file${query ? ` for "${query}"` : ""}`,
        read_file: `read ${fileName}`,
        read_active_file: `read ${fileName}`,
        read_selection: "read selection",
        list_project_files: "list project files",
        create_file: `create ${fileName}`,
        rename_file: `rename ${this.getActivityFileName(item)}`,
        modify_file: `modify ${fileName}`,
        modify_active_file: "modify active file",
        replace_text: `replace text in ${fileName}`,
        get_editor_context: "inspect editor context",
        get_cursor: "inspect cursor position",
      }[item.toolName];
      title = `Failed to ${failedAction || item.toolName.replace(/_/g, " ")}`;
      detail = this.getActivityError(result);
    }
    return { title, detail };
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
      this.updateView({
        renderTabs: false,
        renderMessages: false,
        renderChanges: false,
      });
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
    const currentAgent = AgentAI.getAgent(this.currentAgentId);
    modeTrigger.title = `Mode: ${currentAgent?.name || "Mode"}`;
    modeTrigger.setAttribute("aria-label", modeTrigger.title);
    modeTrigger.innerHTML = '<i class="fi fi-rr-settings-sliders"></i>';

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
          const resolved = AgentAI.resolve(
            mode.id,
            this.currentProviderId,
            this.currentModel,
          );
          this.currentAgentId = mode.id;
          this.agent.setModel(this.currentModel);
          this.agent.setSystemPrompt(resolved.systemPrompt);
          this.agent.setConfig(resolved);
          modeTrigger.title = `Mode: ${mode.name}`;
          modeTrigger.setAttribute("aria-label", modeTrigger.title);
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

    triggerBtn.title = `Model: ${currentDisplayName}`;
    triggerBtn.setAttribute("aria-label", triggerBtn.title);
    triggerBtn.innerHTML = '<i class="fi fi-rr-robot"></i>';

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
            ...AgentAI.getProvider(m.providerId),
            apiKey: this.apiKeys.get(m.providerId) || null,
          });
          this.agent.setModel(m.id);
          const resolved = AgentAI.resolve(
            this.currentAgentId,
            m.providerId,
            m.id,
          );
          this.agent.setConfig(resolved);
          this.agent.setSystemPrompt(resolved.systemPrompt);

          this.editor.statesManager?.save();

          triggerBtn.title = `Model: ${m.name}`;
          triggerBtn.setAttribute("aria-label", triggerBtn.title);
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
    container
      .querySelectorAll(".agent-sidebar-markdown")
      .forEach((element) => this.markdownRenderer.destroy(element));
    container.replaceChildren();
    this.typingIndicatorElement = null;

    const session = this.getActiveSession();

    if (!session || (session.messages.length === 0 && !session.isGenerating)) {
      container.appendChild(this.createEmptyState());
      return;
    }
    this.ensureSessionSegments(session);

    for (const message of session.messages) {
      container.appendChild(
        message?.type === "reasoning"
          ? this.createReasoningElement(message)
          : message?.role === "activity" || message?.type === "activity"
            ? this.createActivityElement(message)
            : this.createMessageElement(message),
      );
    }

    const hasRunningActivity = session.messages.some(
      (message) => message?.role === "activity" && message.status === "running",
    );
    if (
      session.isGenerating &&
      !session.streamingMessage &&
      !hasRunningActivity
    ) {
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

  removeEmptyState() {
    this.messagesElement
      ?.querySelector(":scope > .agent-sidebar-empty-state")
      ?.remove();
  }

  getActivityIcon(item) {
    if (item.status === "error") return "⚠";
    if (item.status === "running") return "◌";
    if (item.type === "model") {
      return item.modelEventKind === "retry" ? "↻" : "↪";
    }
    return {
      search: "⌕",
      read: "▣",
      edit: "✎",
      context: "◇",
      list: "≡",
      create: "＋",
      rename: "↪",
      verify: "✓",
      model: "↪",
      other: "•",
    }[item.type];
  }

  getActivityHeaderLabel(group) {
    const count = Array.isArray(group.items) ? group.items.length : 0;
    const steps = `${count} ${count === 1 ? "step" : "steps"}`;
    if (group.status === "running") {
      return count ? `Working · ${steps}` : "Working";
    }
    if (group.status === "error" || group.hasErrors) {
      return `Completed with errors · ${steps}`;
    }
    return `Worked on ${steps}`;
  }

  createActivityElement(group) {
    const row = document.createElement("div");
    row.className = "agent-sidebar-message agent-sidebar-activity-message";

    const activity = document.createElement("div");
    activity.className = "agent-activity";
    activity.dataset.status = group.status;
    activity.classList.toggle("agent-activity-collapsed", !!group.collapsed);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "agent-activity-header";
    header.setAttribute("aria-expanded", String(!group.collapsed));

    const chevron = document.createElement("span");
    chevron.className = "agent-activity-chevron";
    chevron.textContent = "›";
    header.appendChild(chevron);

    const title = document.createElement("span");
    title.className = "agent-activity-title";
    title.textContent = this.getActivityHeaderLabel(group);
    header.appendChild(title);

    const list = document.createElement("div");
    list.className = "agent-activity-list";
    list.hidden = !!group.collapsed;
    const fragment = document.createDocumentFragment();
    for (const item of group.items || []) {
      fragment.appendChild(this.createActivityItemElement(item));
    }
    list.appendChild(fragment);

    header.addEventListener("click", () => {
      this.setActivityGroupCollapsed(group, !group.collapsed);
    });

    activity.append(header, list);
    row.appendChild(activity);
    this.activityElements.set(group, { row, activity, header, title, list });
    return row;
  }

  createActivityItemElement(item) {
    const element = document.createElement("div");
    element.className = "agent-activity-item";
    element.dataset.status = item.status;
    element.dataset.type = item.type;

    const icon = document.createElement("span");
    icon.className = "agent-activity-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = this.getActivityIcon(item);

    const content = document.createElement("div");
    content.className = "agent-activity-content";

    const title = document.createElement("div");
    title.className = "agent-activity-item-title";
    title.textContent = item.title;
    content.appendChild(title);

    const detail = document.createElement("div");
    detail.className = "agent-activity-item-detail";
    detail.textContent = item.detail || "";
    detail.hidden = !item.detail;
    content.appendChild(detail);

    element.append(icon, content);
    this.activityItemElements.set(item.id, { element, icon, title, detail });
    return element;
  }

  updateActivityItemElement(item) {
    const refs = this.activityItemElements.get(item.id);
    if (!refs?.element?.isConnected) return;
    refs.element.dataset.status = item.status;
    refs.element.dataset.type = item.type;
    refs.icon.textContent = this.getActivityIcon(item);
    refs.title.textContent = item.title;
    refs.detail.textContent = item.detail || "";
    refs.detail.hidden = !item.detail;
  }

  updateActivityHeader(group) {
    const refs = this.activityElements.get(group);
    if (!refs?.row?.isConnected) return;
    refs.title.textContent = this.getActivityHeaderLabel(group);
    refs.activity.dataset.status = group.status;
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
    let messageMeta = null;
    if (contentValue) {
      const contentEl = document.createElement("div");
      contentEl.className = "agent-sidebar-content";
      if (role === "agent") {
        contentEl.classList.add("agent-sidebar-markdown");
        this.markdownRenderer.render(contentValue, contentEl, {
          highlightImmediately: message?.streaming !== true,
        });
      } else {
        contentEl.textContent = contentValue;
      }
      bubble.appendChild(contentEl);
      this.messageElements.set(message, { row, content: contentEl });

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "agent-sidebar-copy-button";
      copyButton.title = "Copy message";
      copyButton.setAttribute("aria-label", "Copy message");
      const copyIcon = document.createElement("i");
      copyIcon.className = "fi fi-rr-copy";
      copyButton.appendChild(copyIcon);
      copyButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        const markdown =
          typeof message?.content === "string" ? message.content : "";
        try {
          await navigator.clipboard.writeText(markdown);
          copyButton.title = "Copied";
        } catch {
          this.copyTextFallback(markdown);
        }
        copyButton.title = "Copied";
        copyButton.classList.add("agent-sidebar-copy-button-copied");
        copyIcon.className = "fi fi-rr-check";
        clearTimeout(copyButton._resetCopyIcon);
        copyButton._resetCopyIcon = setTimeout(() => {
          copyIcon.className = "fi fi-rr-copy";
          copyButton.title = "Copy message";
          copyButton.classList.remove("agent-sidebar-copy-button-copied");
        }, 2000);
      });
      messageMeta = document.createElement("div");
      messageMeta.className = "agent-sidebar-message-meta";
      messageMeta.appendChild(copyButton);
    }

    bubble.style.userSelect = "text";
    bubble.style.WebkitUserSelect = "text";
    bubble.style.cursor = "text";

    row.appendChild(bubble);
    if (messageMeta) {
      row.appendChild(messageMeta);
    }

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
      if (messageMeta) {
        messageMeta.appendChild(time);
      } else {
        row.appendChild(time);
      }
    }

    return row;
  }

  createReasoningElement(segment) {
    const row = document.createElement("div");
    row.className = "agent-sidebar-message agent-sidebar-message-reasoning";
    row.dataset.segmentId = segment.id;
    const bubble = document.createElement("div");
    bubble.className = "agent-sidebar-bubble";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agent-sidebar-reasoning-toggle";
    toggle.setAttribute("aria-expanded", String(!segment.collapsed));
    const icon = document.createElement("i");
    icon.className = "fi fi-rr-angle-small-right";
    const label = document.createElement("span");
    label.textContent = "Reasoning";
    toggle.append(icon, label);
    const content = document.createElement("div");
    content.className = "agent-sidebar-reasoning";
    content.textContent = segment.content;
    content.hidden = !!segment.collapsed;
    toggle.addEventListener("click", () => {
      segment.collapsed = !segment.collapsed;
      toggle.setAttribute("aria-expanded", String(!segment.collapsed));
      content.hidden = segment.collapsed;
    });
    bubble.append(toggle, content);
    row.appendChild(bubble);
    this.messageElements.set(segment, {
      row,
      reasoning: content,
      reasoningToggle: toggle,
    });
    return row;
  }

  copyTextFallback(value) {
    const textarea = document.createElement("textarea");
    textarea.value = typeof value === "string" ? value : "";
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  shouldAutoScrollMessages() {
    if (!this.messagesElement) return false;
    const distanceFromBottom =
      this.messagesElement.scrollHeight -
      this.messagesElement.scrollTop -
      this.messagesElement.clientHeight;
    return distanceFromBottom < 48;
  }

  handleAgentToken(markdown, context = {}) {
    if (typeof markdown !== "string") return;

    const session = this.getSession(context.sessionId);
    if (!session || !session.isGenerating || session.runId !== context.runId) {
      return;
    }

    const message = this.getRunSegment(
      session,
      context.runId,
      "assistant",
      true,
    );
    const shouldScroll =
      session.id === this.activeSessionId && this.shouldAutoScrollMessages();
    message.role = "agent";
    message.content = markdown;
    message.timestamp ||= this.formatTime();
    message.streaming = true;
    session.streamingMessage = message;
    const refs = this.messageElements.get(message);
    if (!refs?.row?.isConnected) {
      this.removeEmptyState();
      if (session.id === this.activeSessionId && this.messagesElement) {
        this.messagesElement.appendChild(this.createMessageElement(message));
        if (shouldScroll) this.scrollMessagesToBottom();
      }
      return;
    }

    const element = refs.content;
    if (
      session.id !== this.activeSessionId ||
      !element ||
      !element.isConnected
    ) {
      return;
    }

    const shouldFollowScroll = this.shouldAutoScrollMessages();
    this.markdownRenderer.update(markdown, element, {
      onRendered: () => {
        if (shouldFollowScroll && session.id === this.activeSessionId) {
          this.scrollMessagesToBottom();
        }
      },
    });
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
    this.typingIndicatorElement = row;
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
    const header = document.createElement("div");
    header.className = "agent-sidebar-changes-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "agent-sidebar-changes-toggle";
    toggle.setAttribute("aria-expanded", String(session.changesExpanded));

    const chevron = document.createElement("i");
    chevron.className =
      "fi fi-rr-angle-small-right agent-sidebar-changes-chevron";
    toggle.appendChild(chevron);

    const label = document.createElement("span");
    label.className = "agent-sidebar-changes-label";
    const count = session.changes.length;
    label.textContent = `${count} ${count > 1 ? "fichiers" : "fichier"}`;
    toggle.appendChild(label);

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

    toggle.appendChild(statsWrap);

    toggle.addEventListener("click", () => {
      this.toggleChangesPanel(session.id);
    });

    const actions = document.createElement("div");
    actions.className = "agent-sidebar-changes-header-actions";
    actions.appendChild(
      this.createChangeActionButton(
        "Keep all",
        "fi fi-rr-check-double",
        "Keep all changes",
        () => this.keepAllChanges(session),
      ),
    );
    actions.appendChild(
      this.createChangeActionButton(
        "Undo all",
        "fi fi-rr-undo",
        "Undo all changes",
        () => this.undoAllChanges(session),
      ),
    );

    header.append(toggle, actions);

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
      case "created":
        return "C";
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

    const add = document.createElement("span");
    add.className = "change-stat-add";
    add.textContent = `+${change.additions | 0}`;
    statsSpan.appendChild(add);

    const del = document.createElement("span");
    del.className = "change-stat-del";
    del.textContent = `-${change.deletions | 0}`;
    statsSpan.appendChild(del);

    li.appendChild(statsSpan);

    const actions = document.createElement("div");
    actions.className = "agent-sidebar-change-actions";

    actions.appendChild(
      this.createChangeActionButton(
        "Keep",
        "fi fi-rr-check",
        "Keep changes",
        () => this.keepFileChanges(change),
      ),
    );
    actions.appendChild(
      this.createChangeActionButton(
        "Undo",
        "fi fi-rr-undo",
        "Undo changes",
        () => this.undoFileChanges(change),
      ),
    );
    li.appendChild(actions);

    li.addEventListener("click", () => {
      this.openChange(change);
    });

    return li;
  }

  createChangeActionButton(label, iconClass, title, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-sidebar-change-action";
    button.title = title;
    button.setAttribute("aria-label", title);

    const icon = document.createElement("i");
    icon.className = iconClass;
    button.appendChild(icon);

    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handler();
    });
    return button;
  }

  getChangeFile(change) {
    const tabManager = this.editor?.tabManager;
    if (!tabManager) return null;
    if (change.absolutePath && typeof tabManager.getFileByPath === "function") {
      const exact = tabManager.getFileByPath(change.absolutePath);
      if (exact) return exact;
    }
    const activeFile = tabManager.activeFile;
    if (
      activeFile &&
      (activeFile.path === change.path ||
        activeFile.path?.replace(/\\/g, "/").endsWith(`/${change.path}`))
    ) {
      return activeFile;
    }
    return null;
  }

  removeChange(change) {
    const session = this.getActiveSession();
    if (!session) return;
    this.removeChanges(session, [change]);
  }

  removeChanges(session, changes, refresh = true) {
    if (!session || !Array.isArray(changes) || changes.length === 0) return;
    const removed = new Set(changes);
    session.changes = session.changes.filter((entry) => !removed.has(entry));
    if (refresh) this.refresh();
  }

  getChangePaths(change) {
    return [
      change?.path,
      change?.absolutePath,
      change?.oldPath,
      change?.newPath,
      change?.oldAbsolutePath,
      change?.newAbsolutePath,
    ]
      .filter((value) => typeof value === "string" && value)
      .map((value) => value.replace(/\\/g, "/").replace(/\/+$/g, ""));
  }

  getFileChanges(session, selectedChange) {
    if (!session?.changes?.includes(selectedChange)) return [];
    const related = new Set([selectedChange]);
    const paths = new Set(this.getChangePaths(selectedChange));
    let foundRelatedChange = true;
    while (foundRelatedChange) {
      foundRelatedChange = false;
      for (const change of session.changes) {
        if (related.has(change)) continue;
        const changePaths = this.getChangePaths(change);
        if (!changePaths.some((filePath) => paths.has(filePath))) continue;
        related.add(change);
        for (const filePath of changePaths) paths.add(filePath);
        foundRelatedChange = true;
      }
    }
    return session.changes.filter((change) => related.has(change));
  }

  clearChangeDiff(change) {
    const file = this.getChangeFile(change);
    if (!file) return;
    file.diffSnapshot = null;
    file.diffActive = false;
    file.diffRows = null;
    for (const line of file.lines || []) {
      if (line && typeof line === "object") {
        line.diffState = null;
        line.diffSegments = [];
      }
    }
    if (this.editor.tabManager?.activeFile === file) {
      this.editor.lineController?.refresh?.(true);
    }
  }

  async keepFileChanges(change, options = {}) {
    const session = options.session || this.getActiveSession();
    const fileChanges = this.getFileChanges(session, change);
    if (!fileChanges.length) return false;
    for (const fileChange of fileChanges) {
      if (fileChange.snapshotKey) {
        this.agent?.fileSnapshots?.delete(fileChange.snapshotKey);
      }
    }
    this.clearChangeDiff(fileChanges[fileChanges.length - 1]);
    this.removeChanges(session, fileChanges, options.refresh !== false);
    return true;
  }

  async keepAllChanges(session = this.getActiveSession()) {
    if (!session?.changes?.length) return;
    const pendingChanges = [...session.changes];
    for (const change of pendingChanges) {
      if (!session.changes.includes(change)) continue;
      await this.keepFileChanges(change, { session, refresh: false });
    }
    this.refresh();
  }

  async keepChange(change) {
    return this.keepFileChanges(change);
  }

  async undoSingleChange(change) {
    if (change.operation === "create") {
      const absolutePath = change.absolutePath || change.path;
      if (change.overwritten && change.snapshotKey) {
        const previous = this.agent?.fileSnapshots?.get(change.snapshotKey);
        if (typeof previous !== "string") return false;
        const saved = await this.editor?.api?.saveFile?.(
          absolutePath,
          previous,
        );
        if (!saved) return false;
        this.agent.fileSnapshots.delete(change.snapshotKey);
        await this.editor?.tabManager?.reloadFileFromDisk?.(absolutePath);
      } else {
        const result = await this.editor?.api?.deleteEntry?.(absolutePath);
        if (!result?.success) return false;
        this.editor?.tabManager?.markFileAsDeleted?.(absolutePath);
      }
      await this.refreshChangeFolders([absolutePath]);
      return true;
    }

    if (change.operation === "rename") {
      const oldAbsolutePath = change.oldAbsolutePath || change.oldPath;
      const newAbsolutePath = change.newAbsolutePath || change.newPath;
      const result = await this.editor?.api?.renameEntry?.(
        newAbsolutePath,
        oldAbsolutePath,
      );
      if (!result?.success) return false;
      await this.editor?.tabManager?.updateFilePath?.(
        newAbsolutePath,
        oldAbsolutePath,
      );
      const normalizePath = (value) =>
        String(value || "")
          .replace(/\\/g, "/")
          .replace(/\/+$/g, "");
      if (
        normalizePath(this.editor?.fileExplorer?.activeFilePath) ===
        normalizePath(newAbsolutePath)
      ) {
        this.editor.fileExplorer.activeFilePath = oldAbsolutePath;
      }
      const session = this.getActiveSession();
      for (const existing of session?.changes || []) {
        if (existing === change || existing.status === "renamed") continue;
        if (
          existing.path === change.newPath ||
          existing.absolutePath === newAbsolutePath
        ) {
          existing.path = change.oldPath;
          existing.absolutePath = oldAbsolutePath;
          existing.name = change.oldPath.replace(/\\/g, "/").split("/").pop();
        }
      }
      await this.refreshChangeFolders([oldAbsolutePath, newAbsolutePath]);
      return true;
    }

    const file = this.getChangeFile(change);
    if (!file || typeof change.beforeText !== "string") return false;

    if (this.editor.tabManager.activeFile !== file) {
      await this.editor.tabManager.setFocusFile(file);
    }
    this.editor.lineController.loadContent(change.beforeText);
    this.editor.lineController.markDirtyAll?.();
    this.editor.lineController.refresh(true);
    if (
      change.cursorBefore &&
      this.editor.cursorController?.setCursorPosition
    ) {
      this.editor.cursorController.setCursorPosition(
        change.cursorBefore.row,
        change.cursorBefore.column,
      );
    }
    file.setIsSaved(false);
    return true;
  }

  async undoFileChanges(change, options = {}) {
    const session = options.session || this.getActiveSession();
    const fileChanges = this.getFileChanges(session, change);
    if (!fileChanges.length) return false;
    for (const fileChange of [...fileChanges].reverse()) {
      const undone = await this.undoSingleChange(fileChange);
      if (!undone) {
        if (options.refresh !== false) this.refresh();
        return false;
      }
      this.removeChanges(session, [fileChange], false);
    }
    this.clearChangeDiff(fileChanges[0]);
    if (options.refresh !== false) this.refresh();
    return true;
  }

  async undoAllChanges(session = this.getActiveSession()) {
    if (!session?.changes?.length) return;
    const pendingChanges = [...session.changes].reverse();
    for (const change of pendingChanges) {
      if (!session.changes.includes(change)) continue;
      const undone = await this.undoFileChanges(change, {
        session,
        refresh: false,
      });
      if (!undone) break;
    }
    this.refresh();
  }

  async undoChange(change) {
    return this.undoFileChanges(change);
  }

  async refreshChangeFolders(paths = []) {
    const refreshFolder = this.editor?.fileExplorer?.refreshFolder;
    if (typeof refreshFolder !== "function") return;
    const parents = new Set(
      paths
        .filter((path) => typeof path === "string" && path)
        .map((path) => {
          const normalized = path.replace(/\\/g, "/");
          const index = normalized.lastIndexOf("/");
          return index > 0 ? normalized.slice(0, index) : normalized;
        }),
    );
    for (const parent of parents) {
      await refreshFolder.call(this.editor.fileExplorer, parent);
    }
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
      this.editor.tabManager.openFileWithPath(
        change.absolutePath || change.path,
      );
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

  updateView(options = {}) {
    const renderTabs = options.renderTabs !== false;
    const renderMessages = options.renderMessages !== false;
    const renderChanges = options.renderChanges !== false;

    if (renderTabs && this.tabsElement) {
      this.renderTabs(this.tabsElement);
    }

    if (renderMessages && this.messagesElement) {
      const shouldScroll = this.shouldAutoScrollMessages();
      const previousScrollTop = this.messagesElement.scrollTop;
      this.renderMessages(this.messagesElement);
      if (shouldScroll) this.scrollMessagesToBottom();
      else this.messagesElement.scrollTop = previousScrollTop;
    }

    if (renderChanges && this.changesElement) {
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
      runId: null,
      abortController: null,
      pendingTimeout: null,
      streamingMessage: null,
      queue: [],
      segments: [],
      currentSegment: null,
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

    for (const change of session.changes || []) {
      if (change.snapshotKey) {
        this.agent?.fileSnapshots?.delete(change.snapshotKey);
      }
    }

    for (const message of session.messages) {
      if (message?.role !== "activity") continue;
      for (const item of message.items || []) {
        this.activityItems.delete(item.id);
        this.activityItemElements.delete(item.id);
      }
    }
    const pendingPrefix = `${sessionId}:`;
    for (const key of this.pendingActivityItems.keys()) {
      if (key.startsWith(pendingPrefix)) this.pendingActivityItems.delete(key);
    }

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

    if (
      !session.runId ||
      this.agent.currentSessionId !== session.id ||
      this.agent.runId !== session.runId
    ) {
      return;
    }

    const stoppedRunId = session.runId;
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

    if (session.streamingMessage) {
      session.streamingMessage.streaming = false;
      session.streamingMessage = null;
    }

    this.collapseRunDetails(session, stoppedRunId);

    session.messages.push({
      role: "agent",
      content: "Génération interrompue.",
      timestamp: this.formatTime(),
    });

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
        ...provider,
        apiKey,
      });
      await this.editor.api.setAgentApiKey?.(provider.id, apiKey);
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
      const execution = this.agent.execute(content, {
        history: messageHistory,
        sessionId: session.id,
      });
      session.runId = this.agent.runId;
      const result = await execution;

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
        if (session.streamingMessage) {
          if (agentReply) session.streamingMessage.content = agentReply;
          session.streamingMessage.timestamp = this.formatTime();
          session.streamingMessage.streaming = false;
        } else if (agentReply) {
          const message = this.getRunSegment(
            session,
            session.runId,
            "assistant",
            true,
          );
          message.role = "agent";
          message.content = agentReply;
          message.timestamp = this.formatTime();
          message.streaming = false;
          if (session.id === this.activeSessionId && this.messagesElement) {
            this.removeEmptyState();
            this.messagesElement.appendChild(
              this.createMessageElement(message),
            );
          }
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Requête Agent annulée par l'utilisateur.");
      } else {
        console.error("Erreur avec Agent:", error);
        if (session.streamingMessage) {
          session.streamingMessage.streaming = false;
        }
        session.messages.push({
          role: "agent",
          content:
            error?.userMessage ||
            error?.message ||
            "La requête vers le modèle a échoué.",
          timestamp: this.formatTime(),
        });
      }
    } finally {
      const shouldScroll = this.shouldAutoScrollMessages();
      const completedRunId = session.runId;
      if (Number.isInteger(completedRunId)) {
        const activityContext = {
          sessionId: session.id,
          runId: completedRunId,
        };
        this.finishActivityGroup(activityContext);
        this.collapseRunDetails(session, completedRunId);
      }
      session.runId = null;
      session.isGenerating = false;
      session.streamingMessage = null;
      if (session.currentSegment) {
        session.currentSegment.status = "complete";
      }

      this.processQueue(session.id);
      this.refresh();
      if (shouldScroll) this.scrollMessagesToBottom();
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
