/**
 * Unified language detail page.
 *
 * Uses the same header, section, information-row and component-row building
 * blocks as a plain package. Components are the one structural difference of
 * an environment. Selection, planning and apply stay entirely in the manager
 * and its services; this module only renders them.
 */
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

    page.appendChild(VersionManagerLanguageDetail.header(manager, view));

    const components = VersionManagerLanguageDetail.componentsSection(manager, languageId, view);
    if (components) page.appendChild(components);

    const information = VersionManagerLanguageDetail.informationSection(manager, languageId, view);
    if (information) page.appendChild(information);

    fragment.appendChild(page);
    return fragment;
  }

  static header(manager, view) {
    const header = VersionManagerUI.element("div", "nce-vm-detail-header");

    const icon = VersionManagerUI.element("span", "nce-vm-detail-icon");
    icon.appendChild(VersionManagerUI.icon(view.icon));
    header.appendChild(icon);

    const titles = VersionManagerUI.element("div", "nce-vm-detail-titles");
    const nameRow = VersionManagerUI.element("div", "nce-vm-detail-name-row");
    nameRow.append(
      VersionManagerUI.element("h3", "nce-vm-detail-name", view.name),
      VersionManagerUI.categoryTag("language"),
      VersionManagerUI.badge(VersionManagerLanguageDetail.environmentState(view)),
    );
    titles.appendChild(nameRow);
    if (view.description) {
      titles.appendChild(VersionManagerUI.element("p", "nce-vm-detail-description", view.description));
    }
    header.appendChild(titles);

    const applyLabel = manager.languageApplying === view.id
      ? "Applying…"
      : `Apply changes${VersionManagerLanguageDetail.actionCount(view.plan) ? ` (${VersionManagerLanguageDetail.actionCount(view.plan)})` : ""}`;
    const apply = VersionManagerUI.button(applyLabel, () => manager.applyLanguageComponents(view.id), {
      className: "nce-vm-button nce-vm-button-primary",
      icon: "fi-rr-check",
      focusKey: `vm-apply-components-${view.id}`,
      disabled: manager.languageApplying === view.id || (view.plan?.blockers?.length || 0) > 0,
    });
    header.appendChild(VersionManagerUI.actionArea([apply]));
    return header;
  }

  static actionCount(plan) {
    if (!plan) return 0;
    return (plan.toInstall?.length || 0) + (plan.toUninstall?.length || 0);
  }

  /** Environment status is derived from the real component plan, never invented. */
  static environmentState(view) {
    const plan = view.plan;
    if (!plan) return "unknown";
    if ((plan.blockers?.length || 0) > 0) return "failed";
    if ((plan.toInstall?.length || 0) > 0 || (plan.toUninstall?.length || 0) > 0) return "available";
    if ((plan.unchanged?.length || 0) > 0) return "installed";
    return "not-installed";
  }

  static componentsSection(manager, languageId, view) {
    if (!view.components?.length) return null;
    const section = VersionManagerUI.element("section", "nce-vm-detail-section");
    section.appendChild(VersionManagerUI.sectionHeader(
      "Components",
      "Select the components you want. NCE compares your selection with what is installed and performs only the needed operations.",
    ));

    const selection = manager.selectionFor(languageId) || new Set(view.selected || []);
    const list = VersionManagerUI.element("div", "nce-vm-component-list");
    for (const component of view.components) {
      list.appendChild(VersionManagerLanguageDetail.componentRow(manager, languageId, component, selection, view.plan));
    }
    section.appendChild(list);
    section.appendChild(VersionManagerLanguageDetail.planSummary(view.plan));
    return section;
  }

  static componentRow(manager, languageId, component, selection, plan) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "nce-vm-component-checkbox";
    checkbox.checked = selection.has(component.id);
    checkbox.disabled = !component.supported;
    checkbox.dataset.focusKey = `vm-component-${component.id}`;
    checkbox.addEventListener("change", () => {
      manager.toggleLanguageComponent(languageId, component.id, checkbox.checked);
    });

    const metaParts = [`Version ${component.installableVersion}`];
    if (!component.supported) metaParts.push("Not available on this platform");

    // No "available" badge: the plan summary below the list already says what
    // will be installed, so a badge on every pending component was pure noise.
    // The "installed" badge stays, because it reports real state.
    let badge = null;
    if (plan) {
      if ((plan.unchanged || []).includes(component.id)) badge = VersionManagerUI.badge("installed");
      else if ((plan.toUninstall || []).includes(component.id)) badge = VersionManagerUI.badge("not-installed");
    }

    const row = VersionManagerUI.componentRow(component, {
      selectionControl: checkbox,
      badge,
      meta: metaParts.join(" · "),
    });
    return row;
  }

  static planSummary(plan) {
    const box = VersionManagerUI.element("div", "nce-vm-lang-plan");
    const parts = [];
    if (plan?.toInstall?.length) parts.push(`Install ${plan.toInstall.length}`);
    if (plan?.toUninstall?.length) parts.push(`Uninstall ${plan.toUninstall.length}`);
    if (!parts.length) parts.push("Already up to date");
    box.appendChild(VersionManagerUI.element("span", "nce-vm-lang-plan-summary", parts.join(" · ")));
    for (const blocker of plan?.blockers || []) {
      box.appendChild(VersionManagerUI.element("span", "nce-vm-lang-plan-blocker", blocker));
    }
    return box;
  }

  static informationSection(manager, languageId, view) {
    const rows = VersionManagerUI.element("div", "nce-vm-info-list");

    const packages = manager.snapshot?.packages || [];
    const byId = new Map(packages.map((info) => [info.id, info]));
    const installedCount = (view.components || []).filter((component) => {
      const info = byId.get(component.packageId);
      return info && (info.installations || []).length > 0;
    }).length;
    rows.appendChild(VersionManagerUI.informationRow(
      "Installed components",
      `${installedCount} of ${view.components.length}`,
    ));

    const versions = (view.components || [])
      .filter((component) => component.installableVersion && component.installableVersion !== "—")
      .map((component) => `${component.name}: ${component.installableVersion}`);
    if (versions.length) {
      rows.appendChild(VersionManagerUI.informationRow("Component versions", versions.join(", ")));
    }
    if (view.fileExtensions?.length) {
      rows.appendChild(VersionManagerUI.informationRow("File extensions", view.fileExtensions.join(", ")));
    }

    const section = VersionManagerUI.element("section", "nce-vm-detail-section");
    section.appendChild(VersionManagerUI.sectionHeader("Environment Information"));
    section.appendChild(rows);
    return section;
  }
}
