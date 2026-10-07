class QuickPanel {
  constructor(editor) {
    this.editor = editor;
    this.host = null;
    this.panel = null;
    this.title = null;
    this.input = null;
    this.list = null;
    this.listLayer = null;
    this.empty = null;
    this.error = null;
    this.resultsScroller = null;
    this.initialized = false;
    this.session = null;
    this.previousFocus = null;
    this.hoveredItem = null;
    this.requestGeneration = 0;
    this.closeCleanupTimer = null;
  }

  init() {
    if (this.initialized) return true;
    const host = document.querySelector(".quick-panel-host");
    if (!host) return false;
    this.host = host;

    this.panel = document.createElement("section");
    this.panel.className = "quick-panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");

    this.title = document.createElement("div");
    this.title.className = "quick-panel-title";

    this.input = document.createElement("input");
    this.input.className = "quick-panel-input";
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;

    this.list = document.createElement("div");
    this.list.className = "quick-panel-list";
    this.list.setAttribute("role", "listbox");

    this.listLayer = document.createElement("div");
    this.listLayer.className = "quick-panel-list-layer";
    this.list.appendChild(this.listLayer);

    this.empty = document.createElement("div");
    this.empty.className = "quick-panel-empty";

    this.error = document.createElement("div");
    this.error.className = "quick-panel-error";

    this.panel.append(
      this.title,
      this.input,
      this.error,
      this.list,
      this.empty,
    );
    this.host.appendChild(this.panel);
    this.host.setAttribute("aria-hidden", "true");

    if (typeof QuickPanelScroller === "function") {
      this.resultsScroller = new QuickPanelScroller(this.editor, this);
      this.resultsScroller.attach(this.list, this.listLayer);
    }

    this.initialized = true;
    return true;
  }

  open(options = {}) {
    if (!this.init()) return false;
    if (this.closeCleanupTimer) {
      clearTimeout(this.closeCleanupTimer);
      this.closeCleanupTimer = null;
    }
    this.host.classList.remove("is-switching");
    if (this.isOpen()) {
      if (this.isOpen(options.id)) {
        this.input.focus();
        return true;
      }
      this.close({ notifyCancel: false, restoreFocus: false });
    }

    const mode = options.mode === "input" ? "input" : "pick";
    this.previousFocus = document.activeElement;
    this.session = {
      id: options.id || `quick-panel-${Date.now()}`,
      mode,
      query: mode === "pick" ? "" : String(options.value ?? ""),
      items: [],
      visibleItems: [],
      selectedIndex: 0,
      options,
      loading: false,
      loadError: false,
    };
    this.requestGeneration++;

    this.host.classList.add("is-open");
    this.host.setAttribute("aria-hidden", "false");
    this.panel.dataset.panelId = this.session.id;
    this.input.type = options.inputType === "password" ? "password" : "text";
    this.input.placeholder = options.placeholder || "";
    this.input.value = mode === "input" ? String(options.value ?? "") : "";
    this.input.setAttribute(
      "aria-label",
      options.placeholder || options.title || "Quick panel",
    );
    this.title.textContent = options.title || "";
    this.title.hidden = !options.title;
    this.list.hidden = mode !== "pick";
    this.empty.hidden = true;
    this.error.hidden = true;

    if (mode === "pick") this.resultsScroller?.resume();
    else this.resultsScroller?.suspend();

    this.render();
    this.input.focus();
    this.input.setSelectionRange(
      this.input.value.length,
      this.input.value.length,
    );

    if (mode === "pick") this.loadItems(this.session.query);
    return true;
  }

  close({ notifyCancel = true, restoreFocus = true } = {}) {
    if (!this.session) return false;

    const options = this.session.options;
    const previousFocus = this.previousFocus;
    this.requestGeneration++;
    this.resultsScroller?.suspend();
    this.session = null;
    this.previousFocus = null;
    this.hoveredItem = null;

    this.host.classList.remove("is-open");
    const transitionDuration = options.transitionDuration || 160;
    if (options.deferAcceptUntilClose) this.host.classList.add("is-switching");
    this.host.setAttribute("aria-hidden", "true");
    delete this.panel.dataset.panelId;
    this.input.blur();
    this.input.value = "";
    this.input.type = "text";
    this.empty.textContent = "";
    this.error.textContent = "";

    // Keep the rendered rows until the fade-out has completed.
    this.closeCleanupTimer = setTimeout(() => {
      this.closeCleanupTimer = null;
      if (!this.session) this.resultsScroller?.clear();
    }, transitionDuration);

    if (restoreFocus) {
      if (
        previousFocus?.isConnected &&
        typeof previousFocus.focus === "function"
      ) {
        previousFocus.focus();
      } else if (this.editor.output?.focus) {
        this.editor.output.focus({ preventScroll: true });
        this.editor.setSelected?.(true);
      }
    }

    if (notifyCancel && typeof options.onCancel === "function") {
      options.onCancel();
    }
    return true;
  }

  destroy() {
    if (this.session) this.close({ notifyCancel: false, restoreFocus: false });
    clearTimeout(this.closeCleanupTimer);
    this.closeCleanupTimer = null;
    this.resultsScroller?.destroy();
    this.resultsScroller = null;
    this.panel?.remove();
    this.host?.removeAttribute("aria-hidden");
    this.panel = null;
    this.host = null;
    this.list = null;
    this.listLayer = null;
    this.initialized = false;
  }

  isOpen(id) {
    return Boolean(this.session && (!id || this.session.id === id));
  }

  handleInput() {
    if (!this.session) return;
    this.session.query = this.input.value;
    this.error.hidden = true;
    if (this.session.mode === "pick") {
      if (this.session.options.reloadOnInput === false) this.updateVisibleItems();
      else this.loadItems(this.session.query);
    }
  }

  handleInputEvent(event) {
    if (!this.session || event.target !== this.input) return false;
    this.handleInput();
    return true;
  }

  handleKeyDownEvent(event) {
    if (!this.session || event.target !== this.input) return false;
    return this.handleKeyDown(event);
  }

  handleItemClick(event) {
    if (!this.session) return false;
    const row = event.target.closest?.(".quick-panel-list .quick-panel-item");
    if (!row) return false;
    event.preventDefault();
    event.stopPropagation();
    this.acceptRow(row);
    return true;
  }

  handleBackdropClick(event) {
    if (!this.session || event.target !== this.host) return false;
    this.close();
    return true;
  }

  handleContextMenu(event) {
    if (!this.session) return false;
    const row = event.target.closest?.(".quick-panel-list .quick-panel-item");
    if (!row) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this.acceptRow(row);
    return true;
  }

  handleKeyDown(event) {
    if (!this.session) return false;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return true;
    }

    if (this.session.mode === "input") {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        this.accept(this.input.value);
        return true;
      }
      return false;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return true;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      this.setSelection(
        event.key === "Home" ? 0 : this.session.visibleItems.length - 1,
      );
      return true;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = this.session.visibleItems[this.session.selectedIndex];
      if (item) this.accept(item);
      return true;
    }
    return false;
  }

  async loadItems(query) {
    if (!this.session) return;

    const session = this.session;
    const provider = session.options.items;
    const generation = ++this.requestGeneration;
    session.visibleItems = [];
    session.selectedIndex = 0;
    session.loadError = false;
    session.loading = typeof provider === "function";
    this.render();

    try {
      const result =
        typeof provider === "function" ? await provider(query) : provider;
      if (this.session !== session || generation !== this.requestGeneration)
        return;
      session.items = Array.isArray(result)
        ? result.filter((item) => item && item.id != null && item.label != null)
        : [];
      session.loading = false;
      this.updateVisibleItems();
    } catch (error) {
      if (this.session !== session || generation !== this.requestGeneration)
        return;
      session.items = [];
      session.loading = false;
      session.loadError = true;
      this.render();
    }
  }

  updateVisibleItems() {
    if (!this.session) return;

    const query = this.session.query.trim().toLowerCase();
    const filterItems = this.session.options.filterItems;
    const filtered = typeof filterItems === "function"
      ? filterItems(this.session.items, query)
      : this.session.items.filter((item) => {
          if (!query) return true;
          return [item.label, item.description, item.detail,
            ...(Array.isArray(item.keywords) ? item.keywords : [])]
            .filter(Boolean).join(" ").toLowerCase().includes(query);
        });
    const configuredLimit = this.session.options.renderLimit;
    const limit = configuredLimit
      ? Math.max(1, Math.floor(configuredLimit))
      : 0;
    const emptyItem = filtered.length === 0 && typeof this.session.options.emptyItem === "function"
      ? this.session.options.emptyItem(this.session.query)
      : null;
    this.session.visibleItems = emptyItem
      ? [emptyItem]
      : limit > 0 ? filtered.slice(0, limit) : filtered;

    const selectedId = this.session.options.selectedId;
    const selectedIndex = this.session.visibleItems.findIndex(
      (item) => String(item.id) === String(selectedId),
    );
    this.session.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    this.render();
    if (selectedIndex >= 0) this.scrollSelectedIntoView();
  }

  setSelection(index, { notify = false } = {}) {
    if (!this.session || this.session.visibleItems.length === 0) return;
    const count = this.session.visibleItems.length;
    const nextIndex = (index + count) % count;
    if (nextIndex === this.session.selectedIndex) {
      this.scrollSelectedIntoView();
      return;
    }

    const previousIndex = this.session.selectedIndex;
    this.hoveredItem?.classList.remove("is-hovered");
    this.hoveredItem = null;
    this.session.selectedIndex = nextIndex;
    this.updateSelectionDOM(previousIndex, nextIndex);
    this.scrollSelectedIntoView();
    if (notify) {
      this.session.options.onSelectionChange?.(
        this.session.visibleItems[nextIndex],
      );
    }
  }

  updateSelectionDOM(previousIndex, nextIndex) {
    this.resultsScroller?.updateSelection(previousIndex, nextIndex);
  }

  moveSelection(offset) {
    if (!this.session) return;
    this.setSelection(this.session.selectedIndex + offset, { notify: true });
  }

  scrollSelectedIntoView() {
    if (this.session) {
      this.resultsScroller?.ensureIndexVisible(this.session.selectedIndex);
    }
  }

  acceptRow(row) {
    if (!this.session || !row) return;
    const itemIndex = Number(row.dataset.itemIndex);
    const indexedItem = Number.isInteger(itemIndex)
      ? this.session.visibleItems[itemIndex]
      : null;
    const item = indexedItem && String(indexedItem.id) === row.dataset.itemId
      ? indexedItem
      : this.session.visibleItems.find(
          (candidate) => String(candidate.id) === row.dataset.itemId,
        );
    if (item) this.accept(item);
  }

  accept(value) {
    if (!this.session) return;

    const options = this.session.options;
    if (this.session.mode === "pick" && value?.disabled) return;

    const validation =
      typeof options.validate === "function" ? options.validate(value) : null;
    if (validation) {
      this.error.textContent = validation;
      this.error.hidden = false;
      this.input.focus();
      return;
    }

    this.close({ notifyCancel: false });
    if (typeof options.onAccept === "function") {
      if (options.deferAcceptUntilClose) {
        setTimeout(() => options.onAccept(value), options.transitionDuration || 160);
      } else {
        options.onAccept(value);
      }
    }
  }

  render() {
    if (!this.session) return;

    this.error.hidden = true;
    this.empty.hidden = true;

    if (this.session.mode === "input") {
      this.resultsScroller?.setItems([]);
      const message = this.session.options.message;
      if (message) {
        this.empty.textContent = typeof message === "function"
          ? message() : message;
        this.empty.hidden = false;
      }
      return;
    }
    if (this.session.loading) {
      this.resultsScroller?.setItems([]);
      this.empty.textContent = "Loading...";
      this.empty.hidden = false;
      return;
    }
    if (this.session.loadError) {
      this.resultsScroller?.setItems([]);
      this.empty.textContent = "Unable to load results";
      this.empty.hidden = false;
      return;
    }
    if (this.session.visibleItems.length === 0) {
      this.resultsScroller?.setItems([]);
      const emptyMessage = this.session.options.emptyMessage;
      this.empty.textContent = typeof emptyMessage === "function"
        ? emptyMessage(this.session.query)
        : emptyMessage || "No results";
      this.empty.hidden = false;
      return;
    }

    this.resultsScroller?.resume();
    this.resultsScroller?.setItems(this.session.visibleItems);
  }

  createVirtualRow(entry, itemCount) {
    if (entry.type === "separator") {
      const separator = document.createElement("div");
      separator.className = "quick-panel-separator";
      separator.setAttribute("role", "separator");
      return separator;
    }
    if (entry.type === "section") {
      const heading = document.createElement("div");
      heading.className = "quick-panel-group-label";
      heading.textContent = entry.section;
      heading.setAttribute("role", "presentation");
      return heading;
    }

    const item = this.session.visibleItems[entry.itemIndex];
    return this.createItemRow(item, entry.itemIndex, itemCount);
  }

  createItemRow(item, index, itemCount) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "quick-panel-item";
    row.dataset.itemIndex = String(index);
    row.dataset.itemId = String(item.id);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === this.session.selectedIndex));
    row.setAttribute("aria-posinset", String(index + 1));
    row.setAttribute("aria-setsize", String(itemCount));
    row.disabled = Boolean(item.disabled);

    if (item.icon) {
      const icon = document.createElement("i");
      icon.className = item.icon;
      icon.setAttribute("aria-hidden", "true");
      row.appendChild(icon);
    }

    const content = document.createElement("span");
    content.className = "quick-panel-item-content";
    const label = document.createElement("span");
    label.className = "quick-panel-item-label";
    label.textContent = this.session.options.preserveLabelCase
      ? String(item.label)
      : this.capitalizeLabel(item.label);
    content.appendChild(label);

    if (item.description || item.detail) {
      const description = document.createElement("span");
      description.className = "quick-panel-item-description";
      description.textContent = item.description || item.detail;
      content.appendChild(description);
    }
    row.appendChild(content);

    if (item.shortcut) {
      const shortcut = document.createElement("span");
      shortcut.className = "quick-panel-item-shortcut";
      this.appendShortcut(shortcut, item.shortcut);
      row.appendChild(shortcut);
    }

    if (
      item.checked === true ||
      String(item.id) === String(this.session.options.selectedId)
    ) {
      const checkmark = document.createElement("span");
      checkmark.className = "quick-panel-item-checkmark";
      checkmark.textContent = "✓";
      checkmark.setAttribute("aria-label", "Selected");
      row.appendChild(checkmark);
    }

    return row;
  }

  handleItemPointerOverEvent(event) {
    if (!this.session || this.session.mode !== "pick") return false;
    const row = event.target.closest?.(".quick-panel-list .quick-panel-item");
    if (!row || !this.list.contains(row) || row.contains(event.relatedTarget)) {
      return false;
    }
    const index = Number(row.dataset.itemIndex);
    if (Number.isInteger(index)) this.setSelection(index);
    this.setHoveredItem(row);
    return true;
  }

  handleItemPointerOutEvent(event) {
    if (!this.session || this.session.mode !== "pick") return false;
    const row = event.target.closest?.(".quick-panel-list .quick-panel-item");
    if (!row || !this.list.contains(row) || row.contains(event.relatedTarget)) {
      return false;
    }
    this.clearHoveredItem(row);
    return true;
  }

  capitalizeLabel(label) {
    const value = String(label ?? "");
    return value.replace(
      /^(\s*)(\S)/,
      (_, whitespace, firstCharacter) =>
        whitespace + firstCharacter.toUpperCase(),
    );
  }

  setHoveredItem(row) {
    if (this.hoveredItem === row) return;
    this.hoveredItem?.classList.remove("is-hovered");
    row.classList.add("is-hovered");
    this.hoveredItem = row;
  }

  clearHoveredItem(row) {
    row.classList.remove("is-hovered");
    if (this.hoveredItem === row) this.hoveredItem = null;
  }

  appendShortcut(container, shortcut) {
    const modifierIcons = {
      Mod:
        window.api?.platform === "darwin"
          ? "fi fi-rr-command"
          : "fi fi-rr-control",
      Meta: "fi fi-rr-command",
      Ctrl: "fi fi-rr-control",
      Shift: "fi fi-rr-arrow-up",
      Alt: "fi fi-rr-option",
    };

    for (const part of String(shortcut).split("+")) {
      const value = part.trim();
      const iconClass = modifierIcons[value];
      if (iconClass) {
        const icon = document.createElement("i");
        icon.className = iconClass;
        icon.setAttribute("aria-hidden", "true");
        container.appendChild(icon);
      } else {
        const key = document.createElement("span");
        key.className = "quick-panel-shortcut-key";
        key.textContent = value;
        container.appendChild(key);
      }
    }
  }
}
