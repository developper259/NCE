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

  clearFilters() {
    this.filter = "all";
    this.searchQuery = "";
    this.confirmation = null;
  }

  recordOperation(operation) {
    if (operation.state === "running") this.operations.set(operation.packageId, operation);
    else this.operations.delete(operation.packageId);
  }

  clear() {
    this.operations.clear();
    this.confirmation = null;
    this.selectedPackageId = null;
  }
}
