/**
 * Header controls for the single-page catalog: global search and category
 * filters. Kept apart from the page body so the chrome stays stable while
 * results change underneath it.
 */
class VersionManagerHeader {
  static render(manager) {
    if (!manager.headerControls) return;
    manager.headerControls.replaceChildren(
      VersionManagerHeader.toolbar(manager),
      VersionManagerHeader.filters(manager),
    );
  }

  static toolbar(manager) {
    const row = VersionManagerUI.element("div", "nce-vm-toolbar-row");
    row.appendChild(
      VersionManagerUI.searchField(manager.searchQuery, (value) => manager.setSearchQuery(value), {
        placeholder: "Search packages by name or description",
        ariaLabel: "Search packages",
      }),
    );
    return row;
  }

  static filters(manager) {
    const filters = VersionManagerUI.element("div", "nce-vm-filter-bar");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filter packages by category");
    for (const filter of VersionManagerModel.FILTERS) {
      const active = manager.filter === filter.id;
      const button = VersionManagerUI.button(filter.label, () => manager.setFilter(filter.id), {
        className: "nce-vm-filter",
        focusKey: `vm-filter-${filter.id}`,
        ariaPressed: active,
      });
      if (active) button.classList.add("active");
      filters.appendChild(button);
    }
    return filters;
  }
}
