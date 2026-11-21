/**
 * UI state for one Version Manager instance. The manager is a single page, so
 * the state only tracks the catalog controls, the package detail panel and the
 * operations currently running.
 */
class VersionManagerState {
  constructor() {
    this.snapshot = null;
    this.loading = false;
    this.loadError = null;
    this.filter = "all";
    this.searchQuery = "";
    this.selectedPackageId = null;
    this.confirmation = null;
    this.operations = new Map();
    this.collapsedSections = new Set();
    this.languages = [];
    this.languageViews = new Map();
    this.componentSelection = new Map();
    this.languageApplying = null;
  }

  setFilter(filter) {
    this.filter = filter;
    this.confirmation = null;
  }

  setSearchQuery(query) {
    this.searchQuery = query;
  }

  selectPackage(packageId) {
    this.selectedPackageId = packageId;
    this.confirmation = null;
  }

  clearSelection() {
    this.selectedPackageId = null;
    this.confirmation = null;
  }

  isSectionCollapsed(sectionId) {
    return this.collapsedSections.has(sectionId);
  }

  toggleSection(sectionId) {
    if (this.collapsedSections.has(sectionId)) this.collapsedSections.delete(sectionId);
    else this.collapsedSections.add(sectionId);
  }

  clearFilters() {
    this.filter = "all";
    this.searchQuery = "";
    this.confirmation = null;
  }

  recordOperation(operation) {
    if (operation.state === "running") this.operations.set(operation.packageId, operation);
    else this.operations.delete(operation.packageId);
  }

  selectionFor(languageId) {
    return this.componentSelection.get(languageId) || null;
  }

  setSelection(languageId, ids) {
    this.componentSelection.set(languageId, new Set(ids));
  }

  toggleComponent(languageId, componentId, checked) {
    let selection = this.componentSelection.get(languageId);
    if (!selection) {
      selection = new Set();
      this.componentSelection.set(languageId, selection);
    }
    if (checked) selection.add(componentId);
    else selection.delete(componentId);
  }

  clear() {
    this.operations.clear();
    this.collapsedSections.clear();
    this.componentSelection.clear();
    this.languageViews.clear();
    this.languages = [];
    this.confirmation = null;
    this.selectedPackageId = null;
  }
}
