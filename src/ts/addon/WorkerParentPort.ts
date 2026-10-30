interface ParentPortLike {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function parentPort(): ParentPortLike | null {
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  return port && typeof port.postMessage === "function" && typeof port.on === "function"
    ? port
    : null;
}

/** Utility processes talk through parentPort; Node forks through process IPC. */
export function onParentMessage(handler: (message: any) => void): void {
  const port = parentPort();
  if (port) {
    port.on("message", (event) => handler(event?.data));
    return;
  }
  process.on("message", handler);
}

export function sendToParent(message: unknown): void {
  const port = parentPort();
  if (port) {
    try { port.postMessage(message); } catch {}
    return;
  }
  try { process.send?.(message); } catch {}
}
