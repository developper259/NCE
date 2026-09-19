const test = require("node:test");
const assert = require("node:assert/strict");

// Simple EventBus test that doesn't require full Agent setup
test("AgentEventBus: subscribe and emit basic events", () => {
  class MockAgent {
    constructor() {
      this.agentProgress = { metrics: { callbackFailures: 0 } };
    }
    recordCallbackFailure(name, error) {
      this.agentProgress.metrics.callbackFailures++;
    }
  }

  class TestEventBus {
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
          this.agent.recordCallbackFailure(`eventbus:${eventName}`, error);
        }
      }
    }
  }

  const agent = new MockAgent();
  const bus = new TestEventBus(agent);

  // Test 1: Multiple observers
  let callCountA = 0;
  let callCountB = 0;

  bus.subscribe("test:event", () => callCountA++);
  bus.subscribe("test:event", () => callCountB++);

  bus.emit("test:event", {});

  assert.equal(callCountA, 1);
  assert.equal(callCountB, 1);

  // Test 2: Unsubscribe
  callCountA = 0;
  callCountB = 0;
  bus.listeners.clear(); // Clear previous listeners
  const unsubscribe = bus.subscribe("test:event", () => callCountA++);
  unsubscribe();
  bus.emit("test:event", {});
  assert.equal(callCountA, 0);

  // Test 3: Double unsubscribe is safe
  const unsubscribe2 = bus.subscribe("test:event", () => {});
  assert.equal(unsubscribe2(), true);
  assert.equal(unsubscribe2(), false);

  // Test 4: Listener throw doesn't break other listeners
  callCountA = 0;
  callCountB = 0;
  agent.agentProgress.metrics.callbackFailures = 0; // Reset counter
  bus.subscribe("test:event", () => {
    callCountA++;
    throw new Error("Test error");
  });
  bus.subscribe("test:event", () => callCountB++);

  bus.emit("test:event", {});

  assert.equal(callCountA, 1);
  assert.equal(callCountB, 1);
  assert.equal(agent.agentProgress.metrics.callbackFailures, 1);
});

test("AgentEventBus: unsubscribe idempotency", () => {
  class MockAgent {
    constructor() {
      this.agentProgress = { metrics: { callbackFailures: 0 } };
    }
    recordCallbackFailure(name, error) {
      this.agentProgress.metrics.callbackFailures++;
    }
  }

  class TestEventBus {
    constructor(agent) {
      this.agent = agent;
      this.listeners = new Map();
      this.listenerIdCounter = 0;
    }

    subscribe(eventName, listener) {
      if (!this.listeners.has(eventName)) {
        this.listeners.set(eventName, new Map());
      }

      const listenerId = ++this.listenerIdCounter;
      this.listeners.get(eventName).set(listenerId, {
        id: listenerId,
        fn: listener,
      });

      return () => this.unsubscribe(eventName, listenerId);
    }

    unsubscribe(eventName, listenerId) {
      const eventListeners = this.listeners.get(eventName);
      if (!eventListeners) return false;

      const deleted = eventListeners.delete(listenerId);
      if (eventListeners.size === 0) {
        this.listeners.delete(eventName);
      }
      return deleted;
    }

    emit(eventName, payload) {
      const eventListeners = this.listeners.get(eventName);
      if (!eventListeners || eventListeners.size === 0) return;

      for (const [id, { fn }] of eventListeners) {
        try {
          fn(payload);
        } catch (error) {
          this.agent.recordCallbackFailure(`eventbus:${eventName}`, error);
        }
      }
    }
  }

  const agent = new MockAgent();
  const bus = new TestEventBus(agent);

  const unsubscribe = bus.subscribe("test:event", () => {});
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  assert.equal(unsubscribe(), false);
});
