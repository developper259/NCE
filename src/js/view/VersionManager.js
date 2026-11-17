class VersionManager {
  constructor(editor) {
    this.editor = editor;
    this.host = null;
    this.dialog = null;
    this.nav = null;
    this.main = null;
    this.footer = null;
    this.footerStatus = null;
    this.footerProgress = null;
    this.footerProgressFill = null;
    this.footerProgressLabel = null;
    this.footerCancel = null;
    this.closeButton = null;
    this.previousFocus = null;
    this.snapshot = null;
    this.loading = false;
    this.loadError = null;
    this.section = "overview";
    this.selectedPackageId = null;
    this.searchQuery = "";
    this.operations = new Map();
    this.confirmation = null;
    this.unsubscribe = null;
    this.hideTimer = null;
    this.onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.requestClose();
      } else if (event.key === "Tab") {
        this.trapFocus(event);
      }
    };
  }

  get api() {
    return this.editor.api?.versionManager || null;
  }

  ensureDOM() {
    if (this.host) return true;
    if (!document.body) return false;

    const host = document.createElement("div");
    host.className = "nce-vm-host";
    host.hidden = true;
    host.setAttribute("aria-hidden", "true");

    const dialog = document.createElement("section");
    dialog.className = "nce-vm-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "nce-vm-title");

    const header = document.createElement("header");
    header.className = "nce-vm-header";
    const headerIcon = document.createElement("i");
    headerIcon.className = "fi fi-rr-database nce-vm-header-icon";
    headerIcon.setAttribute("aria-hidden", "true");
    const title = document.createElement("h2");
    title.id = "nce-vm-title";
    title.className = "nce-vm-title";
    title.textContent = "Version Manager";
    const subtitle = document.createElement("span");
    subtitle.className = "nce-vm-subtitle";
    subtitle.textContent = "Tools managed by NCE";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "nce-vm-close";
    closeButton.title = "Close (Escape)";
    closeButton.setAttribute("aria-label", "Close Version Manager");
    closeButton.dataset.focusKey = "vm-close";
    const closeIcon = document.createElement("i");
    closeIcon.className = "fi fi-rr-cross-small";
    closeIcon.setAttribute("aria-hidden", "true");
    closeButton.appendChild(closeIcon);
    closeButton.addEventListener("click", () => this.requestClose());
    header.append(headerIcon, title, subtitle, closeButton);

    const body = document.createElement("div");
    body.className = "nce-vm-body";
    const nav = document.createElement("nav");
    nav.className = "nce-vm-nav";
    nav.setAttribute("aria-label", "Version Manager sections");
    const main = document.createElement("div");
    main.className = "nce-vm-main";
    main.setAttribute("aria-live", "polite");
    body.append(nav, main);

    const footer = document.createElement("footer");
    footer.className = "nce-vm-footer";
    const footerStatus = document.createElement("span");
    footerStatus.className = "nce-vm-footer-status";
    footerStatus.setAttribute("role", "status");
    const footerProgress = document.createElement("div");
    footerProgress.className = "nce-vm-footer-progress";
    footerProgress.hidden = true;
    const footerProgressLabel = document.createElement("span");
    footerProgressLabel.className = "nce-vm-footer-progress-label";
    const progressTrack = document.createElement("div");
    progressTrack.className = "nce-vm-progress-track";
    const footerProgressFill = document.createElement("div");
    footerProgressFill.className = "nce-vm-progress-fill";
    progressTrack.appendChild(footerProgressFill);
    footerProgress.append(footerProgressLabel, progressTrack);
    const footerCancel = this.createButton("Cancel", () => this.cancelActiveOperation(), {
      className: "nce-vm-button nce-vm-footer-cancel",
      focusKey: "vm-cancel",
    });
    footerCancel.hidden = true;
    footer.append(footerStatus, footerProgress, footerCancel);

    dialog.append(header, body, footer);
    host.appendChild(dialog);
    host.addEventListener("click", (event) => {
      if (event.target === host) this.requestClose();
    });
    host.addEventListener("keydown", this.onKeyDown);
    document.body.appendChild(host);

    this.host = host;
    this.dialog = dialog;
    this.nav = nav;
    this.main = main;
    this.footer = footer;
    this.footerStatus = footerStatus;
    this.footerProgress = footerProgress;
    this.footerProgressFill = footerProgressFill;
    this.footerProgressLabel = footerProgressLabel;
    this.footerCancel = footerCancel;
    this.closeButton = closeButton;
    this.renderNav();
    return true;
  }

  createButton(label, onClick, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = options.className || "nce-vm-button";
    if (options.focusKey) button.dataset.focusKey = options.focusKey;
    if (options.title) button.title = options.title;
    if (options.disabled) button.disabled = true;
    if (options.icon) {
      const icon = document.createElement("i");
      icon.className = `fi ${options.icon}`;
      icon.setAttribute("aria-hidden", "true");
      button.appendChild(icon);
    }
    if (label) {
      const text = document.createElement("span");
      text.textContent = label;
      button.appendChild(text);
    }
    button.addEventListener("click", onClick);
    return button;
  }

  show() {
    if (!this.ensureDOM()) return false;
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.previousFocus = document.activeElement;
    this.host.hidden = false;
    this.host.setAttribute("aria-hidden", "false");
    setTimeout(() => this.host?.classList.add("nce-vm-open"), 0);
    this.subscribe();
    this.reload();
    this.closeButton?.focus();
    return true;
  }

  hide() {
    if (!this.host || this.host.hidden) return false;
    this.host.classList.remove("nce-vm-open");
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.confirmation = null;
    const finish = () => {
      this.hideTimer = null;
      if (!this.host) return;
      this.host.hidden = true;
      this.host.setAttribute("aria-hidden", "true");
      if (this.previousFocus?.isConnected && typeof this.previousFocus.focus === "function")
        this.previousFocus.focus();
      this.previousFocus = null;
    };
    this.hideTimer = setTimeout(finish, 160);
    return true;
  }

  requestClose() {
    if (this.activeOperation()) {
      this.confirmation = { kind: "close" };
      this.renderFooter();
      return false;
    }
    return this.hide();
  }

  subscribe() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (typeof this.api?.onEvent !== "function") return;
    this.unsubscribe = this.api.onEvent((event) => this.handleEvent(event));
  }

  handleEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "operation" && event.operation) {
      const operation = event.operation;
      const previous = this.operations.get(operation.packageId);
      if (operation.state === "running") this.operations.set(operation.packageId, operation);
      else this.operations.delete(operation.packageId);
      this.renderFooter();
      const started = operation.state === "running" && previous?.state !== "running";
      const finished = operation.state !== "running";
      if (started || finished) this.reload();
      return;
    }
    if (event.type === "inventory-changed") this.reload();
  }

  async reload() {
    if (!this.api) {
      this.loadError = "The Version Manager API is unavailable.";
      this.loading = false;
      this.render();
      return;
    }
    this.loading = !this.snapshot;
    this.render();
    try {
      this.snapshot = await this.api.getState();
      this.loadError = null;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    this.loading = false;
    this.render();
  }

  activeOperation() {
    for (const operation of this.operations.values())
      if (operation.state === "running") return operation;
    const fromSnapshot = this.snapshot?.operations?.find((operation) => operation.state === "running");
    return fromSnapshot || null;
  }

  displayState(packageInfo) {
    const operation = this.operations.get(packageInfo.id);
    if (operation?.state === "running") {
      if (operation.kind === "install") return "installing";
      if (operation.kind === "uninstall") return "uninstalling";
    }
    return packageInfo.state;
  }

  packageById(packageId) {
    return this.snapshot?.packages?.find((entry) => entry.id === packageId) || null;
  }

  navigate(section) {
    this.section = section;
    this.selectedPackageId = null;
    this.confirmation = null;
    this.render();
  }

  openDetail(packageId) {
    this.selectedPackageId = packageId;
    this.section = "detail";
    this.confirmation = null;
    this.render();
  }

  trapFocus(event) {
    const focusable = this.focusableElements();
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const offset = event.shiftKey ? -1 : 1;
    const nextIndex = (currentIndex + offset + focusable.length) % focusable.length;
    event.preventDefault();
    focusable[nextIndex].focus();
  }

  focusableElements() {
    const elements = [];
    const walk = (node) => {
      if (!node || node.hidden) return;
      const tag = String(node.tagName || "").toLowerCase();
      if ((tag === "button" || tag === "input") && !node.disabled) elements.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(this.dialog);
    return elements;
  }

  render() {
    if (!this.host) return;
    const focusKey = document.activeElement?.dataset?.focusKey || null;
    this.renderNav();
    this.renderMain();
    this.renderFooter();
    if (focusKey) {
      const target = this.findByFocusKey(this.dialog, focusKey);
      target?.focus();
    }
  }

  findByFocusKey(node, focusKey) {
    if (!node) return null;
    if (node.dataset?.focusKey === focusKey) return node;
    for (const child of node.children || []) {
      const found = this.findByFocusKey(child, focusKey);
      if (found) return found;
    }
    return null;
  }

  renderNav() {
    if (!this.nav) return;
    const fragment = document.createDocumentFragment();
    for (const group of VersionManager.NAV_GROUPS) {
      if (group.label) {
        const label = document.createElement("span");
        label.className = "nce-vm-nav-group";
        label.textContent = group.label;
        fragment.appendChild(label);
      }
      for (const item of group.items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "nce-vm-nav-item";
        button.dataset.focusKey = `vm-nav-${item.id}`;
        if (this.section === item.id || (this.section === "detail" && item.id === "installed"))
          button.classList.add("active");
        const icon = document.createElement("i");
        icon.className = `fi ${item.icon}`;
        icon.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = item.label;
        button.append(icon, text);
        if (item.category) {
          const count = this.categoryCount(item.category);
          if (count > 0) {
            const badge = document.createElement("span");
            badge.className = "nce-vm-nav-count";
            badge.textContent = String(count);
            button.appendChild(badge);
          }
        }
        button.addEventListener("click", () => this.navigate(item.id));
        fragment.appendChild(button);
      }
    }
    this.nav.replaceChildren(fragment);
  }

  categoryCount(category) {
    return (this.snapshot?.packages || []).filter((entry) => entry.categories.includes(category)).length;
  }

  renderMain() {
    if (!this.main) return;
    if (this.loading) {
      this.main.replaceChildren(this.emptyState("fi-rr-refresh", "Loading inventory…", ""));
      return;
    }
    if (this.loadError) {
      this.main.replaceChildren(this.emptyState("fi-rr-cross-circle", "Version Manager unavailable", this.loadError));
      return;
    }
    if (!this.snapshot) {
      this.main.replaceChildren(this.emptyState("fi-rr-info", "No inventory yet", "Open the manager to load the inventory."));
      return;
    }
    if (this.section === "overview") this.renderOverview();
    else if (this.section === "installed") this.renderInstalled();
    else if (this.section === "available") this.renderAvailable();
    else if (this.section === "updates") this.renderUpdates();
    else if (this.section === "detail") this.renderDetail();
    else if (this.section.startsWith("category:")) this.renderCategory(this.section.slice("category:".length));
  }

  sectionHeader(title, description) {
    const header = document.createElement("div");
    header.className = "nce-vm-section-header";
    const heading = document.createElement("h3");
    heading.className = "nce-vm-section-title";
    heading.textContent = title;
    header.appendChild(heading);
    if (description) {
      const text = document.createElement("p");
      text.className = "nce-vm-section-description";
      text.textContent = description;
      header.appendChild(text);
    }
    return header;
  }

  emptyState(icon, title, description, action) {
    const wrap = document.createElement("div");
    wrap.className = "nce-vm-empty";
    const iconElement = document.createElement("i");
    iconElement.className = `fi ${icon}`;
    iconElement.setAttribute("aria-hidden", "true");
    const heading = document.createElement("p");
    heading.className = "nce-vm-empty-title";
    heading.textContent = title;
    wrap.append(iconElement, heading);
    if (description) {
      const text = document.createElement("p");
      text.className = "nce-vm-empty-description";
      text.textContent = description;
      wrap.appendChild(text);
    }
    if (action) wrap.appendChild(action);
    return wrap;
  }

  stateBadge(state) {
    const badge = document.createElement("span");
    badge.className = `nce-vm-badge nce-vm-badge-${state}`;
    const icon = document.createElement("i");
    icon.className = `fi ${VersionManager.STATE_ICONS[state] || "fi-rr-info"}`;
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = VersionManager.STATE_LABELS[state] || state;
    badge.append(icon, label);
    return badge;
  }

  categoryLabel(category) {
    return VersionManager.CATEGORY_LABELS[category] || category;
  }

  formatDate(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
    return new Date(timestamp).toLocaleDateString();
  }

  formatDateTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
    return new Date(timestamp).toLocaleString();
  }

  renderOverview() {
    const packages = this.snapshot.packages || [];
    const installations = packages.flatMap((entry) => entry.installations || []);
    const functional = installations.filter((record) => record.state === "installed").length;
    const attention = installations.filter((record) => record.state === "corrupted" || record.state === "unknown").length
      + packages.filter((entry) => entry.state === "failed").length;

    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.sectionHeader("Overview", "The tools NCE manages on this machine."));

    const stats = document.createElement("div");
    stats.className = "nce-vm-stats";
    stats.append(
      this.statBlock(String(packages.length), "Managed packages"),
      this.statBlock(String(functional), "Functional installations"),
      this.statBlock(String(attention), "Needs attention", attention > 0),
    );
    fragment.appendChild(stats);

    const operationsHeader = document.createElement("h4");
    operationsHeader.className = "nce-vm-subheading";
    operationsHeader.textContent = "Recent operations";
    fragment.appendChild(operationsHeader);
    const operations = (this.snapshot.operations || []).slice(0, 8);
    if (!operations.length) {
      fragment.appendChild(this.emptyState("fi-rr-info", "No operations yet", "Installations, verifications and removals will appear here."));
    } else {
      const list = document.createElement("div");
      list.className = "nce-vm-list";
      for (const operation of operations) {
        const packageInfo = this.packageById(operation.packageId);
        const row = document.createElement("div");
        row.className = "nce-vm-row nce-vm-row-static";
        const icon = document.createElement("i");
        icon.className = `fi ${VersionManager.OPERATION_ICONS[operation.kind] || "fi-rr-info"} nce-vm-row-icon`;
        icon.setAttribute("aria-hidden", "true");
        const main = document.createElement("div");
        main.className = "nce-vm-row-main";
        const name = document.createElement("span");
        name.className = "nce-vm-row-name";
        name.textContent = `${packageInfo?.name || operation.packageId} — ${VersionManager.OPERATION_LABELS[operation.kind] || operation.kind}`;
        const meta = document.createElement("span");
        meta.className = "nce-vm-row-meta";
        meta.textContent = operation.error
          ? `${operation.error.code}: ${operation.error.message}`
          : this.formatDateTime(operation.finishedAt || operation.startedAt);
        main.append(name, meta);
        row.append(icon, main, this.stateBadge(operation.state));
        list.appendChild(row);
      }
      fragment.appendChild(list);
    }

    const note = document.createElement("p");
    note.className = "nce-vm-note";
    note.textContent = "Languages, runtimes, compilers, toolchains and language servers will appear here once NCE can manage them. Nothing is listed before it is real.";
    fragment.appendChild(note);
    this.main.replaceChildren(fragment);
  }

  statBlock(value, label, warn = false) {
    const block = document.createElement("div");
    block.className = "nce-vm-stat";
    const number = document.createElement("span");
    number.className = "nce-vm-stat-value";
    if (warn) number.classList.add("nce-vm-stat-warn");
    number.textContent = value;
    const caption = document.createElement("span");
    caption.className = "nce-vm-stat-label";
    caption.textContent = label;
    block.append(number, caption);
    return block;
  }

  searchBar() {
    const wrap = document.createElement("div");
    wrap.className = "nce-vm-search";
    const icon = document.createElement("i");
    icon.className = "fi fi-rr-search";
    icon.setAttribute("aria-hidden", "true");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "nce-vm-search-input";
    input.placeholder = "Search by name, version or category";
    input.setAttribute("aria-label", "Search installations");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.dataset.focusKey = "vm-search";
    input.value = this.searchQuery;
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      this.renderMain();
      this.findByFocusKey(this.dialog, "vm-search")?.focus();
    });
    wrap.append(icon, input);
    return wrap;
  }

  matchesSearch(packageInfo, record) {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) return true;
    const haystack = [
      packageInfo.name,
      packageInfo.description,
      record?.version,
      record?.installDir,
      ...packageInfo.categories.map((category) => this.categoryLabel(category)),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  }

  installationRow(packageInfo, record) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "nce-vm-row nce-vm-row-button";
    row.dataset.focusKey = `vm-installation-${record.id}`;
    const icon = document.createElement("i");
    icon.className = `fi ${packageInfo.icon || "fi-rr-database"} nce-vm-row-icon`;
    icon.setAttribute("aria-hidden", "true");
    const main = document.createElement("div");
    main.className = "nce-vm-row-main";
    const name = document.createElement("span");
    name.className = "nce-vm-row-name";
    name.textContent = packageInfo.name;
    const meta = document.createElement("span");
    meta.className = "nce-vm-row-meta";
    meta.textContent = `${this.categoryLabel(packageInfo.categories[0])} · ${this.formatDate(record.installedAt)} · ${record.installDir}`;
    meta.title = record.installDir;
    main.append(name, meta);
    const version = document.createElement("span");
    version.className = "nce-vm-row-version";
    version.textContent = record.version;
    row.append(icon, main, version, this.stateBadge(record.state));
    row.addEventListener("click", () => this.openDetail(packageInfo.id));
    return row;
  }

  renderInstalled() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.sectionHeader("Installed", "Installations owned by NCE. External tools are listed in each package's details."));
    fragment.appendChild(this.searchBar());
    const entries = [];
    for (const packageInfo of this.snapshot.packages || [])
      for (const record of packageInfo.installations || [])
        if (this.matchesSearch(packageInfo, record)) entries.push({ packageInfo, record });

    if (!entries.length) {
      const searching = Boolean(this.searchQuery.trim());
      fragment.appendChild(this.emptyState(
        searching ? "fi-rr-search" : "fi-rr-database",
        searching ? `No installations match “${this.searchQuery.trim()}”` : "No managed installations yet",
        searching ? "Try a different name, version or category." : "Install a tool from the Available section to manage it here.",
        searching ? null : this.createButton("Browse available", () => this.navigate("available"), { icon: "fi-rr-download" }),
      ));
    } else {
      const list = document.createElement("div");
      list.className = "nce-vm-list";
      for (const { packageInfo, record } of entries) list.appendChild(this.installationRow(packageInfo, record));
      fragment.appendChild(list);
    }
    this.main.replaceChildren(fragment);
  }

  packageRow(packageInfo) {
    const state = this.displayState(packageInfo);
    const row = document.createElement("div");
    row.className = "nce-vm-row nce-vm-row-static";
    const icon = document.createElement("i");
    icon.className = `fi ${packageInfo.icon || "fi-rr-database"} nce-vm-row-icon`;
    icon.setAttribute("aria-hidden", "true");
    const main = document.createElement("div");
    main.className = "nce-vm-row-main";
    const name = document.createElement("span");
    name.className = "nce-vm-row-name";
    name.textContent = packageInfo.name;
    const meta = document.createElement("span");
    meta.className = "nce-vm-row-meta";
    meta.textContent = packageInfo.description;
    main.append(name, meta);
    const version = document.createElement("span");
    version.className = "nce-vm-row-version";
    version.textContent = packageInfo.installableVersion;
    version.title = "Version NCE can install";
    row.append(icon, main, version, this.stateBadge(state));

    const actions = document.createElement("div");
    actions.className = "nce-vm-row-actions";
    const manage = this.createButton("Details", () => this.openDetail(packageInfo.id), {
      focusKey: `vm-details-${packageInfo.id}`,
    });
    actions.appendChild(manage);
    if (state === "installing" || state === "uninstalling") {
      if (state === "installing") {
        actions.appendChild(this.createButton("Cancel", () => this.cancelOperation(packageInfo.id), {
          focusKey: `vm-row-cancel-${packageInfo.id}`,
        }));
      }
    } else if (!packageInfo.supported) {
      const unavailable = this.createButton("Unavailable", () => {}, { disabled: true });
      unavailable.title = `No distribution for this platform`;
      actions.appendChild(unavailable);
    } else if ((packageInfo.installations || []).length) {
      actions.appendChild(this.createButton("Installed", () => {}, { disabled: true }));
    } else if (packageInfo.capabilities.includes("install")) {
      actions.appendChild(this.createButton("Install", () => this.install(packageInfo.id), {
        className: "nce-vm-button nce-vm-button-primary",
        icon: "fi-rr-download",
        focusKey: `vm-install-${packageInfo.id}`,
      }));
    }
    row.appendChild(actions);
    return row;
  }

  renderAvailable() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.sectionHeader("Available", "Packages NCE can really install today. More will arrive as their installers are implemented and tested."));
    const packages = this.snapshot.packages || [];
    if (!packages.length) {
      fragment.appendChild(this.emptyState("fi-rr-database", "No packages registered", "The package registry is empty."));
    } else {
      const list = document.createElement("div");
      list.className = "nce-vm-list";
      for (const packageInfo of packages) list.appendChild(this.packageRow(packageInfo));
      fragment.appendChild(list);
    }
    this.main.replaceChildren(fragment);
  }

  renderUpdates() {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.sectionHeader("Updates", ""));
    fragment.appendChild(this.emptyState(
      "fi-rr-refresh",
      "Update checking is not available yet",
      "This version of the Version Manager does not check for new releases. Verify an installed tool from its details to confirm it still works.",
    ));
    this.main.replaceChildren(fragment);
  }

  renderCategory(category) {
    const fragment = document.createDocumentFragment();
    const label = this.categoryLabel(category);
    fragment.appendChild(this.sectionHeader(label, `Managed tools in the ${label} category.`));
    const packages = (this.snapshot.packages || []).filter((entry) => entry.categories.includes(category));
    if (!packages.length) {
      fragment.appendChild(this.emptyState(
        "fi-rr-database",
        `No ${label.toLowerCase()} tools yet`,
        "NCE does not manage any tool in this category yet. It will appear here once a real installer exists.",
      ));
    } else {
      const list = document.createElement("div");
      list.className = "nce-vm-list";
      for (const packageInfo of packages) list.appendChild(this.packageRow(packageInfo));
      fragment.appendChild(list);
    }
    this.main.replaceChildren(fragment);
  }

  detailField(label, value, options = {}) {
    const row = document.createElement("div");
    row.className = "nce-vm-field";
    const term = document.createElement("span");
    term.className = "nce-vm-field-label";
    term.textContent = label;
    const definition = document.createElement("span");
    definition.className = "nce-vm-field-value";
    if (options.mono) definition.classList.add("nce-vm-mono");
    definition.textContent = value || "—";
    if (options.title) definition.title = options.title;
    row.append(term, definition);
    return row;
  }

  renderDetail() {
    const packageInfo = this.packageById(this.selectedPackageId);
    if (!packageInfo) {
      this.section = "installed";
      this.renderMain();
      return;
    }
    const state = this.displayState(packageInfo);
    const fragment = document.createDocumentFragment();

    const back = this.createButton("Back", () => this.navigate("installed"), {
      className: "nce-vm-back",
      icon: "fi-rr-caret-square-left",
      focusKey: "vm-back",
    });
    fragment.appendChild(back);

    const header = document.createElement("div");
    header.className = "nce-vm-detail-header";
    const icon = document.createElement("i");
    icon.className = `fi ${packageInfo.icon || "fi-rr-database"} nce-vm-detail-icon`;
    icon.setAttribute("aria-hidden", "true");
    const titles = document.createElement("div");
    titles.className = "nce-vm-detail-titles";
    const name = document.createElement("h3");
    name.className = "nce-vm-detail-name";
    name.textContent = packageInfo.name;
    const description = document.createElement("p");
    description.className = "nce-vm-detail-description";
    description.textContent = packageInfo.description;
    titles.append(name, description);
    header.append(icon, titles, this.stateBadge(state));
    fragment.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "nce-vm-detail-meta";
    meta.append(
      this.detailField("Publisher", packageInfo.publisher),
      this.detailField("Categories", packageInfo.categories.map((category) => this.categoryLabel(category)).join(", ")),
      this.detailField("Installable version", packageInfo.installableVersion),
      this.detailField("Homepage", packageInfo.homepage, { mono: true }),
    );
    fragment.appendChild(meta);

    if (packageInfo.lastError) {
      fragment.appendChild(this.errorPanel(packageInfo.lastError, packageInfo));
    }

    const installations = packageInfo.installations || [];
    const installationsHeading = document.createElement("h4");
    installationsHeading.className = "nce-vm-subheading";
    installationsHeading.textContent = `Installations (${installations.length})`;
    fragment.appendChild(installationsHeading);

    if (!installations.length) {
      const installAction = packageInfo.supported && packageInfo.capabilities.includes("install") && state !== "installing"
        ? this.createButton(`Install ${packageInfo.installableVersion}`, () => this.install(packageInfo.id), {
            className: "nce-vm-button nce-vm-button-primary",
            icon: "fi-rr-download",
            focusKey: `vm-install-${packageInfo.id}`,
          })
        : null;
      fragment.appendChild(this.emptyState(
        "fi-rr-database",
        state === "installing" ? "Installing…" : "Not installed",
        state === "installing"
          ? "The installation is running. Progress is shown in the status bar."
          : packageInfo.supported
            ? "NCE can install this tool into its managed tools directory."
            : "No distribution exists for this platform.",
        installAction,
      ));
    }

    for (const record of installations) {
      fragment.appendChild(this.installationDetail(packageInfo, record));
    }

    if (packageInfo.external) {
      const externalHeading = document.createElement("h4");
      externalHeading.className = "nce-vm-subheading";
      externalHeading.textContent = "External installation";
      fragment.appendChild(externalHeading);
      const panel = document.createElement("div");
      panel.className = "nce-vm-panel";
      const badgeRow = document.createElement("div");
      badgeRow.className = "nce-vm-panel-head";
      const badge = document.createElement("span");
      badge.className = "nce-vm-badge nce-vm-badge-external";
      const badgeIcon = document.createElement("i");
      badgeIcon.className = "fi fi-rr-lock";
      badgeIcon.setAttribute("aria-hidden", "true");
      const badgeLabel = document.createElement("span");
      badgeLabel.textContent = "External — not managed by NCE";
      badge.append(badgeIcon, badgeLabel);
      badgeRow.appendChild(badge);
      panel.appendChild(badgeRow);
      panel.append(
        this.detailField("Executable", packageInfo.external.executable, { mono: true, title: packageInfo.external.executable }),
        this.detailField("Version", packageInfo.external.version),
      );
      const note = document.createElement("p");
      note.className = "nce-vm-note";
      note.textContent = "Detected on this system. The Version Manager never modifies or uninstalls external tools.";
      panel.appendChild(note);
      fragment.appendChild(panel);
    }

    this.main.replaceChildren(fragment);
  }

  installationDetail(packageInfo, record) {
    const panel = document.createElement("div");
    panel.className = "nce-vm-panel";
    const head = document.createElement("div");
    head.className = "nce-vm-panel-head";
    const version = document.createElement("span");
    version.className = "nce-vm-panel-version";
    version.textContent = record.version;
    const provenance = document.createElement("span");
    provenance.className = "nce-vm-provenance";
    provenance.textContent = "Managed by NCE";
    head.append(version, this.stateBadge(record.state), provenance);
    panel.appendChild(head);

    panel.append(
      this.detailField("Location", record.installDir, { mono: true, title: record.installDir }),
      this.detailField("Executable", record.executable, { mono: true, title: record.executable }),
      this.detailField("Platform", `${record.platform} / ${record.arch}`),
      this.detailField("Installed", this.formatDate(record.installedAt)),
      this.detailField("Last verified", record.verifiedAt ? this.formatDateTime(record.verifiedAt) : "Never"),
    );
    if (record.source?.url) {
      panel.appendChild(this.detailField("Source", record.source.url, { mono: true, title: record.source.url }));
      if (record.source.checksum)
        panel.appendChild(this.detailField(`Checksum (${record.source.checksumAlgorithm || "sha256"})`, record.source.checksum, { mono: true }));
    }
    if (record.error) {
      const errorNote = document.createElement("p");
      errorNote.className = "nce-vm-error-text";
      errorNote.textContent = `${record.error.code}: ${record.error.message}`;
      panel.appendChild(errorNote);
    }

    const busy = this.activeOperation();
    const actions = document.createElement("div");
    actions.className = "nce-vm-panel-actions";
    const confirming = this.confirmation?.kind === "uninstall" && this.confirmation.installationId === record.id;
    if (confirming) {
      actions.appendChild(this.uninstallConfirmation(packageInfo, record));
    } else if (record.state === "uninstalling" || busy?.kind === "uninstall") {
      const note = document.createElement("span");
      note.className = "nce-vm-note";
      note.textContent = "Uninstalling…";
      actions.appendChild(note);
    } else {
      actions.appendChild(this.createButton("Verify", () => this.verify(record.id), {
        icon: "fi-rr-refresh",
        disabled: Boolean(busy),
        focusKey: `vm-verify-${record.id}`,
      }));
      actions.appendChild(this.createButton("Uninstall", () => this.askUninstall(record.id), {
        className: "nce-vm-button nce-vm-button-danger",
        icon: "fi-rr-trash",
        disabled: Boolean(busy),
        focusKey: `vm-uninstall-${record.id}`,
      }));
    }
    panel.appendChild(actions);
    return panel;
  }

  uninstallConfirmation(packageInfo, record) {
    const wrap = document.createElement("div");
    wrap.className = "nce-vm-confirm";
    wrap.setAttribute("role", "alertdialog");
    wrap.setAttribute("aria-label", `Confirm uninstall of ${packageInfo.name}`);
    const title = document.createElement("p");
    title.className = "nce-vm-confirm-title";
    title.textContent = `Uninstall ${packageInfo.name} ${record.version}?`;
    const consequence = document.createElement("p");
    consequence.className = "nce-vm-confirm-text";
    const parts = [`This permanently removes ${record.installDir}.`];
    if (packageInfo.managedSettings?.length) {
      parts.push(
        packageInfo.external
          ? "NCE will fall back to the external installation if one is available."
          : "Settings pointing at this installation will be cleared.",
      );
    }
    consequence.textContent = parts.join(" ");
    const buttons = document.createElement("div");
    buttons.className = "nce-vm-confirm-actions";
    buttons.append(
      this.createButton("Uninstall", () => this.confirmUninstall(record.id), {
        className: "nce-vm-button nce-vm-button-danger",
        icon: "fi-rr-trash",
        focusKey: `vm-confirm-uninstall-${record.id}`,
      }),
      this.createButton("Cancel", () => {
        this.confirmation = null;
        this.render();
      }, { focusKey: `vm-cancel-uninstall-${record.id}` }),
    );
    wrap.append(title, consequence, buttons);
    return wrap;
  }

  errorPanel(error, packageInfo) {
    const panel = document.createElement("div");
    panel.className = "nce-vm-error";
    panel.setAttribute("role", "alert");
    const icon = document.createElement("i");
    icon.className = "fi fi-rr-cross-circle";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("div");
    text.className = "nce-vm-error-body";
    const title = document.createElement("p");
    title.className = "nce-vm-error-title";
    title.textContent = `Operation failed (${error.code})`;
    const message = document.createElement("p");
    message.className = "nce-vm-error-text";
    message.textContent = error.message;
    text.append(title, message);
    panel.append(icon, text);
    if (packageInfo.capabilities.includes("install") && !(packageInfo.installations || []).length) {
      panel.appendChild(this.createButton("Retry", () => this.install(packageInfo.id), {
        icon: "fi-rr-rotate-right",
        focusKey: `vm-retry-${packageInfo.id}`,
      }));
    }
    return panel;
  }

  renderFooter() {
    if (!this.footer) return;
    const operation = this.activeOperation();
    if (this.confirmation?.kind === "close") {
      this.footerStatus.textContent = "An operation is still running. Close the Version Manager anyway?";
      this.footerProgress.hidden = true;
      this.footerCancel.hidden = true;
      this.replaceFooterActions([
        this.createButton("Close anyway", () => {
          this.confirmation = null;
          this.hide();
        }, { className: "nce-vm-button nce-vm-button-danger", focusKey: "vm-confirm-close" }),
        this.createButton("Keep open", () => {
          this.confirmation = null;
          this.renderFooter();
        }, { focusKey: "vm-keep-open" }),
      ]);
      return;
    }
    this.restoreFooterActions();
    if (this.loading) {
      this.footerStatus.textContent = "Loading inventory…";
      this.footerProgress.hidden = true;
      this.footerCancel.hidden = true;
      return;
    }
    if (this.loadError) {
      this.footerStatus.textContent = this.loadError;
      this.footerProgress.hidden = true;
      this.footerCancel.hidden = true;
      return;
    }
    if (operation) {
      const packageInfo = this.packageById(operation.packageId);
      const name = packageInfo?.name || operation.packageId;
      const label = VersionManager.OPERATION_LABELS[operation.kind] || operation.kind;
      const percent = Number.isFinite(operation.progress?.percent) ? Math.round(operation.progress.percent) : null;
      const step = operation.progress?.step ? ` · ${operation.progress.step}` : "";
      this.footerStatus.textContent = `${label} ${name}${step}`;
      this.footerProgress.hidden = false;
      this.footerProgressLabel.textContent = percent === null ? "Working…" : `${percent}%`;
      this.footerProgressFill.style.width = percent === null ? "100%" : `${percent}%`;
      this.footerProgressFill.classList.toggle("nce-vm-progress-indeterminate", percent === null);
      this.footerCancel.hidden = operation.kind !== "install";
      return;
    }
    this.footerProgress.hidden = true;
    this.footerCancel.hidden = true;
    const packages = this.snapshot?.packages || [];
    const installations = packages.flatMap((entry) => entry.installations || []);
    const attention = installations.filter((record) => record.state === "corrupted" || record.state === "unknown").length;
    this.footerStatus.textContent = attention
      ? `${installations.length} installation(s) · ${attention} needs attention`
      : `${packages.length} package(s) · ${installations.length} installation(s)`;
  }

  replaceFooterActions(buttons) {
    this.footerCancel.hidden = true;
    for (const button of buttons) this.footer.appendChild(button);
    this.footerExtraActions = buttons;
  }

  restoreFooterActions() {
    for (const button of this.footerExtraActions || []) button.remove();
    this.footerExtraActions = [];
  }

  async install(packageId) {
    if (!this.api || this.activeOperation()) return false;
    this.confirmation = null;
    const result = await this.api.install(packageId);
    if (!result?.success) this.reload();
    return Boolean(result?.success);
  }

  askUninstall(installationId) {
    this.confirmation = { kind: "uninstall", installationId };
    this.render();
    this.findByFocusKey(this.dialog, `vm-confirm-uninstall-${installationId}`)?.focus();
  }

  async confirmUninstall(installationId) {
    if (!this.api || this.activeOperation()) return false;
    this.confirmation = null;
    this.render();
    const result = await this.api.uninstall(installationId);
    if (!result?.success) this.reload();
    return Boolean(result?.success);
  }

  async verify(installationId) {
    if (!this.api || this.activeOperation()) return false;
    const result = await this.api.verify(installationId);
    this.reload();
    return Boolean(result?.success);
  }

  cancelOperation(packageId) {
    return this.api?.cancel(packageId) ?? false;
  }

  cancelActiveOperation() {
    const operation = this.activeOperation();
    if (!operation) return false;
    return this.cancelOperation(operation.packageId);
  }

  destroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.host?.remove();
    this.host = null;
    this.dialog = null;
    this.nav = null;
    this.main = null;
    this.footer = null;
    this.snapshot = null;
    this.operations.clear();
    this.previousFocus = null;
  }
}

VersionManager.NAV_GROUPS = [
  { label: null, items: [{ id: "overview", label: "Overview", icon: "fi-rr-square" }] },
  {
    label: "Library",
    items: [
      { id: "installed", label: "Installed", icon: "fi-rr-check" },
      { id: "available", label: "Available", icon: "fi-rr-download" },
      { id: "updates", label: "Updates", icon: "fi-rr-refresh" },
    ],
  },
  {
    label: "Categories",
    items: [
      { id: "category:git", label: "Git", icon: "fi-rr-code-branch", category: "git" },
      { id: "category:language", label: "Languages", icon: "fi-rr-code-simple", category: "language" },
      { id: "category:runtime", label: "Runtimes", icon: "fi-rr-terminal", category: "runtime" },
      { id: "category:compiler", label: "Compilers", icon: "fi-rr-file-code", category: "compiler" },
      { id: "category:toolchain", label: "Toolchains", icon: "fi-rr-settings-sliders", category: "toolchain" },
      { id: "category:language-server", label: "Language Servers", icon: "fi-rr-exchange", category: "language-server" },
      { id: "category:other", label: "Other", icon: "fi-rr-database", category: "other" },
    ],
  },
];

VersionManager.CATEGORY_LABELS = {
  git: "Git",
  language: "Languages",
  runtime: "Runtimes",
  compiler: "Compilers",
  toolchain: "Toolchains",
  "language-server": "Language Servers",
  other: "Other",
};

VersionManager.STATE_LABELS = {
  "not-installed": "Not installed",
  installed: "Installed",
  installing: "Installing…",
  uninstalling: "Uninstalling…",
  failed: "Failed",
  corrupted: "Corrupted",
  external: "External",
  unknown: "Unknown",
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
};

VersionManager.STATE_ICONS = {
  "not-installed": "fi-rr-minus",
  installed: "fi-rr-check",
  installing: "fi-rr-refresh",
  uninstalling: "fi-rr-refresh",
  failed: "fi-rr-cross-circle",
  corrupted: "fi-rr-triangle-warning",
  external: "fi-rr-lock",
  unknown: "fi-rr-info",
  running: "fi-rr-refresh",
  completed: "fi-rr-check",
  cancelled: "fi-rr-cross-small",
};

VersionManager.OPERATION_LABELS = {
  install: "Install",
  uninstall: "Uninstall",
  verify: "Verify",
};

VersionManager.OPERATION_ICONS = {
  install: "fi-rr-download",
  uninstall: "fi-rr-trash",
  verify: "fi-rr-refresh",
};