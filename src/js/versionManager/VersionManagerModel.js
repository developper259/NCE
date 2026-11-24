/**
 * Pure catalog model. It knows how to derive the visible package groups from a
 * VersionManager snapshot, but never touches the DOM or the installer API.
 */
class VersionManagerModel {
  static matchesFilter(packageInfo, filterId) {
    const filter = VersionManagerModel.FILTERS.find((entry) => entry.id === filterId);
    if (!filter || !filter.categories) return true;
    const categories = packageInfo.categories || [];
    if (filterId === "other") {
      return !VersionManagerModel.matchesFilter(packageInfo, "languages") &&
        !VersionManagerModel.matchesFilter(packageInfo, "tools");
    }
    return categories.some((category) => filter.categories.includes(category));
  }

  static matchesSearch(packageInfo, query) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return true;
    const haystack = [
      packageInfo.id,
      packageInfo.name,
      packageInfo.description,
      packageInfo.publisher,
      packageInfo.installableVersion,
      ...(packageInfo.categories || []).map((category) => VersionManagerModel.categoryLabel(category)),
      ...(packageInfo.installations || []).map((record) => record.version),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  }

  static categoryLabel(category) {
    return VersionManagerModel.CATEGORY_LABELS[category] || category;
  }

  static categoryLabels(packageInfo) {
    return (packageInfo.categories || []).map((category) => VersionManagerModel.categoryLabel(category));
  }

  static categorySummary(packageInfo) {
    const labels = VersionManagerModel.categoryLabels(packageInfo);
    return labels.length ? labels[0] : "Other";
  }

  static isInstalled(packageInfo) {
    return (packageInfo.installations || []).length > 0;
  }

  static installationState(packageInfo, operations) {
    const operation = operations?.get?.(packageInfo.id);
    if (operation?.state === "running") {
      if (operation.kind === "install") return "installing";
      if (operation.kind === "uninstall") return "uninstalling";
    }
    return packageInfo.state;
  }

  static primaryInstallation(packageInfo) {
    const installations = [...(packageInfo.installations || [])];
    installations.sort((a, b) => {
      const aReady = a.state === "installed" ? 1 : 0;
      const bReady = b.state === "installed" ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      return (b.updatedAt || b.installedAt || 0) - (a.updatedAt || a.installedAt || 0);
    });
    return installations[0] || null;
  }

  static packageVersion(packageInfo) {
    const installation = VersionManagerModel.primaryInstallation(packageInfo);
    return installation?.version || packageInfo.installableVersion || "";
  }

  static sortByName(packages) {
    return [...packages].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Language servers are language components, never top-level catalog packages. */
  static isLanguageServer(packageInfo) {
    return (packageInfo.categories || []).includes("language-server");
  }

  /**
   * Packages the catalog must not list as their own card. They are installed
   * through the components of the language that owns them, so a separate card
   * would show the same environment twice.
   */
  static isHiddenFromCatalog(packageInfo) {
    return packageInfo.hiddenFromCatalog === true;
  }

  static catalogPackages(packages) {
    return packages.filter((packageInfo) =>
      !VersionManagerModel.isLanguageServer(packageInfo) &&
      !VersionManagerModel.isHiddenFromCatalog(packageInfo));
  }

  static catalogSections(packages, { filter = "all", query = "" } = {}) {
    const visible = VersionManagerModel.catalogPackages(packages).filter((packageInfo) =>
      VersionManagerModel.matchesFilter(packageInfo, filter) &&
      VersionManagerModel.matchesSearch(packageInfo, query));
    return {
      installed: VersionManagerModel.sortByName(
        visible.filter((packageInfo) => VersionManagerModel.isInstalled(packageInfo)),
      ),
      available: VersionManagerModel.sortByName(
        visible.filter((packageInfo) => !VersionManagerModel.isInstalled(packageInfo)),
      ),
    };
  }

  static summary(packages) {
    const visible = VersionManagerModel.catalogPackages(packages);
    const installed = visible.filter((packageInfo) => VersionManagerModel.isInstalled(packageInfo));
    const available = visible.filter((packageInfo) =>
      !VersionManagerModel.isInstalled(packageInfo) && packageInfo.supported);
    let attention = 0;
    for (const packageInfo of visible) {
      if (packageInfo.state === "failed") attention += 1;
      for (const record of packageInfo.installations || [])
        if (record.state === "corrupted" || record.state === "unknown") attention += 1;
    }
    return {
      packages: visible.length,
      installed: installed.length,
      available: available.length,
      installations: visible.reduce((total, entry) => total + (entry.installations || []).length, 0),
      attention,
    };
  }
}

VersionManagerModel.FILTERS = [
  { id: "all", label: "All", emptyLabel: "package", icon: "fi-rr-database", categories: null },
  { id: "languages", label: "Languages", emptyLabel: "language", icon: "fi-rr-code-simple", categories: ["language"] },
  { id: "tools", label: "Tools", emptyLabel: "tool", icon: "fi-rr-settings-sliders", categories: ["git"] },
  { id: "other", label: "Other", emptyLabel: "other", icon: "fi-rr-database", categories: ["other"] },
];

VersionManagerModel.CATEGORY_LABELS = {
  git: "Tools",
  language: "Languages",
  runtime: "Runtimes",
  compiler: "Compilers",
  toolchain: "Toolchains",
  "language-server": "Language Servers",
  other: "Other",
};

VersionManagerModel.STATE_LABELS = {
  "not-installed": "Not installed",
  available: "Available",
  unavailable: "Unavailable",
  installed: "Installed",
  installing: "Installing…",
  uninstalling: "Uninstalling…",
  failed: "Failed",
  corrupted: "Corrupted",
  external: "External",
  unknown: "Unknown",
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
};

VersionManagerModel.STATE_ICONS = {
  "not-installed": "fi-rr-minus",
  available: "fi-rr-download",
  unavailable: "fi-rr-lock",
  installed: "fi-rr-check",
  installing: "fi-rr-refresh",
  uninstalling: "fi-rr-refresh",
  failed: "fi-rr-cross-circle",
  corrupted: "fi-rr-triangle-warning",
  external: "fi-rr-lock",
  unknown: "fi-rr-info",
  running: "fi-rr-refresh",
  completed: "fi-rr-check",
  cancelled: "fi-rr-cross-small",
};

VersionManagerModel.OPERATION_LABELS = {
  install: "Install",
  uninstall: "Uninstall",
  verify: "Verify",
};

VersionManagerModel.OPERATION_ICONS = {
  install: "fi-rr-download",
  uninstall: "fi-rr-trash",
  verify: "fi-rr-refresh",
};
