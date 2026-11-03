class LspCompletionWidget {
  constructor(editor) {
    this.editor = editor;
    this.element = document.createElement("div");
    this.element.className = "lsp-completion";
    this.element.hidden = true;
    this.element.setAttribute("role", "listbox");
    this.element.setAttribute("aria-label", "Suggestions");
    editor.mainSection?.appendChild(this.element);
    this.items = [];
    this.filtered = [];
    this.visibleItems = [];
    this.selectedIndex = 0;
    this.prefix = "";
    this.session = null;
    this.onAccept = null;
    this.onChange = null;
    this.onDismiss = null;
  }

  get isVisible() {
    return this.element.hidden === false;
  }

  show({ items, prefix, session, onAccept, onChange, onDismiss, anchorRect }) {
    this.items = Array.isArray(items) ? items : [];
    this.prefix = prefix || "";
    this.session = session || null;
    this.onAccept = onAccept || null;
    this.onChange = onChange || null;
    this.onDismiss = onDismiss || null;
    this.selectedIndex = 0;
    this.element.hidden = false;
    this.filter();
    this.position(anchorRect);
  }

  setPrefix(prefix) {
    this.prefix = prefix || "";
    this.selectedIndex = 0;
    this.filter();
    if (!this.visibleItems.length && !this.prefix) this.hide();
  }

  position(anchorRect) {
    const container = this.editor.mainSection?.getBoundingClientRect();
    if (!container || !anchorRect) return;
    const width = Math.min(460, Math.max(260, container.width * 0.42));
    this.element.style.width = `${Math.round(width)}px`;
    const rect = this.element.getBoundingClientRect();
    let left = anchorRect.left - container.left;
    left = Math.max(8, Math.min(left, container.width - rect.width - 8));
    let top = anchorRect.bottom - container.top + 4;
    if (top + rect.height > container.height - 8)
      top = Math.max(8, anchorRect.top - container.top - rect.height - 4);
    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${Math.round(top)}px`;
  }

  filter() {
    const prefix = this.prefix.toLowerCase();
    const source = this.items;
    const matches = (item) => {
      const label = String(item.filterText || item.label || "").toLowerCase();
      return !prefix || label.startsWith(prefix);
    };
    let filtered = source.filter(matches);
    if (!filtered.length && prefix) {
      filtered = source.filter((item) => {
        const label = String(item.filterText || item.label || "").toLowerCase();
        return label.includes(prefix);
      });
    }
    this.filtered = filtered.slice(0, 100);
    this.visibleItems = this.filtered;
    if (this.selectedIndex >= this.visibleItems.length) this.selectedIndex = 0;
    this.render();
    this.onChange?.(this.visibleItems, this.prefix);
  }

  render() {
    this.element.replaceChildren();
    if (!this.visibleItems.length) {
      const empty = document.createElement("div");
      empty.className = "lsp-completion-empty";
      empty.textContent = "No suggestions";
      this.element.appendChild(empty);
      return;
    }
    this.visibleItems.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "lsp-completion-item";
      row.classList.toggle("is-selected", index === this.selectedIndex);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", index === this.selectedIndex ? "true" : "false");
      row.dataset.index = String(index);
      const label = document.createElement("span");
      label.className = "lsp-completion-label";
      label.textContent = item.label;
      row.appendChild(label);
      const annotation = this.completionDescription(item);
      if (annotation) {
        const description = document.createElement("span");
        description.className = "lsp-completion-annotation";
        description.textContent = annotation;
        row.appendChild(description);
      }
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.selectedIndex = index;
        this.acceptSelected();
      });
      this.element.appendChild(row);
    });
    this.scrollSelectedIntoView();
  }

  completionDescription(item) {
    const detail = typeof item?.detail === "string" ? item.detail : "";
    if (!detail) return "";
    const method = /^\((?:method|function|constructor)\)\s+(.+)$/.exec(detail);
    if (method || [2, 3, 4].includes(item?.kind)) {
      const signature = method ? method[1] : detail;
      const open = signature.indexOf("(");
      const owner = (open >= 0 ? signature.slice(0, open) : signature).trim();
      const parts = owner.split(".").filter(Boolean);
      return parts.length > 1 ? parts[parts.length - 2] : "";
    }
    const colon = detail.indexOf(": ");
    if (colon < 0) return "";
    return this.summarizeType(detail.slice(colon + 2));
  }

  summarizeType(type) {
    const compact = String(type || "").replace(/\s+/g, " ").trim();
    if (!compact) return "";
    const constructed = /\bnew\s*\([^)]*\)\s*(?::|=>)\s*([^;]+)/.exec(compact);
    if (constructed) return constructed[1].trim();
    if (compact.startsWith("{")) return "object";
    return compact.slice(0, 60);
  }

  scrollSelectedIntoView() {
    const row = this.element.querySelector(`[data-index="${this.selectedIndex}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }

  move(delta) {
    if (!this.visibleItems.length) return;
    this.selectedIndex = (this.selectedIndex + delta + this.visibleItems.length) % this.visibleItems.length;
    this.render();
  }

  handleKeyDown(event) {
    if (!this.isVisible) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
      return true;
    }
    if (!this.visibleItems.length) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      this.move(1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.move(-1);
      return true;
    }
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      event.stopPropagation();
      this.move(event.key === "PageDown" ? 10 : -10);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      this.acceptSelected();
      return true;
    }
    return false;
  }

  acceptSelected() {
    const item = this.visibleItems[this.selectedIndex];
    if (!item) return;
    const session = this.session;
    const accept = this.onAccept;
    this.hide();
    accept?.(item, session);
  }

  hide() {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.element.replaceChildren();
    this.visibleItems = [];
    this.items = [];
    this.session = null;
    this.onAccept = null;
    this.onChange = null;
    this.onDismiss?.();
  }

  destroy() {
    this.element.remove();
  }
}
