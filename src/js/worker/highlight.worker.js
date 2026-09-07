let ws = null;
const pendingRequests = new Map();
let connectionPromise = null;
let endpoint = null;
let reconnectTimer = null;
let hasConnected = false;
let reconnectDelay = 500;
const requestTimeoutMs = 10000;

function configure(nextEndpoint) {
  endpoint = nextEndpoint;
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (ws && ws.readyState === WebSocket.CONNECTING) return connectionPromise;
  return connectWebSocket();
}

function connectWebSocket() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return connectionPromise;
  }

  connectionPromise = new Promise((resolve, reject) => {
    if (!endpoint) throw new Error("NSH endpoint is not configured");
    ws = new WebSocket(`ws://${endpoint.host}:${endpoint.port}`);

    ws.onopen = () => {

      if (hasConnected) self.postMessage({ type: "sessionReset" });
      hasConnected = true;
      reconnectDelay = 500;
      resolve();
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const pending = pendingRequests.get(data.id);

      if (pending) {
        clearTimeout(pending.timeout);
        if (data.success) {
          pending.resolve(data);
        } else {
          pending.reject(new Error(data.error));
        }
        pendingRequests.delete(data.id);
      }
    };

    ws.onerror = (error) => {
      console.error("🔴 Worker : Erreur WebSocket", error);
      reject(error);
    };

    ws.onclose = () => {
      reject(new Error("NSH WebSocket closed"));
      self.postMessage({ type: "sessionLost" });
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("NSH WebSocket closed"));
      }
      pendingRequests.clear();
      connectionPromise = null;

      ws = null;
      if (!reconnectTimer && endpoint) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWebSocket().catch(() => {});
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 4000);
      }
    };
  });

  return connectionPromise;
}

async function sendToServer(payload) {
  await connectWebSocket();

  const requestId =
    Date.now().toString() + Math.random().toString(36).substring(2, 9);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`NSH worker request timed out: ${payload.requestType}`));
    }, requestTimeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timeout });

    ws.send(
      JSON.stringify({
        id: requestId,
        ...payload,
      }),
    );
  });
}

self.onmessage = async (event) => {
  const { taskId, taskName, data } = event.data;

  try {
    if (taskName === "configure") {
      await configure(data.endpoint);
      self.postMessage({ taskId, result: true });
      return;
    }
    let result;

    switch (taskName) {
      case "highlight": {
        const { code, language, responseType, options } = data;

        result = await sendToServer({
          requestType: "highlight",
          code,
          language,
          responseType: responseType || "tokens",
          options,
        });

        break;
      }

      case "highlightLine": {
        const {
          code,
          language,
          initialState,
          lineIndex,
          responseType,
          options,
        } = data;

        result = await sendToServer({
          requestType: "highlightLine",
          code,
          language,
          initialState,
          lineIndex,
          responseType: responseType || "tokens",
          options,
        });

        break;
      }

      case "supportedLanguages": {
        result = await sendToServer({
          requestType: "supportedLanguages",
        });

        break;
      }

      case "detectLanguage": {
        const { fileName } = data;

        result = await sendToServer({
          requestType: "detectLanguage",
          fileName,
        });

        break;
      }

      case "openDocument":
      case "updateDocument":
      case "getDocumentLines":
      case "closeDocument": {
        result = await sendToServer({
          requestType: taskName,
          ...data,
        });
        break;
      }

      default:
        throw new Error(`Tâche inconnue dans le worker : ${taskName}`);
    }

    self.postMessage({ taskId, result });
  } catch (error) {
    self.postMessage({
      taskId,
      error: error.message || "Erreur inconnue dans le worker",
    });
  }
};
