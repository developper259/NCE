class NSHClient {
  constructor(editor) {
    this.editor = editor;
    this.worker = new Worker("../js/worker/highlight.worker.js");
    this.pendingRequests = new Map();
    this.requestCounter = 0;
    this.timeoutMs = 8000;
    this.disposed = false;
    this.onSessionReset = null;
    this.ready = this.configure();

    this.worker.onmessage = (event) => {
      const { taskId, result, error } = event.data;
      if (event.data.type === "sessionReset") {
        this.onSessionReset?.();
        return;
      }
      if (event.data.type === "sessionLost") return;
      const pending = this.pendingRequests.get(taskId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(taskId);
      if (error) pending.reject(new Error(error));
      else pending.resolve(result);
    };

    this.worker.onerror = (error) => {
      this.rejectPending(
        error.error || new Error(error.message || "NSH worker failed"),
      );
    };
  }

  async configure() {
    const endpoint = await this.editor.api.getNshEndpoint();
    if (!endpoint) throw new Error("NSH server is unavailable");
    return this.request("configure", { endpoint }, false);
  }

  request(taskName, data = {}, waitForReady = true) {
    if (this.disposed)
      return Promise.reject(new Error("NSH client is disposed"));

    const send = () =>
      new Promise((resolve, reject) => {
        const taskId = `nsh-${Date.now()}-${this.requestCounter++}`;
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(taskId);
          reject(new Error(`NSH request timed out: ${taskName}`));
        }, this.timeoutMs);

        this.pendingRequests.set(taskId, { resolve, reject, timeout });
        this.worker.postMessage({ taskId, taskName, data });
      });

    return (waitForReady ? this.ready : Promise.resolve()).then(send);
  }

  rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(new Error("NSH client disposed"));
    this.worker.terminate();
  }
}
