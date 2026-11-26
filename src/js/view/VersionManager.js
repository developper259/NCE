class VersionManager {
  constructor(editor) {
    this.editor = editor;
    this.host = null;
    this.dialog = null;
    this.headerControls = null;
    this.main = null;
    this.footer = null;
    this.footerStatus = null;
    this.footerProgress = null;
    this.footerProgressFill = null;
    this.footerProgressLabel = null;
    this.footerCancel = null;
    this.closeButton = null;
    this.previousFocus = null;
    this.state = new VersionManagerState();
    this.unsubscribe = null;
    this.hideTimer = null;
    this.reloadSequence = 0;
    this.footerExtraActions = [];
    this.applyEvents = [];
    this.onKeyDown = (event) => this.handleKeyDown(event);
  }

  get snapshot() { return this.state.snapshot; }
  set snapshot(value) { this.state.snapshot = value; }
  get loading() { return this.state.loading; }
  set loading(value) { this.state.loading = value; }
  get loadError() { return this.state.loadError; }
  set loadError(value) { this.state.loadError = value; }
  get filter() { return this.state.filter; }
  get searchQuery() { return this.state.searchQuery; }
  get selectedPackageId() { return this.state.selectedPackageId; }
  get operations() { return this.state.operations; }
  get confirmation() { return this.state.confirmation; }
  set confirmation(value) { this.state.confirmation = value; }
  get languages() { return this.state.languages; }
  get languageViews() { return this.state.languageViews; }
  get languageApplying() { return this.state.languageApplying; }
  set languageApplying(value) { this.state.languageApplying = value; }
  selectionFor(languageId) { return this.state.selectionFor(languageId); }
  /** Recent component-operation events for a language, newest last. */
  applyEventsFor(languageId) {
    const view = this.state.languageViews.get(languageId);
    if (!view) return [];
    const ids = new Set((view.components || []).map((component) => component.id));
    // Events with no component id describe the whole operation (for example a
    // rejected apply because another plan is running). They concern every
    // language panel, so do not filter them out.
    return this.applyEvents.filter((event) => !event.componentId || ids.has(event.componentId));
  }
  toggleLanguageComponent(languageId, componentId, checked) {
    this.state.toggleComponent(languageId, componentId, checked);
    this.refreshLanguageView(languageId);
  }

  // Claimed from the root capture-phase keydown route before KeyBindingManager,
  // which stops propagation of every key while the editor has a selection.
  handleKeyDown(event) {
    if (!this.host || this.host.hidden) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.requestClose();
      return true;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      this.trapFocus(event);
      return true;
    }
    return false;
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
    const headerTop = document.createElement("div");
    headerTop.className = "nce-vm-header-top";
    const headerIcon = document.createElement("i");
    headerIcon.className = "fi fi-rr-database nce-vm-header-icon";
    headerIcon.setAttribute("aria-hidden", "true");
    const title = document.createElement("h2");
    title.id = "nce-vm-title";
    title.className = "nce-vm-title";
    title.textContent = "Version Manager";
    const subtitle = document.createElement("span");
    subtitle.className = "nce-vm-subtitle";
    subtitle.textContent = "Install and manage the tools NCE uses";
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
    headerTop.append(headerIcon, title, subtitle, closeButton);

    const headerControls = document.createElement("div");
    headerControls.className = "nce-vm-header-controls";
    header.append(headerTop, headerControls);

    const body = document.createElement("div");
    body.className = "nce-vm-body";
    const main = document.createElement("div");
    main.className = "nce-vm-main";
    main.setAttribute("aria-live", "polite");
    body.appendChild(main);

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
    const footerCancel = VersionManagerUI.button("Cancel", () => this.cancelActiveOperation(), {
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
    this.headerControls = headerControls;
    this.main = main;
    this.footer = footer;
    this.footerStatus = footerStatus;
    this.footerProgress = footerProgress;
    this.footerProgressFill = footerProgressFill;
    this.footerProgressLabel = footerProgressLabel;
    this.footerCancel = footerCancel;
    this.closeButton = closeButton;
    this.renderHeaderControls();
    return true;
  }

  createButton(label, onClick, options = {}) {
    return VersionManagerUI.button(label, onClick, options);
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
    // The native window controls sit above the web contents, so the scrim
    // cannot reach them; the main process dims them to match. This goes through
    // the root preload API: `this.api` is the versionManager sub-API and has no
    // setModalScrim, so calling it there was silently dropped.
    this.editor.api?.setModalScrim?.("version-manager", true);
    setTimeout(() => this.host?.classList.add("nce-vm-open"), 0);
    this.subscribe();
    this.reload(true);
    this.closeButton?.focus();
    return true;
  }

  hide() {
    if (!this.host || this.host.hidden) return false;
    // A reload still in flight must not render (and reclaim focus) mid-close.
    this.reloadSequence++;
    this.host.classList.remove("nce-vm-open");
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.confirmation = null;
    this.state.clearSelection();
    const finish = () => {
      this.hideTimer = null;
      if (!this.host) return;
      this.host.hidden = true;
      this.host.setAttribute("aria-hidden", "true");
      this.editor.api?.setModalScrim?.("version-manager", false);
      // Another surface (quick panel, tab, sidebar) may already own focus.
      const active = document.activeElement;
      const focusStillOurs = active === document.body || this.dialog?.contains?.(active);
      if (focusStillOurs && this.previousFocus?.isConnected && typeof this.previousFocus.focus === "function")
        this.previousFocus.focus();
      this.previousFocus = null;
    };
    this.hideTimer = setTimeout(finish, 160);
    return true;
  }

  requestClose() {
    // Closing the popup never stops an install: the operation lives in the
    // main process and keeps running in the background. No confirmation is
    // needed, so Escape and the close button always dismiss immediately.
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
      const started = operation.state === "running" && previous?.state !== "running";
      const finished = operation.state !== "running";
      this.state.recordOperation(operation);
      this.renderFooter();
      if (started || finished) this.reload();
      return;
    }
    if (event.type === "inventory-changed") this.reload();
    if (event.type === "component-operation") {
      // Component operations were broadcast by the main process but never
      // handled here, so the language panel showed nothing while a plan ran and
      // a dependency could start downloading unannounced.
      this.applyEvents.push(event);
      if (this.applyEvents.length > 50) this.applyEvents.shift();
      this.renderMain();
    }
  }

  async reload(rescan = false) {
    if (!this.api) {
      this.loadError = "The Version Manager API is unavailable.";
      this.loading = false;
      this.render();
      return;
    }
    // IPC responses can resolve out of order; only the latest request may apply.
    const sequence = ++this.reloadSequence;
    this.loading = !this.snapshot;
    this.render();
    try {
      const snapshot = rescan && typeof this.api.refresh === "function"
        ? await this.api.refresh()
        : await this.api.getState();
      if (sequence !== this.reloadSequence) return;
      this.snapshot = snapshot;
      this.loadError = null;
      await this.loadLanguages(sequence);
    } catch (error) {
      if (sequence !== this.reloadSequence) return;
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    this.loading = false;
    this.render();
  }

  async loadLanguages(sequence) {
    if (typeof this.api?.languages !== "function") return;
    try {
      const languages = await this.api.languages();
      if (sequence !== this.reloadSequence) return;
      this.state.languages = Array.isArray(languages) ? languages : [];
      for (const language of this.state.languages) {
        await this.refreshLanguageView(language.id, sequence);
      }
    } catch {
      // Language metadata is optional; the package catalog stays usable.
      this.state.languages = [];
    }
  }

  async refreshLanguageView(languageId, sequence = this.reloadSequence) {
    if (typeof this.api?.languageView !== "function") return;
    const selected = this.state.selectionFor(languageId);
    try {
      const view = await this.api.languageView(languageId, selected ? [...selected] : undefined);
      if (sequence !== this.reloadSequence || !view) return;
      this.state.languageViews.set(languageId, view);
      if (!selected) this.state.setSelection(languageId, view.selected || []);
      if (this.state.selectedPackageId &&
          this.languageForPackage(this.state.selectedPackageId) === languageId) {
        this.renderMain();
      }
    } catch {
      // A single language view failing must not break the whole manager.
    }
  }

  languageForPackage(packageId) {
    const owns = (language) => {
      const view = this.languageViews.get(language.id);
      const components = language.components || view?.components || [];
      return components.some((component) => component.packageId === packageId);
    };
    // Shared packages (node, typescript, typescript-language-server) belong to
    // several languages. An exact id match must win: the TypeScript card opens
    // TypeScript, while the Node.js card still opens JavaScript.
    const exact = this.state.languages.find((language) => language.id === packageId && owns(language));
    if (exact) return exact.id;
    for (const language of this.state.languages) {
      if (!this.languageViews.has(language.id)) continue;
      const view = this.state.languageViews.get(language.id);
      if ((view.components || []).some((component) => component.packageId === packageId))
        return language.id;
    }
    return null;
  }

  /**
   * Install every component recommended for a language in one grouped apply.
   * The selection is reset to the view's defaults so a half-configured
   * selection can never produce a partial environment.
   */
  async installFullLanguage(languageId) {
    const view = this.languageViews.get(languageId);
    if (!view) return;
    const defaults = (view.components || [])
      .filter((component) => component.defaultSelected !== false && component.supported !== false)
      .map((component) => component.id);
    this.state.setSelection(languageId, defaults);
    return this.applyLanguageComponents(languageId);
  }

  /** Ask before removing a whole language environment. */
  askUninstallLanguage(languageId) {
    this.confirmation = { kind: "uninstall-language", languageId };
    this.renderMain();
    this.focusByKey(`vm-confirm-uninstall-language-${languageId}`);
  }

  /**
   * Remove every installed component of the language through the existing
   * grouped apply path. Dependencies still used by another language are kept
   * by the planner, so this never breaks a neighbouring environment.
   */
  async confirmUninstallLanguage(languageId) {
    this.confirmation = null;
    if (this.languageApplying || typeof this.api?.applyComponents !== "function") return;
    this.state.setSelection(languageId, []);
    await this.applyLanguageComponents(languageId);
  }

  async applyLanguageComponents(languageId) {
    if (this.languageApplying || typeof this.api?.applyComponents !== "function") return;
    // The selection must belong to the language being applied. A view that has
    // not loaded yet has no selection entry, and falling back to whatever was
    // stored for another language would apply the wrong plan: installing
    // JavaScript components while the user was looking at Python.
    const selected = this.state.selectionFor(languageId);
    // An empty set is a valid selection: it is how a whole environment is
    // uninstalled. Only a missing entry means the view has not loaded yet.
    if (!selected) {
      this.state.confirmation = {
        message: "This language is still loading. Try again in a moment.",
      };
      this.renderMain();
      return;
    }
    this.languageApplying = languageId;
    this.renderMain();
    try {
      await this.api.applyComponents(languageId, [...selected]);
    } finally {
      this.languageApplying = null;
      await this.reload(true);
    }
  }

  activeOperation() {
    for (const operation of this.operations.values())
      if (operation.state === "running") return operation;
    return this.snapshot?.operations?.find((operation) => operation.state === "running") || null;
  }

  packageById(packageId) {
    return this.snapshot?.packages?.find((entry) => entry.id === packageId) || null;
  }

  openDetail(packageId) {
    // A language entry has no package of its own: its id is a language id, and
    // the detail page is resolved from the language views instead.
    const isLanguage = this.languageViews.has(packageId);
    if (!isLanguage && !this.packageById(packageId)) return;
    this.state.selectPackage(packageId);
    this.renderMain();
    this.focusByKey("vm-back");
  }

  closeDetail() {
    const packageId = this.state.selectedPackageId;
    this.state.clearSelection();
    this.renderMain();
    if (packageId) this.focusByKey(`vm-details-${packageId}`);
  }

  isSectionCollapsed(sectionId) {
    return this.state.isSectionCollapsed(sectionId);
  }

  toggleSection(sectionId) {
    this.state.toggleSection(sectionId);
    this.renderMain();
    this.focusByKey(`vm-collapse-${sectionId}`);
  }

  setFilter(filterId) {
    this.state.setFilter(filterId);
    this.renderHeaderControls();
    this.renderMain();
    this.focusByKey(`vm-filter-${filterId}`);
  }

  setSearchQuery(query) {
    this.state.setSearchQuery(query);
    this.renderMain();
  }

  clearFilters() {
    this.state.clearFilters();
    this.renderHeaderControls();
    this.renderMain();
    this.focusByKey("vm-filter-all");
  }

  focusByKey(key) {
    this.findByFocusKey(this.dialog, key)?.focus();
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
      if ((tag === "button" || tag === "input" || tag === "select" || tag === "textarea") && !node.disabled)
        elements.push(node);
      if (tag === "a" && node.getAttribute("href")) elements.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(this.dialog);
    return elements;
  }

  render() {
    if (!this.host) return;
    const focusKey = document.activeElement?.dataset?.focusKey || null;
    this.renderMain();
    this.renderFooter();
    if (focusKey) {
      const target = this.findByFocusKey(this.dialog, focusKey);
      target?.focus();
    }
    if (!this.host.hidden && !this.dialog.contains(document.activeElement))
      this.closeButton?.focus();
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

  renderHeaderControls() {
    VersionManagerHeader.render(this);
  }

  renderMain() {
    if (!this.main) return;
    // The package detail is a self-contained page: search and filters only
    // describe the catalog, so they leave the chrome while it is open.
    if (this.headerControls)
      this.headerControls.hidden = Boolean(this.state.selectedPackageId);
    if (this.loading) {
      this.main.replaceChildren(VersionManagerUI.emptyState("fi-rr-refresh", "Loading inventory…", ""));
      return;
    }
    if (this.loadError) {
      this.main.replaceChildren(VersionManagerUI.emptyState(
        "fi-rr-cross-circle",
        "Version Manager unavailable",
        this.loadError,
      ));
      return;
    }
    if (!this.snapshot) {
      this.main.replaceChildren(VersionManagerUI.emptyState(
        "fi-rr-info",
        "No inventory yet",
        "Open the manager to load the inventory.",
      ));
      return;
    }

    if (this.state.selectedPackageId) {
      // A language entry is selected by its language id, which no package owns:
      // `languageForPackage` only matches package ids. Route it directly.
      const languageId = this.languageViews.has(this.state.selectedPackageId)
        ? this.state.selectedPackageId
        : this.languageForPackage(this.state.selectedPackageId);
      if (languageId) {
        const languageDetail = VersionManagerLanguageDetail.render(this, languageId);
        if (languageDetail) {
          this.main.replaceChildren(languageDetail);
          return;
        }
      }
      const detail = VersionManagerPackageDetail.render(this);
      if (detail) {
        this.main.replaceChildren(detail);
        return;
      }
      this.state.clearSelection();
    }
    this.main.replaceChildren(VersionManagerCatalog.render(this));
  }

  renderFooter() {
    if (!this.footer) return;
    const operation = this.activeOperation();
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
      const label = VersionManagerModel.OPERATION_LABELS[operation.kind] || operation.kind;
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
    // The footer must count what the catalog shows, language entries included.
    const summary = VersionManagerModel.summary(VersionManagerCatalog.entries(this));
    this.footerStatus.textContent = summary.attention
      ? `${summary.installed} installed · ${summary.attention} need attention`
      : `${summary.installed} installed · ${summary.available} available`;
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
    this.renderMain();
    this.focusByKey(`vm-confirm-uninstall-${installationId}`);
  }

  cancelConfirmation() {
    const installationId = this.confirmation?.installationId;
    this.confirmation = null;
    this.renderMain();
    if (installationId) this.focusByKey(`vm-uninstall-${installationId}`);
  }

  async confirmUninstall(installationId) {
    if (!this.api || this.activeOperation()) return false;
    this.confirmation = null;
    this.renderMain();
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
    if (this.host && !this.host.hidden) this.editor.api?.setModalScrim?.("version-manager", false);
    this.host?.remove();
    this.host = null;
    this.dialog = null;
    this.headerControls = null;
    this.main = null;
    this.footer = null;
    this.snapshot = null;
    this.state.clear();
    this.previousFocus = null;
  }
}
