/** Small DOM helpers shared by every Version Manager view. */
class VersionManagerUI {
  static element(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  static icon(className) {
    const icon = document.createElement("i");
    icon.className = VersionManagerUI.iconClass(className);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  static iconClass(className) {
    const value = className || "fi-rr-database";
    return value.startsWith("fi ") ? value : `fi ${value}`;
  }

  static button(label, onClick, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = options.className || "nce-vm-button";
    if (options.focusKey) button.dataset.focusKey = options.focusKey;
    if (options.title) button.title = options.title;
    if (options.ariaLabel) button.setAttribute("aria-label", options.ariaLabel);
    if (options.ariaPressed !== undefined) button.setAttribute("aria-pressed", String(options.ariaPressed));
    if (options.disabled) button.disabled = true;
    if (options.icon) button.appendChild(VersionManagerUI.icon(options.icon));
    if (label) button.appendChild(VersionManagerUI.element("span", null, label));
    button.addEventListener("click", onClick);
    return button;
  }

  static badge(state) {
    const value = state || "unknown";
    const badge = VersionManagerUI.element("span", `nce-vm-badge nce-vm-badge-${value}`);
    badge.append(
      VersionManagerUI.icon(VersionManagerModel.STATE_ICONS[value] || "fi-rr-info"),
      VersionManagerUI.element("span", null, VersionManagerModel.STATE_LABELS[value] || value),
    );
    return badge;
  }

  static categoryTag(category) {
    return VersionManagerUI.element("span", "nce-vm-category-tag", VersionManagerModel.categoryLabel(category));
  }

  static formatDate(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
    return new Date(timestamp).toLocaleDateString();
  }

  static formatDateTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
    return new Date(timestamp).toLocaleString();
  }

  static emptyState(icon, title, description, action) {
    const wrap = VersionManagerUI.element("div", "nce-vm-empty");
    wrap.append(
      VersionManagerUI.icon(icon),
      VersionManagerUI.element("p", "nce-vm-empty-title", title),
    );
    if (description) wrap.appendChild(VersionManagerUI.element("p", "nce-vm-empty-description", description));
    if (action) wrap.appendChild(action);
    return wrap;
  }

  static searchField(value, onInput, options = {}) {
    const wrap = VersionManagerUI.element("div", "nce-vm-search");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "nce-vm-search-input";
    input.placeholder = options.placeholder || "Search packages";
    input.setAttribute("aria-label", options.ariaLabel || "Search packages");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.dataset.focusKey = "vm-search";
    input.value = value || "";
    input.addEventListener("input", () => onInput(input.value));
    wrap.append(VersionManagerUI.icon("fi-rr-search"), input);
    return wrap;
  }

  static sortField(value, onChange) {
    const wrap = VersionManagerUI.element("label", "nce-vm-sort");
    wrap.appendChild(VersionManagerUI.element("span", "nce-vm-sort-label", "Sort"));
    const selectWrap = VersionManagerUI.element("span", "nce-vm-sort-select-wrap");
    const select = document.createElement("select");
    select.className = "nce-vm-select";
    select.dataset.focusKey = "vm-sort";
    select.setAttribute("aria-label", "Sort packages");
    for (const sort of VersionManagerModel.SORTS) {
      const option = document.createElement("option");
      option.value = sort.id;
      option.textContent = sort.label;
      select.appendChild(option);
    }
    select.value = value || "name";
    select.addEventListener("change", () => onChange(select.value));
    selectWrap.append(select, VersionManagerUI.icon("fi-rr-angle-small-down"));
    wrap.appendChild(selectWrap);
    return wrap;
  }
}
