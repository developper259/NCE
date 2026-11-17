import type { Installer } from "../installer/Installer";
import { PackageManager } from "../packages/PackageManager";
import type { SettingsBridge } from "../packages/types";
import type { IpcHandlerRegistrar } from "./IpcRouter";

const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface VersionManagerOptions {
  userDataPath: string;
  installer: Installer;
  settings: SettingsBridge;
  broadcast?: (channel: string, payload: unknown) => void;
}

/**
 * App-level owner of the shared PackageManager. Validates renderer payloads,
 * exposes the IPC surface and broadcasts lifecycle events to every window so
 * all open Version Manager views stay in sync.
 */
export class VersionManager {
  readonly packages: PackageManager;
  private readonly broadcast?: (channel: string, payload: unknown) => void;
  private unsubscribe: (() => void) | null = null;

  constructor(options: VersionManagerOptions) {
    this.packages = new PackageManager({
      userDataPath: options.userDataPath,
      installer: options.installer,
      settings: options.settings,
    });
    this.broadcast = options.broadcast;
    this.unsubscribe = this.packages.subscribe((event) => {
      this.broadcast?.("VersionManager:event", event);
    });
  }

  initialize(): Promise<void> {
    return this.packages.initialize();
  }

  handleIPC(ipc: IpcHandlerRegistrar): void {
    ipc.handle("VersionManager:state", async () => this.packages.getState());
    ipc.handle("VersionManager:refresh", async () => this.packages.refresh());
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
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}