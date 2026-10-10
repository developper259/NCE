import {
  ipcMain,
  type IpcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

export type IpcInvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: any[]
) => unknown;

export interface IpcHandlerRegistrar {
  handle(channel: string, listener: IpcInvokeHandler): void;
}

interface ChannelRoutes {
  global?: IpcInvokeHandler;
  windows: Map<string, IpcInvokeHandler>;
}

/** Installs each Electron invoke handler once and routes only by event.sender. */
export class IpcRouter {
  private readonly channels = new Map<string, ChannelRoutes>();
  private readonly owners = new Map<WebContents, string>();
  private readonly ipc: Pick<IpcMain, "handle" | "removeHandler">;

  constructor(ipc: Pick<IpcMain, "handle" | "removeHandler"> = ipcMain) {
    this.ipc = ipc;
  }

  forWindow(windowId: string): IpcHandlerRegistrar {
    return {
      handle: (channel, listener) =>
        this.registerWindowHandler(windowId, channel, listener),
    };
  }

  attachWindow(windowId: string, sender: WebContents): void {
    const existingId = this.owners.get(sender);
    if (existingId && existingId !== windowId) {
      throw new Error("WebContents is already assigned to another NCE window.");
    }
    this.owners.set(sender, windowId);
  }

  detachWindow(windowId: string, sender?: WebContents | null): void {
    if (sender && this.owners.get(sender) === windowId) this.owners.delete(sender);
    for (const routes of this.channels.values()) routes.windows.delete(windowId);
  }

  registerGlobal(channel: string, listener: IpcInvokeHandler): void {
    const routes = this.ensureChannel(channel);
    if (routes.global) throw new Error(`IPC route already registered: ${channel}`);
    routes.global = listener;
  }

  private registerWindowHandler(
    windowId: string,
    channel: string,
    listener: IpcInvokeHandler,
  ): void {
    const routes = this.ensureChannel(channel);
    if (routes.windows.has(windowId)) {
      throw new Error(`IPC route already registered for window: ${channel}`);
    }
    routes.windows.set(windowId, listener);
  }

  private ensureChannel(channel: string): ChannelRoutes {
    if (!channel.trim()) throw new TypeError("IPC channel must not be empty.");
    let routes = this.channels.get(channel);
    if (routes) return routes;
    routes = { windows: new Map() };
    this.channels.set(channel, routes);
    this.ipc.handle(channel, (event, ...args) => {
      if (event.sender.isDestroyed()) return undefined;
      const ownerId = this.owners.get(event.sender);
      if (!ownerId) return undefined;
      const current = this.channels.get(channel);
      const handler = current?.windows.get(ownerId) || current?.global;
      if (!handler) return undefined;
      return handler(event, ...args);
    });
    return routes;
  }

  dispose(): void {
    for (const channel of this.channels.keys()) this.ipc.removeHandler(channel);
    this.channels.clear();
    this.owners.clear();
  }

  get registeredChannelCount(): number {
    return this.channels.size;
  }
}
