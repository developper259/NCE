import type { InstallerPlatform } from "../installer/types";
import type { LanguageDefinition, LanguageComponentDefinition } from "./types";

/** Actual installation state of one component, as derived from PackageManager. */
export type ComponentInstallState =
  | "installed"
  | "not-installed"
  | "corrupted"
  | "unknown"
  | "installing"
  | "uninstalling";

export interface ComponentChangePlan {
  /** Components to install, in dependency-first order. */
  toInstall: string[];
  /** Components to uninstall, in dependency-last order (dependents first). */
  toUninstall: string[];
  /** Components already in the desired state. */
  unchanged: string[];
  /** Components added automatically because a selected component needs them. */
  dependenciesToInstall: string[];
  /** Human-readable reasons a requested change cannot be applied. */
  blockers: string[];
  /** Ids that are selected but unsupported on the current platform. */
  unsupported: string[];
}

export interface PlanInput {
  language: LanguageDefinition;
  /** Ids the user explicitly selected via checkboxes. */
  selected: Iterable<string>;
  /** Real state per component id. Missing entries mean "not-installed". */
  installed: ReadonlyMap<string, ComponentInstallState>;
  platform: InstallerPlatform;
}

/**
 * Pure desired-state planner. It never touches the filesystem, the installer or
 * the store: it only compares a selection with an observed state and resolves
 * dependencies declaratively. The orchestrator applies the resulting plan.
 */
export class ComponentPlanner {
  plan(input: PlanInput): ComponentChangePlan {
    const { language, installed, platform } = input;
    const byId = new Map(language.components.map((c) => [c.id, c]));
    const selected = new Set(input.selected);
    const blockers: string[] = [];
    const unsupported: string[] = [];

    // Unknown selections are blockers rather than silent no-ops.
    for (const id of selected) {
      if (!byId.has(id)) blockers.push(`Unknown component "${id}".`);
    }

    // Unsupported components cannot be part of an install plan.
    for (const component of byId.values()) {
      if (selected.has(component.id) && !this.supports(component, platform)) {
        unsupported.push(component.id);
        blockers.push(`${component.name} is not available on ${platform}.`);
      }
    }

    // Expand the selected set with transitive dependencies.
    const desired = new Set<string>();
    const dependenciesToInstall = new Set<string>();
    for (const id of selected) {
      if (byId.has(id) && this.supports(byId.get(id)!, platform)) {
        this.addWithDependencies(id, byId, desired, dependenciesToInstall, platform, blockers);
      }
    }

    // Anything the user did not select (directly or as a dependency) is unwanted.
    const cycle = this.findCycle(byId);
    if (cycle) blockers.push(`Circular dependency: ${cycle.join(" -> ")}.`);

    const isInstalled = (id: string) => {
      const state = installed.get(id) ?? "not-installed";
      return state === "installed" || state === "installing";
    };

    const toInstall: string[] = [];
    const unchanged: string[] = [];
    for (const id of desired) {
      if (isInstalled(id)) unchanged.push(id);
      else toInstall.push(id);
    }

    // A component is uninstallable only if no desired component still needs it.
    // `desired` already includes every transitive dependency, so a shared
    // dependency kept by another selected component is never removed.
    const toUninstall: string[] = [];
    for (const component of language.components) {
      if (desired.has(component.id)) continue;
      if (!isInstalled(component.id)) continue;
      const requiredBy = [...desired].filter((id) =>
        this.dependsOn(byId.get(id)!, component.id, byId),
      );
      if (requiredBy.length) {
        blockers.push(
          `${component.name} is still required by ${requiredBy.map((id) => byId.get(id)!.name).join(", ")}.`,
        );
        continue;
      }
      toUninstall.push(component.id);
    }

    return {
      toInstall: this.orderInstall(toInstall, byId),
      toUninstall: this.orderUninstall(toUninstall, byId),
      unchanged,
      dependenciesToInstall: [...dependenciesToInstall].filter((id) => toInstall.includes(id)),
      blockers,
      unsupported,
    };
  }

  /** Total action count, used by the UI to label the primary button. */
  actionCount(plan: ComponentChangePlan): number {
    return plan.toInstall.length + plan.toUninstall.length;
  }

  private supports(component: LanguageComponentDefinition, platform: InstallerPlatform): boolean {
    return component.platforms.includes(platform);
  }

  private addWithDependencies(
    id: string,
    byId: Map<string, LanguageComponentDefinition>,
    desired: Set<string>,
    dependencies: Set<string>,
    platform: InstallerPlatform,
    blockers: string[],
    visiting = new Set<string>(),
  ): void {
    if (desired.has(id)) return;
    if (visiting.has(id)) return; // cycles are reported separately
    visiting.add(id);
    const component = byId.get(id);
    if (!component) return;
    desired.add(id);
    for (const dependency of component.dependencies ?? []) {
      if (!byId.has(dependency)) continue;
      const dependencyDefinition = byId.get(dependency)!;
      // A dependency that cannot run on this platform must never be scheduled
      // silently: the dependent component cannot work without it, so the plan
      // reports a blocker instead of an install that would fail.
      if (!this.supports(dependencyDefinition, platform)) {
        blockers.push(
          `${component.name} requires ${dependencyDefinition.name}, which is not available on ${platform}.`,
        );
        continue;
      }
      if (!desired.has(dependency)) dependencies.add(dependency);
      this.addWithDependencies(
        dependency, byId, desired, dependencies, platform, blockers, visiting,
      );
    }
    visiting.delete(id);
  }

  private dependsOn(
    component: LanguageComponentDefinition,
    targetId: string,
    byId: Map<string, LanguageComponentDefinition>,
    seen = new Set<string>(),
  ): boolean {
    if (seen.has(component.id)) return false;
    seen.add(component.id);
    for (const dependency of component.dependencies ?? []) {
      if (dependency === targetId) return true;
      const dependencyDefinition = byId.get(dependency);
      if (dependencyDefinition && this.dependsOn(dependencyDefinition, targetId, byId, seen)) return true;
    }
    return false;
  }

  /** Dependencies first: a component is installed after everything it needs. */
  private orderInstall(
    ids: string[],
    byId: Map<string, LanguageComponentDefinition>,
  ): string[] {
    const result: string[] = [];
    const placed = new Set<string>();
    const place = (id: string, stack: Set<string>) => {
      if (placed.has(id) || stack.has(id)) return;
      stack.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) {
        if (ids.includes(dependency)) place(dependency, stack);
      }
      stack.delete(id);
      placed.add(id);
      result.push(id);
    };
    for (const id of ids) place(id, new Set());
    return result;
  }

  /** Dependents first: a component is removed before the things it needs. */
  private orderUninstall(
    ids: string[],
    byId: Map<string, LanguageComponentDefinition>,
  ): string[] {
    return this.orderInstall(ids, byId).reverse();
  }

  private findCycle(byId: Map<string, LanguageComponentDefinition>): string[] | null {
    const state = new Map<string, number>(); // 1 = visiting, 2 = done
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      if (state.get(id) === 1) {
        const start = stack.indexOf(id);
        return [...stack.slice(start), id];
      }
      if (state.get(id) === 2) return null;
      state.set(id, 1);
      stack.push(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) {
        if (!byId.has(dependency)) continue;
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
      stack.pop();
      state.set(id, 2);
      return null;
    };
    for (const id of byId.keys()) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
    return null;
  }
}
