/** Package grids and their titled sections. */
class VersionManagerGrid {
  static render(packages, manager) {
    const grid = VersionManagerUI.element("div", "nce-vm-grid");
    for (const packageInfo of packages)
      grid.appendChild(VersionManagerPackageCard.render(packageInfo, manager));
    return grid;
  }

  static section(title, packages, manager, options = {}) {
    const section = VersionManagerUI.element("section", "nce-vm-grid-section");
    const head = VersionManagerUI.element("div", "nce-vm-group-header");
    head.append(
      VersionManagerUI.element("h3", "nce-vm-group-title", title),
      VersionManagerUI.element("span", "nce-vm-group-count", packages.length),
    );
    section.appendChild(head);
    if (packages.length) section.appendChild(VersionManagerGrid.render(packages, manager));
    else section.appendChild(VersionManagerUI.element(
      "p",
      "nce-vm-section-empty",
      options.emptyText || "No packages.",
    ));
    return section;
  }
}
