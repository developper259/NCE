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
    if (options.ariaExpanded !== undefined) button.setAttribute("aria-expanded", String(options.ariaExpanded));
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

  /**
   * Shared building blocks for every package detail page. They only render
   * data that already exists in the catalog or language views; they never
   * invent fields or drive install logic.
   */

  static sectionHeader(title, description) {
    const header = VersionManagerUI.element("div", "nce-vm-section-header");
    header.appendChild(VersionManagerUI.element("h4", "nce-vm-section-title", title));
    if (description) {
      header.appendChild(VersionManagerUI.element("p", "nce-vm-section-description", description));
    }
    return header;
  }

  /** Label/value line. Long values wrap; links are real anchors. */
  static informationRow(label, value, options = {}) {
    const row = VersionManagerUI.element("div", "nce-vm-info-row");
    row.appendChild(VersionManagerUI.element("span", "nce-vm-info-label", label));
    let definition;
    if (options.valueNode) {
      definition = options.valueNode;
      definition.classList?.add("nce-vm-info-value");
    } else if (options.link) {
      definition = document.createElement("a");
      definition.className = "nce-vm-info-value nce-vm-link";
      definition.setAttribute("href", value);
      definition.setAttribute("target", "_blank");
      definition.setAttribute("rel", "noopener noreferrer");
      definition.textContent = value;
    } else {
      definition = VersionManagerUI.element("span", "nce-vm-info-value", value || "—");
    }
    if (options.mono) definition.classList.add("nce-vm-mono");
    if (options.title) definition.title = options.title;
    row.appendChild(definition);
    return row;
  }

  /** Primary and secondary actions rendered in a single, discreet row. */
  static actionArea(primary = [], secondary = []) {
    const area = VersionManagerUI.element("div", "nce-vm-action-area");
    const main = VersionManagerUI.element("div", "nce-vm-actions-primary");
    for (const action of primary) main.appendChild(action);
    area.appendChild(main);
    if (secondary.length) {
      const extra = VersionManagerUI.element("div", "nce-vm-actions-secondary");
      for (const action of secondary) extra.appendChild(action);
      area.appendChild(extra);
    }
    return area;
  }

  /**
   * Compact component line used by language environments. `selectionControl`
   * is an optional checkbox supplied by the caller; the row itself stays
   * presentation-only.
   */
  static componentRow(component, options = {}) {
    const row = VersionManagerUI.element(options.selectionControl ? "label" : "div", "nce-vm-component-row");
    if (options.selectionControl) row.appendChild(options.selectionControl);

    const icon = VersionManagerUI.element("span", "nce-vm-component-icon");
    icon.appendChild(VersionManagerUI.icon(options.icon || "fi-rr-database"));
    row.appendChild(icon);

    const body = VersionManagerUI.element("div", "nce-vm-component-body");
    const title = VersionManagerUI.element("div", "nce-vm-component-heading");
    title.appendChild(VersionManagerUI.element("span", "nce-vm-component-name", component.name));
    if (component.type) {
      title.appendChild(VersionManagerUI.element(
        "span",
        "nce-vm-component-type",
        component.type.replace("-", " "),
      ));
    }
    if (options.badge) title.appendChild(options.badge);
    body.appendChild(title);
    if (component.description) {
      body.appendChild(VersionManagerUI.element("span", "nce-vm-component-desc", component.description));
    }
    if (options.meta) body.appendChild(VersionManagerUI.element("span", "nce-vm-component-meta", options.meta));
    row.appendChild(body);

    if (options.actions?.length) {
      const actions = VersionManagerUI.element("div", "nce-vm-component-actions");
      for (const action of options.actions) actions.appendChild(action);
      row.appendChild(actions);
    }
    return row;
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
}
