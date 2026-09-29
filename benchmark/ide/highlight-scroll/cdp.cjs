class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
    socket.addEventListener("error", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP websocket error"));
      }
      this.pending.clear();
    });
  }

  static async connect(url, timeoutMs = 10000) {
    if (typeof WebSocket !== "function") throw new Error("Node.js WebSocket support is required");
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chromium DevTools")), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to Chromium DevTools")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("CDP connection is not open"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 15000) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: true,
    }, timeoutMs);
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "Renderer evaluation failed");
    }
    return response.result?.value;
  }

  async initialize() {
    await Promise.all([
      this.send("Runtime.enable"),
      this.send("Page.enable"),
      this.send("Performance.enable"),
    ]);
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

module.exports = { CdpClient };
