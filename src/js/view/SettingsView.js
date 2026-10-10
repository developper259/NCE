const SETTINGS_UI = Object.freeze([
  {
    key: "appearance.theme",
    category: "Editor",
    label: "Theme",
    description: "Controls the color theme used by NCE.",
    keywords: ["theme", "color", "appearance"],
    control: "select",
    valueType: "string",
    options: [
      { value: "system", label: "System" },
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ],
    apply: (editor, value) => editor.themeManager.setTheme(value),
  },
  {
    key: "editor.tabWidth",
    category: "Editor",
    label: "Tab Width",
    description: "Number of spaces used for indentation.",
    keywords: ["tab", "indent", "spaces"],
    control: "select",
    options: [2, 4, 8],
  },
  {
    key: "files.autoSave",
    category: "Files",
    label: "Auto Save",
    description: "Automatically save modified files.",
    keywords: ["auto", "save", "files"],
    control: "checkbox",
    apply: (editor, enabled) => {
      editor.setAutoSaveState(enabled);
      return true;
    },
  },
  {
    key: "files.confirmMoveToTrash",
    category: "Files",
    label: "Confirm Move to Trash",
    description: "Ask before moving files or folders to the Trash.",
    keywords: ["confirm", "trash", "files", "folders", "deletion"],
    control: "checkbox",
  },
  {
    key: "files.confirmPermanentDelete",
    category: "Files",
    label: "Confirm Permanent Deletion",
    description: "Ask before permanently deleting files or folders.",
    keywords: ["confirm", "delete", "folder", "permanent", "irreversible"],
    control: "checkbox",
  },
  {
    key: "files.openRecentIn",
    category: "Files",
    label: "Open Recent Folders In",
    description: "Choose whether a recent folder opens in the current window or a new window.",
    keywords: ["recent", "folder", "workspace", "window", "open"],
    control: "select",
    valueType: "string",
    options: [
      { value: "current-window", label: "Current Window" },
      { value: "new-window", label: "New Window" },
    ],
  },
  {
    key: "agent.settings",
    category: "Agent",
    label: "Agent",
    description: "Configure visible models and provider API keys.",
    keywords: ["agent", "model", "AI", "provider", "API", "key"],
    control: "agent",
  },
  {
    key: "terminal.shell",
    category: "Terminal",
    label: "Shell",
    description: "Executable used for new terminal sessions. Leave empty to use the system default.",
    keywords: ["shell", "terminal", "powershell", "zsh", "bash", "cmd"],
    control: "text",
  },
]);

const SETTINGS_CATEGORY_META = Object.freeze({
  Editor: { description: "Configure editor appearance and behavior." },
  Files: { description: "Configure file and save behavior." },
  Shortcuts: { description: "Configure keyboard shortcuts." },
  Agent: { description: "Configure AI models and providers." },
  Terminal: { description: "Configure the integrated system terminal." },
});

class SettingsView {
  constructor(editor) {
    this.editor = editor;
    this.host = editor.domManager.getElement(".settings-view-host");
    this.category = SETTINGS_GET("ui.settingsCategory") || SETTINGS_UI[0].category;
    this.query = "";
    this.agentSettingsTab = "models";
    this.scroller = null;
    this.scrollSaveTimer = null;
    this.scrollRestored = false;
    this.onContentScroll = () => this.scheduleScrollSave();
    this.openSettingSelect = null;
    this.settingSelectPositionListener = null;
    this.onSettingSelectOutsidePointerDown = (event) => {
      if (
        this.openSettingSelect &&
        !this.openSettingSelect.contains(event.target)
      ) {
        this.closeSettingSelect(this.openSettingSelect);
      }
    };
    document.addEventListener(
      "pointerdown",
      this.onSettingSelectOutsidePointerDown,
    );
    this.build();
  }

  build() {
    if (!this.host) return;
    this.host.innerHTML = `
      <div class="settings-layout">
        <aside class="settings-sidebar">
          <div class="settings-search-wrap">
            <i class="fi fi-rr-search" aria-hidden="true"></i>
            <input class="settings-search" type="search" placeholder="Search settings..."
              aria-label="Search settings" autocomplete="off" spellcheck="false">
          </div>
          <nav class="settings-nav" aria-label="Settings categories"></nav>
        </aside>
        <main class="settings-main">
          <div class="settings-content"></div>
        </main>
      </div>`;
    this.search = this.host.querySelector(".settings-search");
    this.layout = this.host.querySelector(".settings-layout");
    this.nav = this.host.querySelector(".settings-nav");
    this.content = this.host.querySelector(".settings-content");
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.renderNavigation();
    this.render();
    this.content.addEventListener("scroll", this.onContentScroll, {
      passive: true,
    });
  }

  initScroller() {
    if (
      this.scroller ||
      !this.editor.scrollerManager ||
      !this.layout ||
      !this.content
    ) {
      return;
    }

    this.scroller = new SettingsScroller(
      this.editor,
      this.layout,
      this.content,
    );
    this.scroller.init();
  }

  refreshScroller() {
    if (!this.scroller || this.host?.hidden || this.scroller.suspended) return;
    this.scroller.refresh();
  }

  destroy() {
    this.closeSettingSelect();
    document.removeEventListener(
      "pointerdown",
      this.onSettingSelectOutsidePointerDown,
    );
    clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = null;
    this.content?.removeEventListener("scroll", this.onContentScroll);
    this.scroller?.destroy();
    this.scroller = null;
    this.host?.replaceChildren();
    this.search = null;
    this.layout = null;
    this.nav = null;
    this.content = null;
  }

  restoreScrollTop() {
    const scrollTop = SETTINGS_GET("ui.settingsScrollTop") || 0;
    const category = this.category;
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 0);
    schedule(() => {
      if (!this.content || this.category !== category) return;
      const maxScrollTop = Math.max(
        0,
        this.content.scrollHeight - this.content.clientHeight,
      );
      this.content.scrollTop = Math.min(scrollTop, maxScrollTop);
      this.refreshScroller();
    });
  }

  scheduleScrollSave() {
    clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = setTimeout(() => {
      this.scrollSaveTimer = null;
      this.saveScrollTop();
    }, 200);
  }

  saveScrollTop() {
    clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = null;
    if (this.content) {
      const scrollTop = Math.max(
        0,
        Math.min(Math.round(this.content.scrollTop), 1_000_000),
      );
      SETTINGS_SET(
        "ui.settingsScrollTop",
        scrollTop,
      );
    }
  }

  static getSettings() {
    const shortcuts =
      typeof USERCONFIG_KEYBINDING === "undefined"
        ? []
        : USERCONFIG_KEYBINDING.filter(
            (binding) => binding.description || binding.label,
          ).map(
            (binding) => ({
              key: `keybindings.${binding.action}`,
              category: "Shortcuts",
              label: binding.description || binding.label,
              description: `Keyboard shortcut for ${(binding.description || binding.label).toLowerCase()}.`,
              keywords: [binding.action, "shortcut", "keybinding"],
              control: "shortcut",
            }),
          );
    return [...SETTINGS_UI, ...shortcuts];
  }

  getSettings() {
    return SettingsView.getSettings();
  }

  renderNavigation() {
    const categories = [
      ...new Set(this.getSettings().map((setting) => setting.category)),
    ];
    this.nav.replaceChildren(
      ...categories.map((category) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-nav-item";
        button.textContent = category;
        button.dataset.category = category;
        button.addEventListener("click", () => {
          this.openCategory(category);
        });
        if (category === this.category) button.classList.add("active");
        return button;
      }),
    );
  }

  openCategory(category) {
    const available = new Set(this.getSettings().map((setting) => setting.category));
    if (!available.has(category)) return false;
    this.category = category;
    SETTINGS_SET("ui.settingsCategory", category);
    this.query = "";
    if (this.search) this.search.value = "";
    this.renderNavigation();
    this.render();
    this.saveScrollTop();
    return true;
  }

  getVisibleSettings() {
    const settings = this.getSettings();
    if (!this.query)
      return settings.filter((item) => item.category === this.category);
    return settings.filter((item) =>
      [item.label, item.description, item.category, ...(item.keywords || [])]
        .join(" ")
        .toLowerCase()
        .includes(this.query),
    );
  }

  render({ preserveScroll = false } = {}) {
    if (!this.content) return;
    this.closeSettingSelect();
    const previousScrollTop = preserveScroll ? this.content.scrollTop : 0;
    this.content.scrollTop = 0;
    const settings = this.getVisibleSettings();
    this.content.replaceChildren();
    if (!settings.length) {
      const empty = document.createElement("p");
      empty.className = "settings-empty";
      empty.textContent = "No settings found.";
      this.content.appendChild(empty);
      if (preserveScroll) this.content.scrollTop = previousScrollTop;
      this.refreshScroller();
      return;
    }
    const categories = [...new Set(settings.map((item) => item.category))];
    for (const category of categories) {
      const section = document.createElement("section");
      section.className = "settings-page";
      section.appendChild(this.createPageHeader(category));

      const categorySettings = settings.filter(
        (item) => item.category === category,
      );
      if (category === "Agent") {
        section.appendChild(this.createAgentSettings());
      } else {
        const panel = document.createElement("div");
        panel.className = "settings-panel";
        for (const setting of categorySettings) {
          panel.appendChild(this.createRow(setting));
        }
        section.appendChild(panel);
      }
      this.content.appendChild(section);
    }
    if (preserveScroll) this.content.scrollTop = previousScrollTop;
    this.refreshScroller();
  }

  createPageHeader(category) {
    const header = document.createElement("header");
    header.className = "settings-page-header";
    const title = document.createElement("h1");
    title.className = "settings-page-title";
    title.textContent = category;
    const description = document.createElement("p");
    description.className = "settings-page-description";
    description.textContent =
      SETTINGS_CATEGORY_META[category]?.description ||
      `Configure ${category.toLowerCase()} settings.`;
    header.append(title, description);
    return header;
  }

  createRow(setting) {
    if (setting.control === "agent") return this.createAgentSettings();
    const row = document.createElement("div");
    row.className = "settings-panel-row setting-row";
    const text = document.createElement("div");
    text.className = "settings-row-main";
    const label = document.createElement("label");
    const controlId = `setting-${setting.key.replace(/\./g, "-")}`;
    label.className = "setting-label";
    label.htmlFor = setting.control === "select" ? `${controlId}-trigger` : controlId;
    if (setting.control === "select") label.id = `${controlId}-label`;
    label.textContent = setting.label;
    const description = document.createElement("p");
    description.className = "setting-description";
    description.id = `${controlId}-description`;
    description.textContent = setting.description;
    text.append(label, description);
    const control =
      setting.control === "select"
        ? this.createSelect(setting, controlId)
        : setting.control === "checkbox"
          ? this.createCheckbox(setting, controlId)
          : setting.control === "shortcut"
            ? this.createShortcutInput(setting, controlId)
            : this.createTextInput(setting, controlId);
    const controlWrap = document.createElement("div");
    controlWrap.className = "settings-row-control";
    controlWrap.appendChild(control);
    row.append(text, controlWrap);
    return row;
  }

  createAgentSettings() {
    const container = document.createElement("div");
    container.className = "agent-settings-content";
    const tabs = document.createElement("div");
    tabs.className = "agent-settings-tabs";
    tabs.setAttribute("role", "tablist");
    for (const [id, label] of [["models", "Models"], ["providers", "Providers"]]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "agent-settings-tab";
      tab.textContent = label;
      tab.id = `agent-settings-tab-${id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(this.agentSettingsTab === id));
      tab.tabIndex = this.agentSettingsTab === id ? 0 : -1;
      tab.addEventListener("click", () => {
        this.agentSettingsTab = id;
        this.render();
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        this.agentSettingsTab = id === "models" ? "providers" : "models";
        this.render();
        this.content?.querySelector(`#agent-settings-tab-${this.agentSettingsTab}`)?.focus();
      });
      tabs.appendChild(tab);
    }
    container.appendChild(tabs);

    const panel = document.createElement("div");
    panel.className = "agent-settings-panel";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `agent-settings-tab-${this.agentSettingsTab}`);
    panel.appendChild(
      this.agentSettingsTab === "models"
        ? this.createAgentModelsView()
        : this.createAgentProvidersView(),
    );
    container.appendChild(panel);
    return container;
  }

  createAgentModelsView() {
    const container = document.createElement("div");

    const hiddenModels = new Set(SETTINGS_GET("agent.hiddenModels") || []);
    for (const provider of AgentProviderCatalog.getProviders()) {
      const models = Object.values(provider.models || {});
      if (!models.length) continue;
      const group = document.createElement("section");
      group.className = "agent-model-group";
      const groupHeader = document.createElement("div");
      groupHeader.className = "agent-model-group-header";
      const heading = document.createElement("h2");
      heading.className = "agent-model-group-title";
      heading.textContent = provider.name;
      groupHeader.appendChild(heading);
      group.appendChild(groupHeader);
      const panel = document.createElement("div");
      panel.className = "settings-panel";
      for (const model of models) {
        const key = AgentProviderCatalog.getModelKey(provider.id, model.id);
        const row = document.createElement("div");
        row.className = "settings-panel-row agent-model-setting";
        const text = document.createElement("span");
        text.className = "settings-row-label";
        text.textContent = model.name;
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !hiddenModels.has(key);
        input.setAttribute("aria-label", `${model.name} (${provider.name})`);
        const toggle = document.createElement("label");
        toggle.className = "setting-toggle";
        const track = document.createElement("span");
        track.setAttribute("aria-hidden", "true");
        toggle.append(input, track);
        input.addEventListener("change", async () => {
          const previous = new Set(SETTINGS_GET("agent.hiddenModels") || []);
          const next = new Set(previous);
          if (input.checked) next.delete(key);
          else next.add(key);
          const saved = await SETTINGS_SET("agent.hiddenModels", [...next]);
          if (!saved) input.checked = !input.checked;
          else this.editor.agentSidebar?.refreshModelSelector?.();
        });
        row.append(text, toggle);
        panel.appendChild(row);
      }
      group.appendChild(panel);
      container.appendChild(group);
    }
    return container;
  }

  createAgentProvidersView() {
    const container = document.createElement("div");

    const panel = document.createElement("div");
    panel.className = "settings-panel agent-providers-panel";
    for (const provider of AgentProviderCatalog.getProviders()) {
      panel.appendChild(this.createAgentProviderControl(provider));
    }
    container.appendChild(panel);

    const security = document.createElement("p");
    security.className = "agent-settings-security";
    security.textContent = "API keys are stored securely using your system keychain and are never saved in settings.json.";
    container.appendChild(security);
    return container;
  }

  createAgentProviderControl(provider) {
    const container = document.createElement("section");
    container.className = "settings-panel-row agent-provider-setting";
    const details = document.createElement("div");
    details.className = "settings-row-main";
    const title = document.createElement("h4");
    title.textContent = provider.name;
    details.appendChild(title);
    container.appendChild(details);
    if (!provider.requiresApiKey) {
      const status = document.createElement("p");
      status.className = "agent-provider-status agent-provider-inline-status";
      status.textContent = "No API key required.";
      container.appendChild(status);
      return container;
    }
    const status = document.createElement("p");
    status.className = "agent-provider-status";
    const updateStatus = (configured, message = "") => {
      status.textContent = message || (configured ? "Configured" : "Not configured");
      status.dataset.configured = String(configured);
    };
    details.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "agent-provider-key-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Set API key";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove API key";
    remove.className = "agent-provider-remove";
    const error = document.createElement("p");
    error.className = "agent-provider-error";
    error.hidden = true;
    const refreshStatus = async () => {
      const configured = await this.editor.api.hasAgentApiKey?.(provider.id);
      updateStatus(configured === true);
      save.textContent = configured ? "Manage API key" : "Set API key";
      remove.hidden = !configured;
    };
    save.addEventListener("click", async () => {
      save.disabled = true;
      error.textContent = "";
      error.hidden = true;
      const value = await this.editor.requestAgentApiKey(provider);
      if (!value) {
        save.disabled = false;
        return;
      }
      const saved = await this.editor.api.setAgentApiKey?.(provider.id, value);
      if (saved) {
        updateStatus(true);
        remove.hidden = false;
        save.textContent = "Manage API key";
        await this.editor.agentSidebar?.refreshProviderApiKey?.(provider.id);
      } else {
        error.textContent = "Could not save API key.";
        error.hidden = false;
      }
      save.disabled = false;
    });
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      error.textContent = "";
      error.hidden = true;
      const removed = await this.editor.api.setAgentApiKey?.(provider.id, "");
      if (removed) {
        updateStatus(false);
        remove.hidden = true;
        save.textContent = "Set API key";
        await this.editor.agentSidebar?.refreshProviderApiKey?.(provider.id);
      } else {
        error.textContent = "Could not remove API key.";
        error.hidden = false;
      }
      remove.disabled = false;
    });
    actions.append(save, remove);
    container.append(actions, error);
    remove.hidden = true;
    refreshStatus().catch(() => updateStatus(false, "Not configured"));
    return container;
  }

  createSelect(setting, id) {
    const wrapper = document.createElement("div");
    wrapper.className = "setting-select-wrap";

    const select = document.createElement("select");
    select.id = id;
    select.className = "setting-select-source";
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    for (const optionValue of setting.options) {
      const option = document.createElement("option");
      const value = typeof optionValue === "object" ? optionValue.value : optionValue;
      option.value = String(value);
      option.textContent = typeof optionValue === "object" ? optionValue.label : String(value);
      select.appendChild(option);
    }
    select.value = String(SETTINGS_GET(setting.key));

    const trigger = document.createElement("button");
    trigger.id = `${id}-trigger`;
    trigger.type = "button";
    trigger.className = "setting-select";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${id}-listbox`);
    trigger.setAttribute("aria-labelledby", `${id}-label`);
    trigger.setAttribute("aria-describedby", `${id}-description`);

    const selectedLabel = document.createElement("span");
    selectedLabel.className = "setting-select-value";
    const measurementLabel = document.createElement("span");
    measurementLabel.className = "setting-select-measure";
    measurementLabel.setAttribute("aria-hidden", "true");
    measurementLabel.textContent = [...select.options]
      .map((option) => option.textContent || "")
      .sort((first, second) => second.length - first.length)[0] || "";
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("class", "setting-select-arrow");
    arrow.setAttribute("viewBox", "0 0 12 12");
    arrow.setAttribute("aria-hidden", "true");
    const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrowPath.setAttribute("d", "m3 4.5 3 3 3-3");
    arrow.appendChild(arrowPath);
    trigger.append(selectedLabel, measurementLabel, arrow);

    const listbox = document.createElement("div");
    listbox.id = `${id}-listbox`;
    listbox.className = "setting-select-menu";
    listbox.setAttribute("role", "listbox");
    listbox.setAttribute("aria-labelledby", `${id}-label`);
    listbox.tabIndex = 0;
    listbox.hidden = true;

    const options = [];
    let activeIndex = -1;
    let typeahead = "";
    let typeaheadTimer = null;
    const setActiveOption = (index) => {
      if (!options.length) return;
      activeIndex = (index + options.length) % options.length;
      const activeOption = options[activeIndex];
      listbox.setAttribute("aria-activedescendant", activeOption.id);
      for (const [optionIndex, option] of options.entries())
        option.classList.toggle("active", optionIndex === activeIndex);
      activeOption.scrollIntoView?.({ block: "nearest" });
    };
    const openMenu = () => {
      this.openSettingSelectMenu(wrapper, select, listbox, trigger);
      const selectedIndex = [...select.options].findIndex(
        (option) => option.value === select.value,
      );
      setActiveOption(Math.max(0, selectedIndex));
    };
    const commitOption = (option) => {
      if (!option) return;
      if (select.value !== option.dataset.value) {
        select.value = option.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      this.closeSettingSelect(wrapper, true);
    };

    for (const [index, nativeOption] of [...select.options].entries()) {
      const option = document.createElement("div");
      option.id = `${id}-option-${index}`;
      option.className = "setting-select-option";
      option.setAttribute("role", "option");
      option.dataset.value = nativeOption.value;
      option.textContent = nativeOption.textContent;
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("pointermove", () => setActiveOption(index));
      option.addEventListener("click", () => commitOption(option));
      listbox.appendChild(option);
      options.push(option);
    }

    trigger.addEventListener("click", () => {
      if (this.openSettingSelect === wrapper) this.closeSettingSelect(wrapper);
      else openMenu();
    });
    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      openMenu();
      if (event.key === "ArrowUp") setActiveOption(options.length - 1);
    });
    listbox.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        setTimeout(() => this.closeSettingSelect(wrapper), 0);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSettingSelect(wrapper, true);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveOption(activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveOption(activeIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveOption(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveOption(options.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commitOption(options[activeIndex]);
      } else if (
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        typeahead += event.key.toLowerCase();
        clearTimeout(typeaheadTimer);
        typeaheadTimer = setTimeout(() => {
          typeahead = "";
        }, 700);
        const matchingIndex = options.findIndex((option) =>
          option.textContent.trim().toLowerCase().startsWith(typeahead),
        );
        if (matchingIndex >= 0) setActiveOption(matchingIndex);
      }
    });

    select.addEventListener("change", async () => {
      const previous = SETTINGS_GET(setting.key);
      const value = setting.valueType === "string" ? select.value : Number(select.value);
      this.syncSelectPresentation(select);
      const res = setting.apply
        ? await setting.apply(this.editor, value)
        : await SETTINGS_SET(setting.key, value);
      if (!res || (typeof res === "object" && !res.success)) {
        select.value = String(previous);
        this.syncSelectPresentation(select);
      }
      this.editor.bottomBar?.refreshScrollers?.();
    });

    wrapper.append(select, trigger, listbox);
    this.syncSelectPresentation(select);
    return wrapper;
  }

  syncSelectPresentation(select) {
    const wrapper = select?.closest(".setting-select-wrap");
    if (!wrapper) return;
    const selectedLabel = wrapper.querySelector(".setting-select-value");
    const listbox = wrapper.querySelector(".setting-select-menu");
    if (!selectedLabel || !listbox) return;
    const selectedOption = [...select.options].find(
      (option) => option.value === select.value,
    );
    selectedLabel.textContent = selectedOption?.textContent || "";
    for (const option of listbox.children) {
      const selected = option.dataset.value === select.value;
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("selected", selected);
    }
  }

  openSettingSelectMenu(wrapper, select, listbox, trigger) {
    if (this.openSettingSelect && this.openSettingSelect !== wrapper)
      this.closeSettingSelect(this.openSettingSelect);
    this.openSettingSelect = wrapper;
    wrapper.classList.add("open");
    listbox.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const selectedIndex = [...select.options].findIndex(
      (option) => option.value === select.value,
    );
    const activeOption = listbox.children[Math.max(0, selectedIndex)];
    if (activeOption) listbox.setAttribute("aria-activedescendant", activeOption.id);
    this.positionSettingSelectMenu(wrapper);
    this.settingSelectPositionListener = () =>
      this.positionSettingSelectMenu(wrapper);
    window.addEventListener("resize", this.settingSelectPositionListener);
    document.addEventListener("scroll", this.settingSelectPositionListener, true);
    listbox.focus({ preventScroll: true });
  }

  positionSettingSelectMenu(wrapper) {
    if (!wrapper || wrapper !== this.openSettingSelect) return;
    const trigger = wrapper.querySelector(".setting-select");
    const menu = wrapper.querySelector(".setting-select-menu");
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    menu.style.width = "max-content";
    menu.style.minWidth = `${rect.width}px`;
    menu.style.maxWidth = `calc(100vw - ${margin * 2}px)`;
    const menuWidth = menu.getBoundingClientRect().width;
    const left = Math.max(
      margin,
      Math.min(rect.left, window.innerWidth - menuWidth - margin),
    );
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - margin - 6);
    const availableAbove = Math.max(0, rect.top - margin - 6);
    const menuHeight = Math.min(220, menu.scrollHeight);
    const openAbove =
      availableBelow < Math.min(menuHeight, 100) && availableAbove > availableBelow;
    const availableAtPlacement = openAbove ? availableAbove : availableBelow;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${Math.min(220, Math.max(72, availableAtPlacement))}px`;
    menu.style.top = openAbove ? "auto" : `${rect.bottom + 6}px`;
    menu.style.bottom = openAbove
      ? `${window.innerHeight - rect.top + 6}px`
      : "auto";
  }

  closeSettingSelect(wrapper = this.openSettingSelect, restoreFocus = false) {
    if (!wrapper) return;
    const trigger = wrapper.querySelector(".setting-select");
    const menu = wrapper.querySelector(".setting-select-menu");
    if (menu) {
      menu.hidden = true;
      menu.removeAttribute("aria-activedescendant");
    }
    trigger?.setAttribute("aria-expanded", "false");
    wrapper.classList.remove("open");
    if (this.openSettingSelect === wrapper) {
      this.openSettingSelect = null;
      if (this.settingSelectPositionListener) {
        window.removeEventListener("resize", this.settingSelectPositionListener);
        document.removeEventListener(
          "scroll",
          this.settingSelectPositionListener,
          true,
        );
        this.settingSelectPositionListener = null;
      }
    }
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }

  createCheckbox(setting, id) {
    const label = document.createElement("label");
    label.className = "setting-toggle";
    label.htmlFor = id;
    const input = document.createElement("input");
    input.id = id;
    input.type = "checkbox";
    input.checked = SETTINGS_GET(setting.key) === true;
    const track = document.createElement("span");
    track.setAttribute("aria-hidden", "true");
    input.addEventListener("change", async () => {
      const requestedValue = input.checked;
      input.disabled = true;
      try {
        const result = setting.apply
          ? await setting.apply(this.editor, requestedValue)
          : await SETTINGS_SET(setting.key, requestedValue);
        const saved = result === true || result?.success === true;
        if (!saved) input.checked = SETTINGS_GET(setting.key) === true;
      } catch (error) {
        input.checked = SETTINGS_GET(setting.key) === true;
        console.error(`[Settings] Failed to update ${setting.key}`, error);
      } finally {
        input.disabled = false;
        this.editor.bottomBar?.refreshScrollers?.();
      }
    });
    label.append(input, track);
    return label;
  }

  createTextInput(setting, id) {
    const input = document.createElement("input");
    input.id = id;
    input.type = "text";
    input.className = "setting-input";
    input.value = String(SETTINGS_GET(setting.key) || "");
    input.setAttribute("aria-label", setting.label);
    if (setting.key === "terminal.shell") {
      input.placeholder = "System default";
      input.autocomplete = "off";
      input.spellcheck = false;
    }
    input.addEventListener("change", async () => {
      const previous = String(SETTINGS_GET(setting.key) || "");
      const value = input.value.trim();
      const res = await SETTINGS_SET(setting.key, value);
      if (!res || (typeof res === "object" && !res.success)) {
        input.value = previous;
      }
    });
    return input;
  }

  createShortcutInput(setting, id) {
    const container = document.createElement("div");
    container.className = "setting-shortcut-container";

    const wrapper = document.createElement("div");
    wrapper.className = "setting-shortcut-wrap";

    const display = document.createElement("button");
    display.id = id;
    display.type = "button";
    display.className = "setting-shortcut-btn";
    display.setAttribute("aria-label", `Change shortcut for ${setting.label}`);

    const currentKey = SETTINGS_GET(setting.key) || "";
    this._renderShortcutKeys(display, currentKey);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "setting-shortcut-reset";
    resetBtn.title = "Reset to default";
    resetBtn.innerHTML = '<i class="fi fi-rr-undo" aria-hidden="true"></i>';
    resetBtn.tabIndex = -1;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "setting-shortcut-delete";
    deleteBtn.title = "Delete shortcut";
    deleteBtn.setAttribute(
      "aria-label",
      `Delete shortcut for ${setting.label}`,
    );
    deleteBtn.innerHTML = '<i class="fi fi-rr-trash" aria-hidden="true"></i>';
    deleteBtn.tabIndex = -1;

    let listening = false;
    let keydownHandler = null;
    let keyupHandler = null;

    const buildCurrentParts = (e) => {
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push("Mod");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      return parts;
    };

    const renderLiveParts = (parts) => {
      display.replaceChildren();
      if (!parts.length) {
        display.textContent = "Press a key combination...";
        return;
      }
      const shortcut = document.createElement("span");
      shortcut.className = "setting-shortcut-key recording";
      shortcut.textContent = `${this._formatShortcutDisplay(parts.join("+"))} …`;
      display.appendChild(shortcut);
    };

    const startListening = () => {
      if (listening) return;
      listening = true;
      window.api.setMenuShortcutsIgnored?.(true);
      this._hideShortcutError(container);
      display.classList.add("listening");
      display.textContent = "Press a key combination...";

      keydownHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Show modifiers progressively
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
          renderLiveParts(buildCurrentParts(e));
          return;
        }

        // Final key pressed — build full combo
        const parts = buildCurrentParts(e);
        let key = CONFIG_KEYBINDING_EVENT_KEY(e);
        if (!key) {
          display.textContent = "Unsupported dead key";
          return;
        }
        if (key === " ") key = "Space";
        else if (key.length === 1) key = key.toUpperCase();
        parts.push(key);

        const combo = parts.join("+");
        stopListening();
        applyShortcut(combo);
      };

      keyupHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Update display when a modifier is released
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
          const parts = buildCurrentParts(e);
          renderLiveParts(parts);
        }
      };

      document.addEventListener("keydown", keydownHandler, true);
      document.addEventListener("keyup", keyupHandler, true);

      // Cancel on click outside
      setTimeout(() => {
        document.addEventListener("mousedown", cancelOnClickOutside, true);
      }, 0);
    };

    const cancelOnClickOutside = (e) => {
      if (!display.contains(e.target)) {
        stopListening();
      }
    };

    const stopListening = () => {
      if (!listening) return;
      listening = false;
      // Native accelerators stay disabled: KeyBindingManager is the single
      // shortcut dispatcher after capture ends as well.
      window.api.setMenuShortcutsIgnored?.(true);
      display.classList.remove("listening");
      document.removeEventListener("keydown", keydownHandler, true);
      document.removeEventListener("keyup", keyupHandler, true);
      document.removeEventListener("mousedown", cancelOnClickOutside, true);
      keydownHandler = null;
      keyupHandler = null;
      const currentVal = SETTINGS_GET(setting.key) || "";
      this._renderShortcutKeys(display, currentVal);
      this._hideShortcutError(container);
    };

    const applyShortcut = async (combo) => {
      const previous = SETTINGS_GET(setting.key) || "";
      const result = await SETTINGS_SET(setting.key, combo);

      if (result?.success === false && result?.error) {
        this._showShortcutError(container, result.error);
        this._renderShortcutKeys(display, previous);
      } else if (result?.success || result === true) {
        this._hideShortcutError(container);
        this._renderShortcutKeys(display, combo);
      } else {
        this._renderShortcutKeys(display, previous);
      }
    };

    display.addEventListener("click", (e) => {
      e.stopPropagation();
      startListening();
    });

    display.addEventListener("keydown", (e) => {
      if (!listening && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        startListening();
      }
    });

    resetBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      stopListening();
      const action = setting.key.split(".")[1];
      const defaultKey = DEFAULT_KEYBINDINGS[action];
      if (defaultKey) {
        await applyShortcut(defaultKey);
      }
    });

    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      stopListening();
      await applyShortcut(null);
    });

    wrapper.append(display, resetBtn, deleteBtn);
    container.append(wrapper);
    return container;
  }

  _renderShortcutKeys(container, keyCombo) {
    container.replaceChildren();
    const displayKey = this._formatShortcutDisplay(keyCombo);
    if (!displayKey) {
      container.textContent = "Not set";
      return;
    }
    const shortcut = document.createElement("span");
    shortcut.className = "setting-shortcut-key";
    shortcut.textContent = displayKey;
    container.appendChild(shortcut);
  }

  _formatShortcutDisplay(keyCombo) {
    const parts = CONFIG_KEYBINDING_DISPLAY(keyCombo)
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);

    if (window.api?.platform !== "darwin") return parts.join(" ");

    const macSymbols = {
      meta: "⌘",
      cmd: "⌘",
      command: "⌘",
      shift: "⇧",
      alt: "⌥",
      option: "⌥",
      ctrl: "⌃",
      control: "⌃",
    };
    return parts
      .map((part) => macSymbols[part.toLowerCase()] || part)
      .join(" ");
  }

  _showShortcutError(container, error) {
    this._hideShortcutError(container);
    const errorEl = document.createElement("div");
    errorEl.className = "setting-shortcut-error";
    const formattedShortcut = this._formatShortcutDisplay(
      error.conflictRawShortcut || error.conflictShortcut,
    );
    errorEl.textContent = `${formattedShortcut} is already assigned to ${error.conflictLabel}.`;
    container.appendChild(errorEl);
  }

  _hideShortcutError(container) {
    const errorEl = container.querySelector(".setting-shortcut-error");
    if (errorEl) errorEl.remove();
  }

  sync(key) {
    if (key === "terminal.shell") {
      const input = this.host?.querySelector("#setting-terminal-shell");
      if (input && document.activeElement !== input)
        input.value = String(SETTINGS_GET(key) || "");
      return;
    }
    const setting = this.getSettings().find((item) => item.key === key);
    if (!setting) return;
    const id = `setting-${setting.key.replace(/\./g, "-")}`;
    const input = this.host?.querySelector(`#${id}`);
    if (!input) return;
    if (setting.control === "select") {
      const wrapper = input.closest(".setting-select-wrap");
      if (!wrapper?.contains(document.activeElement))
        input.value = String(SETTINGS_GET(key));
      this.syncSelectPresentation(input);
      return;
    }
    if (setting.control !== "checkbox") return;
    input.checked = setting.key === "files.autoSave"
      ? this.editor.getAutoSaveState()
      : SETTINGS_GET(setting.key) === true;
  }

  show() {
    if (this.host) this.host.hidden = false;
    this.render({ preserveScroll: true });
    this.initScroller();
    this.scroller?.resume();
    if (!this.scrollRestored) {
      this.scrollRestored = true;
      this.restoreScrollTop();
    }
  }
  hide() {
    this.saveScrollTop();
    this.scroller?.suspend();
    if (this.host) this.host.hidden = true;
  }
}
