/** Package grids and their titled, collapsible sections. */
class VersionManagerGrid {
  static render(packages, manager) {
    const grid = VersionManagerUI.element("div", "nce-vm-grid");
    for (const packageInfo of packages)
      grid.appendChild(VersionManagerPackageCard.render(packageInfo, manager));
    return grid;
  }

  static section(title, packages, manager, options = {}) {
    const sectionId = options.id || title.toLowerCase();
    const collapsed = manager.isSectionCollapsed(sectionId);
    const section = VersionManagerUI.element("section", "nce-vm-grid-section");
    if (collapsed) section.classList.add("nce-vm-grid-section-collapsed");

    const head = VersionManagerUI.element("div", "nce-vm-group-header");
    const heading = VersionManagerUI.element("h3", "nce-vm-group-heading");
    const toggle = VersionManagerUI.button("", () => manager.toggleSection(sectionId), {
      className: "nce-vm-group-toggle",
      focusKey: `vm-collapse-${sectionId}`,
      ariaExpanded: !collapsed,
      title: `${collapsed ? "Expand" : "Collapse"} ${title}`,
    });
    const chevron = VersionManagerUI.icon("fi-rr-angle-small-down");
    chevron.classList.add("nce-vm-group-chevron");
    toggle.append(
      chevron,
      VersionManagerUI.element("span", "nce-vm-group-title", title),
      VersionManagerUI.element("span", "nce-vm-group-count", packages.length),
    );
    heading.appendChild(toggle);
    head.appendChild(heading);

    const body = VersionManagerUI.element("div", "nce-vm-section-body");
    body.id = `nce-vm-section-${sectionId}`;
    body.hidden = collapsed;
    toggle.setAttribute("aria-controls", body.id);
    body.appendChild(VersionManagerGrid.render(packages, manager));

    section.append(head, body);
    return section;
  }
}
