import { Installer } from "../installer/Installer";
import type { InstallerOptions } from "../installer/types";
import type { IpcHandlerRegistrar } from "./IpcRouter";

/** One shared installer per app so concurrent windows cannot install over each other. */
export class InstallerManager {
  private readonly installer: Installer;
  private readonly onChanged?: (packageId: string) => void;

  constructor(options: InstallerOptions, onChanged?: (packageId: string) => void) {
    this.installer = new Installer(options);
    this.onChanged = onChanged;
  }

  /** The shared Installer, so other managers reuse the same busy guard and tools root. */
  getInstaller(): Installer {
    return this.installer;
  }

  handleIPC(ipc: IpcHandlerRegistrar): void {
    ipc.handle("Installer:install", async (event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      const sender = event.sender;
      const result = await this.installer.install(packageId, {
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send("Installer:progress", progress);
        },
      });
      // The sidebar installs Git through this channel, bypassing VersionManager.
      // Without this the inventory would still report it as missing.
      if (result.success) this.onChanged?.(packageId);
      return result;
    });
    ipc.handle("Installer:cancel", async (_event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : undefined;
      return this.installer.cancel(packageId);
    });
    ipc.handle("Installer:installation", async (_event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      return this.installer.getInstallation(packageId);
    });
    ipc.handle("Installer:uninstall", async (_event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      const result = await this.installer.uninstall(packageId);
      if (result.success) this.onChanged?.(packageId);
      return result;
    });
  }
}