class AgentEventBus {
  constructor(agent) {
    this.agent = agent;
    this.listeners = new Map();
    this.listenerIdCounter = 0;
  }

  subscribe(eventName, listener) {
    if (typeof eventName !== "string" || !eventName.trim()) {
      throw new TypeError("eventName doit être une chaîne non vide.");
    }
    if (typeof listener !== "function") {
      throw new TypeError("listener doit être une fonction.");
    }

    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Map());
    }

    const listenerId = ++this.listenerIdCounter;
    this.listeners.get(eventName).set(listenerId, {
      id: listenerId,
      fn: listener,
    });

    // Return unsubscribe function
    return () => this.unsubscribe(eventName, listenerId);
  }

  unsubscribe(eventName, listenerId) {
    if (typeof eventName !== "string" || !eventName.trim()) return false;
    if (typeof listenerId !== "number") return false;

    const eventListeners = this.listeners.get(eventName);
    if (!eventListeners) return false;

    const deleted = eventListeners.delete(listenerId);
    if (eventListeners.size === 0) {
      this.listeners.delete(eventName);
    }
    return deleted;
  }

  emit(eventName, payload) {
    if (typeof eventName !== "string" || !eventName.trim()) return;

    const eventListeners = this.listeners.get(eventName);
    if (!eventListeners || eventListeners.size === 0) return;

    for (const [id, { fn }] of eventListeners) {
      try {
        fn(payload);
      } catch (error) {
        // Observer failure should not break the Agent runtime
        this.agent.recordCallbackFailure(
          `eventbus:${eventName}`,
          error
        );
      }
    }
  }

  once(eventName, listener) {
    const unsubscribe = this.subscribe(eventName, (payload) => {
      unsubscribe();
      return listener(payload);
    });
    return unsubscribe;
  }

  clear() {
    this.listeners.clear();
    this.listenerIdCounter = 0;
  }

  getListenerCount(eventName) {
    return this.listeners.get(eventName)?.size || 0;
  }
}

window.AgentEventBus = AgentEventBus;
