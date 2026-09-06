class NSHClient {
  constructor(editor) {
    this.editor = editor;
    this.worker = new Worker("../js/worker/highlight.worker.js");
    this.pendingRequests = new Map();
    this.requestCounter = 0;
    this.timeoutMs = 8000;
    this.disposed = false;
    this.state = "disconnected";
    this.connectPromise = null;
    this.endpoint = null;
    this.onSessionReset = null;

    this.worker.onmessage = (event) => {
      const { taskId, result, error } = event.data;
      if (event.data.type === "sessionReset") {
        this.state = "ready";
        this.onSessionReset?.();
        return;
      }
      if (event.data.type === "sessionLost") {
        this.state = "reconnecting";
        this.rejectPending(new Error("NSH session lost"));
        return;
      }
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
      this.state = "disconnected";
    };

    this.connect().catch(() => {});
  }

  async connect() {
    if (this.disposed) throw new Error("NSH client is disposed");
    if (this.state === "ready") return;
    if (this.connectPromise) return this.connectPromise;

    this.state = this.state === "disconnected" ? "connecting" : "reconnecting";
    this.connectPromise = Promise.resolve()
      .then(() => this.editor.api.getNshEndpoint())
      .then((endpoint) => {
        if (!endpoint) throw new Error("NSH server is unavailable");
        this.endpoint = endpoint;
        return this.request("configure", { endpoint }, false);
      })
      .then(() => {
        this.state = "ready";
      })
      .catch((error) => {
        this.state = "disconnected";
        throw error;
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
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

    return (waitForReady ? this.connect() : Promise.resolve()).then(send);
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
    this.state = "disposed";
    this.connectPromise = null;
    this.rejectPending(new Error("NSH client disposed"));
    this.worker.terminate();
  }
}
