/**
 * The Version Manager's only page: every package NCE knows about, split into
 * Installed and Available sections. Search and filters run in the header and
 * update both sections at once.
 */
class VersionManagerCatalog {
  static render(manager) {
    const packages = manager.snapshot?.packages || [];
    const sections = VersionManagerModel.catalogSections(packages, {
      filter: manager.filter,
      query: manager.searchQuery,
    });

    const fragment = document.createDocumentFragment();
    if (!sections.installed.length && !sections.available.length) {
      fragment.appendChild(VersionManagerCatalog.emptyState(manager, packages));
      return fragment;
    }

    if (sections.installed.length) {
      fragment.appendChild(
        VersionManagerGrid.section("Installed", sections.installed, manager, { id: "installed" }),
      );
    }
    if (sections.available.length) {
      fragment.appendChild(
        VersionManagerGrid.section("Available", sections.available, manager, { id: "available" }),
      );
    }
    return fragment;
  }

  static emptyState(manager, packages) {
    const query = manager.searchQuery.trim();
    const filter = VersionManagerModel.FILTERS.find((entry) => entry.id === manager.filter);
    let title = "No packages registered";
    let description = "The package registry is empty.";
    if (query) {
      title = `No packages match “${query}”`;
      description = "Try a different search or category.";
    } else if (filter && filter.id !== "all") {
      title = `No ${filter.emptyLabel} packages yet`;
      description = "Choose another category to see the available packages.";
    } else if (packages.length) {
      title = "No packages match these filters";
      description = "Reset the filters to see every package again.";
    }
    const action = query || manager.filter !== "all"
      ? VersionManagerUI.button("Clear filters", () => manager.clearFilters(), {
          focusKey: "vm-clear-filters",
          icon: "fi-rr-cross-small",
        })
      : null;
    return VersionManagerUI.emptyState("fi-rr-database", title, description, action);
  }
}
