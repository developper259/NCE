import type { ManagedPackageDefinition } from "./types";
import type { PackageRegistry } from "./PackageRegistry";

/** One package that still needs another one, with the reason it does. */
export interface DependencyBlocker {
  packageId: string;
  packageName: string;
  /** Installed versions of the dependent package, if any. */
  installedVersions: string[];
}

export interface RemovalCheck {
  allowed: boolean;
  packageId: string;
  /** Packages that would be left broken by removing this one. */
  requiredBy: DependencyBlocker[];
  /** Human-readable explanation, safe to show in the UI. */
  reason: string | null;
}

/** A dependency declared by a language component rather than by a package. */
export interface ComponentDependencyEdge {
  /** Package id of the component that needs another one. */
  packageId: string;
  /** Package id the component depends on. */
  dependsOnPackageId: string;
}

export interface DependencyGraphOptions {
  registry: PackageRegistry;
  /** Package ids that currently have a usable installation. */
  installedPackageIds: () => Iterable<string>;
  /** Installed versions of a package, newest first, for the explanation. */
  installedVersions?: (packageId: string) => string[];
  /**
   * Edges declared by language components. A language environment can require
   * a package (e.g. Python's LSP needs the Python runtime) without the package
   * definitions themselves knowing about each other.
   */
  componentDependencies?: () => Iterable<ComponentDependencyEdge>;
}

/**
 * Reverse dependency knowledge over the managed package catalog.
 *
 * `ManagedPackageDefinition.dependencies` describes what a package needs. This
 * class answers the opposite question, which the catalog never had to answer
 * before: what still needs *this* package. That is the question that decides
 * whether an uninstall is safe.
 *
 * Only packages that are actually installed count as blockers. A declared but
 * absent dependent cannot be broken by a removal, and blocking on it would make
 * the Version Manager refuse operations for software that is not even there.
 */
export class PackageDependencyGraph {
  private readonly registry: PackageRegistry;
  private readonly installedPackageIds: () => Iterable<string>;
  private readonly installedVersions: (packageId: string) => string[];
  private readonly componentDependencies: () => Iterable<ComponentDependencyEdge>;

  constructor(options: DependencyGraphOptions) {
    this.registry = options.registry;
    this.installedPackageIds = options.installedPackageIds;
    this.installedVersions = options.installedVersions ?? (() => []);
    this.componentDependencies = options.componentDependencies ?? (() => []);
  }

  /** Direct dependents of a package, from both the catalog and language components. */
  directDependents(packageId: string): ManagedPackageDefinition[] {
    const ids = new Set(
      this.registry.list()
        .filter((definition) => (definition.dependencies ?? []).includes(packageId))
        .map((definition) => definition.id),
    );
    for (const edge of this.componentDependencies()) {
      if (edge.dependsOnPackageId === packageId && this.registry.has(edge.packageId)) {
        ids.add(edge.packageId);
      }
    }
    return [...ids].map((id) => this.registry.get(id));
  }

  /** Every package that transitively needs `packageId`. */
  transitiveDependents(packageId: string): ManagedPackageDefinition[] {
    const seen = new Set<string>();
    const result: ManagedPackageDefinition[] = [];
    const queue = [packageId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependent of this.directDependents(current)) {
        if (dependent.id === packageId || seen.has(dependent.id)) continue;
        seen.add(dependent.id);
        result.push(dependent);
        queue.push(dependent.id);
      }
    }
    return result;
  }

  /** Transitive dependencies of a package, excluding the package itself. */
  transitiveDependencies(packageId: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    const visit = (id: string) => {
      const definition = this.registry.has(id) ? this.registry.get(id) : null;
      if (!definition) return;
      for (const dependency of definition.dependencies ?? []) {
        if (seen.has(dependency) || dependency === packageId) continue;
        seen.add(dependency);
        result.push(dependency);
        visit(dependency);
      }
    };
    visit(packageId);
    return result;
  }

  /**
   * Decide whether a package can be removed.
   *
   * A package is removable only when no *installed* package depends on it,
   * directly or transitively. The answer names the blockers so the caller can
   * explain the refusal instead of just denying it.
   */
  checkRemoval(packageId: string): RemovalCheck {
    const installed = new Set(this.installedPackageIds());
    const requiredBy: DependencyBlocker[] = [];
    for (const dependent of this.transitiveDependents(packageId)) {
      if (!installed.has(dependent.id)) continue;
      requiredBy.push({
        packageId: dependent.id,
        packageName: dependent.name,
        installedVersions: this.installedVersions(dependent.id),
      });
    }

    if (!requiredBy.length) {
      return { allowed: true, packageId, requiredBy, reason: null };
    }

    const name = this.registry.has(packageId) ? this.registry.get(packageId).name : packageId;
    const names = requiredBy.map((blocker) => blocker.packageName).join(", ");
    return {
      allowed: false,
      packageId,
      requiredBy,
      reason: `${name} is still required by ${names}. Uninstall ${names} first.`,
    };
  }
}
