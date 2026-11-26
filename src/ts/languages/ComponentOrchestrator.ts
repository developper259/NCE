import type { ComponentChangePlan } from "./ComponentPlanner";
import type { LanguageComponentDefinition } from "./types";

export type ComponentOperationKind = "install" | "verify" | "uninstall";
export type ComponentOperationState = "running" | "completed" | "failed" | "cancelled" | "skipped";

export interface ComponentOperationEvent {
  componentId: string;
  packageId: string;
  kind: ComponentOperationKind;
  state: ComponentOperationState;
  message: string;
  error?: { code: string; message: string };
}

export interface ComponentApplyResult {
  success: boolean;
  cancelled?: boolean;
  code?: string;
  error?: string;
}

/** Minimal surface the orchestrator needs from the existing PackageManager. */
export interface ComponentOperations {
  install(packageId: string): Promise<ComponentApplyResult>;
  verify(installationId: string): Promise<ComponentApplyResult>;
  uninstall(installationId: string): Promise<ComponentApplyResult>;
  /** Current installation id for a package, needed to uninstall/verify it. */
  installationIdFor(packageId: string): string | null;
  cancel(packageId: string): boolean;
}

export interface ApplyPlanResult {
  success: boolean;
  completed: string[];
  failed: string[];
  cancelled: boolean;
  events: ComponentOperationEvent[];
}

export interface ApplyPlanOptions {
  plan: ComponentChangePlan;
  components: Map<string, LanguageComponentDefinition>;
  operations: ComponentOperations;
  onEvent?: (event: ComponentOperationEvent) => void;
  signal?: AbortSignal;
}

/**
 * Applies a change plan using the existing PackageManager. Safety order for a
 * mixed plan: install -> verify -> uninstall, so a working environment is
 * never torn down before replacements are validated. Failures are partial and
 * reported honestly; already-installed components are kept.
 */
export class ComponentOrchestrator {
  private active = false;
  private controller: AbortController | null = null;
  private operations: ComponentOperations | null = null;
  private currentPackageId: string | null = null;

  get busy(): boolean {
    return this.active;
  }

  cancel(): boolean {
    if (!this.active || !this.controller) return false;
    this.controller.abort();
    // Aborting the plan only stops the loop between steps. The underlying
    // package operation is the one actually downloading/writing, so it must
    // be cancelled too or it keeps running and changes the inventory after
    // the plan has been reported as cancelled.
    if (this.currentPackageId) this.operations?.cancel(this.currentPackageId);
    return true;
  }

  async apply(options: ApplyPlanOptions): Promise<ApplyPlanResult> {
    if (this.active) {
      return {
        success: false,
        completed: [],
        failed: [],
        cancelled: false,
        events: [this.event("", "", "install", "failed", "Another component operation is already running.")],
      };
    }
    this.active = true;
    this.controller = new AbortController();
    this.operations = options.operations;
    this.currentPackageId = null;
    const externalAbort = () => this.cancel();
    options.signal?.addEventListener("abort", externalAbort, { once: true });

    const events: ComponentOperationEvent[] = [];
    const completed: string[] = [];
    const failed: string[] = [];
    const emit = (event: ComponentOperationEvent) => {
      events.push(event);
      options.onEvent?.(event);
    };
    const aborted = () => this.controller?.signal.aborted ?? false;

    try {
      if (options.plan.blockers.length) {
        for (const blocker of options.plan.blockers) {
          emit(this.event("", "", "install", "failed", blocker));
        }
        return { success: false, completed, failed, cancelled: false, events };
      }

      // Phase 1: install in dependency-first order.
      for (const id of options.plan.toInstall) {
        if (aborted()) break;
        const component = options.components.get(id);
        if (!component) continue;
        emit(this.event(id, component.packageId, "install", "running", `Installing ${component.name}…`));
        this.currentPackageId = component.packageId;
        const result = await options.operations.install(component.packageId);
        this.currentPackageId = null;
        if (result.success) {
          completed.push(id);
          emit(this.event(id, component.packageId, "install", "completed", `${component.name} installed.`));
        } else if (result.cancelled || aborted()) {
          emit(this.event(id, component.packageId, "install", "cancelled", `${component.name} installation cancelled.`, this.asError(result)));
          return { success: false, completed, failed, cancelled: true, events };
        } else {
          failed.push(id);
          emit(this.event(id, component.packageId, "install", "failed", `${component.name} installation failed.`, this.asError(result)));
        }
      }

      // Phase 2: verify freshly installed components before removing anything.
      for (const id of options.plan.toInstall) {
        if (aborted()) break;
        if (!completed.includes(id)) continue;
        const component = options.components.get(id);
        if (!component) continue;
        const installationId = options.operations.installationIdFor(component.packageId);
        if (!installationId) continue;
        emit(this.event(id, component.packageId, "verify", "running", `Verifying ${component.name}…`));
        this.currentPackageId = component.packageId;
        const result = await options.operations.verify(installationId);
        this.currentPackageId = null;
        if (result.success) {
          emit(this.event(id, component.packageId, "verify", "completed", `${component.name} verified.`));
        } else {
          // A component that fails verification is not completed: reporting it
          // in both lists would let callers count it as a successful install.
          completed.splice(completed.indexOf(id), 1);
          failed.push(id);
          emit(this.event(id, component.packageId, "verify", "failed", `${component.name} verification failed.`, this.asError(result)));
        }
      }

      // Phase 3: uninstall only when no install/verify failed. A partial install
      // must never be followed by removing working components.
      if (failed.length === 0) for (const id of options.plan.toUninstall) {
        if (aborted()) break;
        const component = options.components.get(id);
        if (!component) continue;
        const installationId = options.operations.installationIdFor(component.packageId);
        if (!installationId) {
          emit(this.event(id, component.packageId, "uninstall", "skipped", `${component.name} has no managed installation.`));
          continue;
        }
        emit(this.event(id, component.packageId, "uninstall", "running", `Uninstalling ${component.name}…`));
        this.currentPackageId = component.packageId;
        const result = await options.operations.uninstall(installationId);
        this.currentPackageId = null;
        if (result.success) {
          completed.push(id);
          emit(this.event(id, component.packageId, "uninstall", "completed", `${component.name} uninstalled.`));
        } else if (result.cancelled || aborted()) {
          emit(this.event(id, component.packageId, "uninstall", "cancelled", `${component.name} uninstallation cancelled.`, this.asError(result)));
          return { success: false, completed, failed, cancelled: true, events };
        } else {
          failed.push(id);
          emit(this.event(id, component.packageId, "uninstall", "failed", `${component.name} uninstallation failed.`, this.asError(result)));
        }
      }

      return {
        success: failed.length === 0 && !aborted(),
        completed,
        failed,
        cancelled: aborted(),
        events,
      };
    } finally {
      options.signal?.removeEventListener("abort", externalAbort);
      this.controller = null;
      this.operations = null;
      this.currentPackageId = null;
      this.active = false;
    }
  }

  private event(
    componentId: string,
    packageId: string,
    kind: ComponentOperationKind,
    state: ComponentOperationState,
    message: string,
    error?: { code: string; message: string },
  ): ComponentOperationEvent {
    return { componentId, packageId, kind, state, message, error };
  }

  private asError(result: ComponentApplyResult): { code: string; message: string } {
    return { code: result.code ?? "OPERATION_FAILED", message: result.error ?? "Unknown error." };
  }
}
