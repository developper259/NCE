const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler(event);
    },
    count(type) {
      return listeners.get(type)?.length || 0;
    },
  };
}

test("Events init binds native handlers once and resyncs focus safely", () => {
  const document = createEventTarget();
  const window = createEventTarget();
  document.visibilityState = "hidden";
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document,
    window,
    requestAnimationFrame(callback) {
      callback();
    },
  });
  let focusResyncs = 0;
  const editor = {
    tabManager: {
      scheduleFocusResync() {
        focusResyncs++;
      },
    },
    onClick() {},
  };
  const events = new Events(editor);

  assert.equal(document.count("click"), 0);
  assert.equal(window.count("resize"), 0);
  events.init();
  events.init();

  assert.equal(document.count("click"), 1);
  assert.equal(document.count("visibilitychange"), 1);
  assert.equal(window.count("resize"), 1);
  assert.equal(window.count("focus"), 1);

  window.dispatch("focus");
  document.dispatch("visibilitychange");
  assert.equal(focusResyncs, 1);

  document.visibilityState = "visible";
  document.dispatch("visibilitychange");
  assert.equal(focusResyncs, 2);
});
