/**
 * The Version Manager's only page: every environment NCE knows about, split
 * into Installed and Available sections. Search and filters run in the header
 * and update both sections at once.
 */
class VersionManagerCatalog {
  /**
   * One entry per environment the user can act on.
   *
   * The catalog is package-driven, which is right for Git and Python: their
   * package is the environment. It breaks down for a language whose packages
   * are all components rather than cards. JavaScript & TypeScript is exactly
   * that case: the TypeScript SDK is `hiddenFromCatalog` and the language server
   * is a `language-server` package, so no card was left and the environment was
   * unreachable. Such a language gets one entry derived from its definition.
   */
  static entries(manager) {
    const packages = manager.snapshot?.packages || [];
    const entries = VersionManagerModel.catalogPackages(packages);
    const covered = new Set(entries.map((entry) => entry.id));
    for (const language of manager.languages || []) {
      // The loaded view is authoritative for components: the list may carry only
      // the language metadata, and matching on an empty component list would add
      // a second entry for an environment that already has a card.
      const view = manager.languageViews?.get?.(language.id) || null;
      const components = view?.components || language.components || [];
      // A language that already owns a visible package keeps that package's
      // card: adding a second entry would show the same environment twice.
      if (components.some((component) => covered.has(component.packageId))) continue;
      entries.push(VersionManagerCatalog.languageEntry(manager, language));
    }
    return entries;
  }

  /**
   * Catalog card for a language whose components are all hidden.
   *
   * The card speaks the catalog's language (name, description, state) and
   * carries `kind: "language"` so the card and the detail route know they are
   * acting on a whole environment, not on a single package.
   */
  static languageEntry(manager, language) {
    const view = manager.languageViews?.get?.(language.id) || null;
    const state = VersionManagerLanguageDetail.environmentState(view).state;
    const installed = state === "installed";
    const supported = (language.components || []).some((component) => component.supported !== false);
    // A running grouped apply has no package operation to read, so the card
    // takes its state from the language being applied.
    const applying = manager.languageApplying === language.id;
    return {
      id: language.id,
      kind: "language",
      name: language.name,
      description: language.summary || language.description,
      categories: language.categories || ["language"],
      icon: language.icon,
      supported,
      capabilities: ["install"],
      // The components carry different versions, so a single number would be
      // misleading. The detail page lists them.
      installableVersion: "",
      state: applying
        ? "installing"
        : installed
          ? "installed"
          : state === "partial"
            ? "partial"
            : state === "error"
              ? "failed"
              : "not-installed",
      installations: installed ? [{ state: "installed", version: "" }] : [],
    };
  }

  static render(manager) {
    const entries = VersionManagerCatalog.entries(manager);
    const sections = VersionManagerModel.catalogSections(entries, {
      filter: manager.filter,
      query: manager.searchQuery,
    });

    const fragment = document.createDocumentFragment();
    if (!sections.installed.length && !sections.available.length) {
      fragment.appendChild(VersionManagerCatalog.emptyState(manager, entries));
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

  static emptyState(manager, entries) {
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
    } else if (entries.length) {
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
