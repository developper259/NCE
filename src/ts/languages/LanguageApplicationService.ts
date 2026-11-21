import type { PackageManager } from "../packages/PackageManager";
import {
  ComponentOrchestrator,
  type ComponentOperationEvent,
} from "./ComponentOrchestrator";
import type { ComponentChangePlan } from "./ComponentPlanner";
import type { LanguageComponentDefinition } from "./types";

/**
 * Applies language component plans through the existing PackageManager. It is
 * the only bridge between the declarative language layer and real installs;
 * no second installer, store or registry is involved.
 */
export class LanguageApplicationService {
  private readonly orchestrator = new ComponentOrchestrator();

  constructor(private readonly packages: PackageManager) {}

  get busy(): boolean {
    return this.orchestrator.busy;
  }

  cancel(): boolean {
    return this.orchestrator.cancel();
  }

  async apply(
    plan: ComponentChangePlan,
    components: LanguageComponentDefinition[],
    onEvent?: (event: ComponentOperationEvent) => void,
  ): Promise<{ success: boolean; completed: string[]; failed: string[]; cancelled: boolean }> {
    const componentMap = new Map(components.map((component) => [component.id, component]));
    return this.orchestrator.apply({
      plan,
      components: componentMap,
      operations: {
        install: (packageId) => this.packages.install(packageId),
        verify: (installationId) => this.packages.verify(installationId),
        uninstall: (installationId) => this.packages.uninstall(installationId),
        installationIdFor: (packageId) => this.installationIdFor(packageId),
        cancel: (packageId) => this.packages.cancel(packageId),
      },
      onEvent,
    });
  }

  private installationIdFor(packageId: string): string | null {
    const records = this.packages.store.listByPackage(packageId);
    const active = records.find((record) => record.state === "installed") ?? records[0];
    return active?.id ?? null;
  }
}
