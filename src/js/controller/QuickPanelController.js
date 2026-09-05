class QuickPanelController {
  constructor(editor) {
    this.editor = editor;
    this.host = document.querySelector(".quick-panel-host");
    this.session = null;
    this.previousFocus = null;
    this.hoveredItem = null;
    this.requestGeneration = 0;

    if (!this.host) return;

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

    this.input.addEventListener("input", () => this.handleInput());
    this.input.addEventListener("keydown", (event) =>
      this.handleKeyDown(event),
    );

    this.list.addEventListener(
      "click",
      (event) => this.acceptListItem(event),
      true,
    );

    this.host.addEventListener("click", (event) => {
      if (event.target === this.host) this.close();
    });
  }

  open(options = {}) {
    if (!this.host) return false;
    if (this.isOpen()) {
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
    };
    this.requestGeneration++;

    this.host.classList.add("is-open");
    this.host.setAttribute("aria-hidden", "false");
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
    this.session = null;
    this.previousFocus = null;
    this.hoveredItem = null;

    this.host.classList.remove("is-open");
    this.host.setAttribute("aria-hidden", "true");
    this.input.value = "";
    this.input.type = "text";
    this.list.replaceChildren();
    this.empty.textContent = "";
    this.error.textContent = "";

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

  isOpen(id) {
    return Boolean(this.session && (!id || this.session.id === id));
  }

  handleInput() {
    if (!this.session) return;
    this.session.query = this.input.value;
    this.error.hidden = true;
    if (this.session.mode === "pick") this.loadItems(this.session.query);
  }

  handleKeyDown(event) {
    if (!this.session) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }

    if (this.session.mode === "input") {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        this.accept(this.input.value);
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      this.setSelection(
        event.key === "Home" ? 0 : this.session.visibleItems.length - 1,
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = this.session.visibleItems[this.session.selectedIndex];
      if (item) this.accept(item);
    }
  }

  async loadItems(query) {
    if (!this.session) return;

    const session = this.session;
    const provider = session.options.items;
    const generation = ++this.requestGeneration;
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
      this.empty.textContent = "Unable to load results";
      this.empty.hidden = false;
      this.render();
    }
  }

  updateVisibleItems() {
    if (!this.session) return;

    const query = this.session.query.trim().toLowerCase();
    this.session.visibleItems = this.session.items.filter((item) => {
      if (!query) return true;
      return [
        item.label,
        item.description,
        item.detail,
        ...(Array.isArray(item.keywords) ? item.keywords : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    const selectedId = this.session.options.selectedId;
    const selectedIndex = this.session.visibleItems.findIndex(
      (item) => String(item.id) === String(selectedId),
    );
    this.session.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    this.render();
    if (selectedIndex >= 0) this.scrollSelectedIntoView();
  }

  setSelection(index) {
    if (!this.session || this.session.visibleItems.length === 0) return;
    const count = this.session.visibleItems.length;
    const nextIndex = (index + count) % count;
    if (nextIndex === this.session.selectedIndex) return;

    const previousIndex = this.session.selectedIndex;
    this.hoveredItem?.classList.remove("is-hovered");
    this.hoveredItem = null;
    this.session.selectedIndex = nextIndex;
    this.updateSelectionDOM(previousIndex, nextIndex);
    this.scrollSelectedIntoView();
  }

  updateSelectionDOM(previousIndex, nextIndex) {
    const previousRow = this.list.children[previousIndex];
    const nextRow = this.list.children[nextIndex];
    previousRow?.setAttribute("aria-selected", "false");
    nextRow?.setAttribute("aria-selected", "true");
  }

  moveSelection(offset) {
    if (!this.session) return;
    this.setSelection(this.session.selectedIndex + offset);
  }

  scrollSelectedIntoView() {
    const row = this.list.children[this.session?.selectedIndex];
    row?.scrollIntoView?.({ block: "nearest" });
  }

  acceptListItem(event) {
    if (!this.session) return;

    const row = event.target.closest?.(".quick-panel-item");
    if (!row) return;

    event.preventDefault();
    event.stopPropagation();
    const item = this.session.visibleItems.find(
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
    if (typeof options.onAccept === "function") options.onAccept(value);
  }

  render() {
    if (!this.session) return;

    this.list.replaceChildren();
    this.error.hidden = true;
    this.empty.hidden = true;

    if (this.session.mode === "input") return;
    if (this.session.loading) {
      this.empty.textContent = "Loading...";
      this.empty.hidden = false;
      return;
    }
    if (this.session.visibleItems.length === 0) {
      this.empty.textContent =
        this.session.options.emptyMessage || "No results";
      this.empty.hidden = false;
      return;
    }

    this.session.visibleItems.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "quick-panel-item";
      row.dataset.itemId = String(item.id);
      row.setAttribute("role", "option");
      row.setAttribute(
        "aria-selected",
        String(index === this.session.selectedIndex),
      );
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
      label.textContent = item.label;
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

      row.addEventListener("mouseenter", () => {
        this.setSelection(index);
        this.setHoveredItem(row);
      });
      row.addEventListener("mouseleave", () => {
        this.clearHoveredItem(row);
      });

      this.list.appendChild(row);
    });
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
