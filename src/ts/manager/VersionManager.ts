import type { Installer } from "../installer/Installer";
import { builtinLanguages } from "../languages";
import { LanguageApplicationService } from "../languages/LanguageApplicationService";
import { LanguageService } from "../languages/LanguageService";
import { PackageManager } from "../packages/PackageManager";
import { ManagedToolResolver } from "../packages/ManagedToolResolver";
import { PackageRegistry } from "../packages/PackageRegistry";
import type { SettingsBridge } from "../packages/types";
import type { IpcHandlerRegistrar } from "./IpcRouter";

const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface VersionManagerOptions {
  userDataPath: string;
  installer: Installer;
  settings: SettingsBridge;
  /** Optional registry override; defaults to all built-in managed packages. */
  registry?: PackageRegistry;
  broadcast?: (channel: string, payload: unknown) => void;
  /**
   * Called when the managed inventory changes, with the packages that moved.
   * Main-process services that launch managed executables (the LSP engine)
   * listen here; the renderer broadcast above only keeps UI views in sync.
   */
  onInventoryChanged?: (packageIds: string[]) => void;
}

/**
 * App-level owner of the shared PackageManager. Validates renderer payloads,
 * exposes the IPC surface and broadcasts lifecycle events to every window so
 * all open Version Manager views stay in sync.
 */
export class VersionManager {
  readonly packages: PackageManager;
  readonly languages: LanguageService;
  readonly languageApplications: LanguageApplicationService;
  /** Read-only view of NCE-owned installations, shared with the LSP engine. */
  readonly managedTools: ManagedToolResolver;
  private readonly broadcast?: (channel: string, payload: unknown) => void;
  private readonly onInventoryChanged?: (packageIds: string[]) => void;
  private unsubscribe: (() => void) | null = null;

  constructor(options: VersionManagerOptions) {
    const registry = options.registry ?? new PackageRegistry();
    this.packages = new PackageManager({
      userDataPath: options.userDataPath,
      installer: options.installer,
      registry,
      settings: options.settings,
    });
    this.managedTools = new ManagedToolResolver({ store: this.packages.store });
    this.languages = new LanguageService(builtinLanguages, registry);
    this.languageApplications = new LanguageApplicationService(this.packages);
    this.broadcast = options.broadcast;
    this.onInventoryChanged = options.onInventoryChanged;
    this.unsubscribe = this.packages.subscribe((event) => {
      this.broadcast?.("VersionManager:event", event);
      if (event.type === "inventory-changed") {
        this.onInventoryChanged?.(event.packageIds);
      }
    });
  }

  initialize(): Promise<void> {
    return this.packages.initialize();
  }

  handleIPC(ipc: IpcHandlerRegistrar): void {
    ipc.handle("VersionManager:state", async () => this.packages.getState());
    ipc.handle("VersionManager:refresh", async () => this.packages.refresh());
    ipc.handle("VersionManager:removal-check", async (_event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      if (!SAFE_TOKEN.test(packageId))
        return { allowed: false, packageId, requiredBy: [], reason: "Invalid package id." };
      return this.packages.removalCheck(packageId);
    });
    ipc.handle("VersionManager:install", async (_event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      if (!SAFE_TOKEN.test(packageId))
        return { success: false, code: "PACKAGE_NOT_FOUND", error: "Invalid package id." };
      return this.packages.install(packageId);
    });
    ipc.handle("VersionManager:uninstall", async (_event, payload) => {
      const installationId = typeof payload?.installationId === "string" ? payload.installationId : "";
      if (!SAFE_TOKEN.test(installationId))
        return { success: false, code: "INSTALLATION_NOT_FOUND", error: "Invalid installation id." };
      return this.packages.uninstall(installationId);
    });
    ipc.handle("VersionManager:verify", async (_event, payload) => {
      const installationId = typeof payload?.installationId === "string" ? payload.installationId : "";
      if (!SAFE_TOKEN.test(installationId))
        return { success: false, code: "INSTALLATION_NOT_FOUND", error: "Invalid installation id." };
      return this.packages.verify(installationId);
    });
    ipc.handle("VersionManager:cancel", async (_event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      return SAFE_TOKEN.test(packageId) ? this.packages.cancel(packageId) : false;
    });

    // Language component management. These reuse the same PackageManager above;
    // the language layer is declarative and owns no install logic of its own.
    ipc.handle("VersionManager:languages", async () => this.languages.list());
    ipc.handle("VersionManager:language-view", async (_event, payload) => {
      const languageId = typeof payload?.languageId === "string" ? payload.languageId : "";
      if (!SAFE_TOKEN.test(languageId)) return null;
      const selected = Array.isArray(payload?.selected)
        ? payload.selected.filter((id: unknown): id is string => typeof id === "string" && SAFE_TOKEN.test(id))
        : undefined;
      return this.languages.view(languageId, this.packages.getState(), selected);
    });
    ipc.handle("VersionManager:apply-components", async (_event, payload) => {
      const languageId = typeof payload?.languageId === "string" ? payload.languageId : "";
      if (!SAFE_TOKEN.test(languageId))
        return { success: false, code: "INVALID_LANGUAGE", error: "Invalid language id." };
      const view = this.languages.view(languageId, this.packages.getState());
      if (!view)
        return { success: false, code: "INVALID_LANGUAGE", error: "Unknown language." };
      const selected = Array.isArray(payload?.selected)
        ? payload.selected.filter((id: unknown): id is string => typeof id === "string" && SAFE_TOKEN.test(id))
        : view.selected;
      // Recompute the plan from the submitted selection on the main side; never
      // trust a plan supplied by the renderer.
      const fresh = this.languages.view(languageId, this.packages.getState(), selected);
      if (!fresh) return { success: false, code: "INVALID_LANGUAGE", error: "Unknown language." };
      const language = this.languages.languageDefinition(languageId);
      if (!language) return { success: false, code: "INVALID_LANGUAGE", error: "Unknown language." };
      return this.languageApplications.apply(fresh.plan, language.components, (event) => {
        this.broadcast?.("VersionManager:event", {
          type: "component-operation",
          ...event,
        });
      });
    });
  }

  dispose(): void {
    this.languageApplications.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}