let ws = null;
const pendingRequests = new Map();
let connectionPromise = null;

function connectWebSocket(port = 8080) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return connectionPromise;
  }

  connectionPromise = new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${port}`);

    ws.onopen = () => {
      console.log("Worker : Connecté au serveur WebSocket NSH (Permanent)");
      resolve();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const pending = pendingRequests.get(data.id);

      if (pending) {
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
      console.warn("⚠️ Worker : Connexion perdue. Reconnexion automatique dans 2s...");
      ws = null;
      setTimeout(() => connectWebSocket(port), 2000);
    };
  });

  return connectionPromise;
}

// Fonction utilitaire interne pour mutualiser l'envoi de requêtes au serveur
async function sendToServer(payload, port = 8080) {
  await connectWebSocket(port);

  const requestId = Date.now().toString() + Math.random().toString(36).substring(2, 9);

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });

    ws.send(
      JSON.stringify({
        id: requestId,
        ...payload,
      })
    );
  });
}

connectWebSocket(8080);

self.onmessage = async (event) => {
  const { taskId, taskName, data } = event.data;

  try {
    let result;

    switch (taskName) {
      case 'highlight':
      case 'parse': {
        const { code, language, responseType, options } = data;
        
        result = await sendToServer({
          requestType: "highlight",
          code,
          language,
          responseType: responseType || 'tokens',
          options,
        });

        break;
      }

      case 'supportedLanguages': {
        result = await sendToServer({
          requestType: "supportedLanguages",
        });

        break;
      }

      case 'detectLanguage': {
        const { fileName } = data;

        result = await sendToServer({
          requestType: "detectLanguage",
          fileName
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
      error: error.message || 'Erreur inconnue dans le worker',
    });
  }
};