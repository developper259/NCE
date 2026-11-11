import { Installer } from "../installer/Installer";
import type { InstallerOptions } from "../installer/types";
import type { IpcHandlerRegistrar } from "./IpcRouter";

/** One shared installer per app so concurrent windows cannot install over each other. */
export class InstallerManager {
  private readonly installer: Installer;

  constructor(options: InstallerOptions) {
    this.installer = new Installer(options);
  }

  handleIPC(ipc: IpcHandlerRegistrar): void {
    ipc.handle("Installer:install", async (event, payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      const sender = event.sender;
      return this.installer.install(packageId, {
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send("Installer:progress", progress);
        },
      });
    });
    ipc.handle("Installer:cancel", async () => {
      this.installer.cancel();
      return true;
    });
  }
}