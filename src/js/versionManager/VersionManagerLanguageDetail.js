/** Language detail page: per-component checkboxes and a computed change plan. */
class VersionManagerLanguageDetail {
  static render(manager, languageId) {
    const view = manager.languageViews.get(languageId);
    if (!view) return null;
    const fragment = document.createDocumentFragment();
    const page = VersionManagerUI.element("div", "nce-vm-detail-page");

    page.appendChild(VersionManagerUI.button("Back", () => manager.closeDetail(), {
      className: "nce-vm-back",
      icon: "fi-rr-arrow-small-left",
      focusKey: "vm-back",
    }));

    const header = VersionManagerUI.element("div", "nce-vm-detail-header");
    const icon = VersionManagerUI.element("span", "nce-vm-detail-icon");
    icon.appendChild(VersionManagerUI.icon(view.icon));
    const titles = VersionManagerUI.element("div", "nce-vm-detail-titles");
    const nameRow = VersionManagerUI.element("div", "nce-vm-detail-name-row");
    nameRow.append(
      VersionManagerUI.element("h3", "nce-vm-detail-name", view.name),
      VersionManagerUI.element("span", "nce-vm-category-tag", "Language"),
    );
    titles.appendChild(nameRow);
    if (view.description) {
      titles.appendChild(VersionManagerUI.element("p", "nce-vm-detail-description", view.description));
    }
    header.append(icon, titles);
    page.appendChild(header);

    const section = VersionManagerUI.element("section", "nce-vm-lang-section");
    section.appendChild(VersionManagerUI.element("h4", "nce-vm-detail-col-title", "Components"));
    section.appendChild(VersionManagerUI.element(
      "p",
      "nce-vm-note",
      "Select the components you want. NCE compares your selection with what is installed and performs only the needed operations.",
    ));

    const selection = manager.selectionFor(languageId) || new Set(view.selected);
    const list = VersionManagerUI.element("div", "nce-vm-component-list");
    for (const component of view.components) {
      list.appendChild(VersionManagerLanguageDetail.componentRow(manager, languageId, component, selection));
    }
    section.appendChild(list);

    const plan = view.plan;
    section.appendChild(VersionManagerLanguageDetail.planSummary(plan));
    const applyLabel = manager.languageApplying === languageId
      ? "Applying…"
      : `Apply changes${plan.toInstall.length + plan.toUninstall.length ? ` (${plan.toInstall.length + plan.toUninstall.length})` : ""}`;
    section.appendChild(VersionManagerUI.button(applyLabel, () => manager.applyLanguageComponents(languageId), {
      className: "nce-vm-button nce-vm-button-primary nce-vm-lang-apply",
      icon: "fi-rr-check",
      focusKey: `vm-apply-components-${languageId}`,
      disabled: manager.languageApplying === languageId || plan.blockers.length > 0,
    }));
    page.appendChild(section);
    fragment.appendChild(page);
    return fragment;
  }

  static componentRow(manager, languageId, component, selection) {
    const row = VersionManagerUI.element("label", "nce-vm-component");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "nce-vm-component-checkbox";
    checkbox.checked = selection.has(component.id);
    checkbox.disabled = !component.supported;
    checkbox.dataset.focusKey = `vm-component-${component.id}`;
    checkbox.addEventListener("change", () => {
      manager.toggleLanguageComponent(languageId, component.id, checkbox.checked);
    });

    const body = VersionManagerUI.element("span", "nce-vm-component-body");
    const title = VersionManagerUI.element("span", "nce-vm-component-title", component.name);
    title.appendChild(VersionManagerUI.element("span", "nce-vm-component-type", component.type.replace("-", " ")));
    body.appendChild(title);
    body.appendChild(VersionManagerUI.element("span", "nce-vm-component-desc", component.description));
    const metaParts = [`Version ${component.installableVersion}`];
    if (!component.supported) metaParts.push("Not available on this platform");
    body.appendChild(VersionManagerUI.element("span", "nce-vm-component-meta", metaParts.join(" · ")));

    row.append(checkbox, body);
    return row;
  }

  static planSummary(plan) {
    const box = VersionManagerUI.element("div", "nce-vm-lang-plan");
    const parts = [];
    if (plan.toInstall.length) parts.push(`Install ${plan.toInstall.length}`);
    if (plan.toUninstall.length) parts.push(`Uninstall ${plan.toUninstall.length}`);
    if (!parts.length) parts.push("Already up to date");
    box.appendChild(VersionManagerUI.element(
      "span",
      "nce-vm-lang-plan-summary",
      parts.join(" · "),
    ));
    for (const blocker of plan.blockers) {
      box.appendChild(VersionManagerUI.element("span", "nce-vm-lang-plan-blocker", blocker));
    }
    return box;
  }
}
