const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal, root } = require("./helpers/runtime");

class ObserverStub {
  observe() {}
  disconnect() {}
}

test("SettingsScroller scrolls settings content without using its navigation", () => {
  const created = [];
  const viewport = {};
  const content = { scrollTop: 120, clientHeight: 300, scrollHeight: 900 };
  const editor = {
    domManager: {
      getElementMetrics(element) {
        return {
          scrollTop: element.scrollTop || 0,
          clientHeight: element.clientHeight || 0,
          scrollHeight: element.scrollHeight || 0,
        };
      },
    },
    scrollerManager: {
      VERTICAL_TYPE: 0,
      createScroller(parent, type, isBody) {
        const scroller = {
          parentOBJ: parent,
          type,
          isBody,
          wheelTarget: null,
          ratio: 0,
          setScrollRatio(value) { this.ratio = value; },
          refreshMetrics() {},
          refresh() {},
        };
        created.push(scroller);
        return scroller;
      },
      addScroller() {},
    },
  };
  const SettingsScroller = loadGlobal(
    "src/js/scrollers/Settings.Scroller.js",
    "SettingsScroller",
    { MutationObserver: ObserverStub, ResizeObserver: ObserverStub },
  );
  const settingsScroller = new SettingsScroller(editor, viewport, content);
  settingsScroller.init();

  assert.equal(created[0].parentOBJ, viewport);
  assert.equal(created[0].wheelTarget, content);
  assert.equal(created[0].calcIsActive(), true);
  assert.ok(Math.abs(created[0].calculProp() - 100 / 3) < 0.000001);
  assert.equal(created[0].ratio, 0.2);

  created[0].onScroll(0.5);
  assert.equal(content.scrollTop, 300);
});

test("SettingsView installs its dedicated scroller on layout and content only", () => {
  const source = fs.readFileSync(
    path.join(root, "src/js/view/SettingsView.js"),
    "utf8",
  );
  const css = fs.readFileSync(path.join(root, "src/css/settings.css"), "utf8");

  assert.match(
    source,
    /new SettingsScroller\(\s*this\.editor,\s*this\.layout,\s*this\.content,/,
  );
  assert.doesNotMatch(source, /new SidebarScroller/);
  assert.match(css, /\.settings-layout\s*\{[^}]*position: relative;/s);
  assert.match(css, /\.settings-layout\s*\{[^}]*overflow: hidden;/s);
  assert.match(css, /\.settings-content\s*\{[^}]*overflow-y: auto;/s);
});

test("SidebarScroller can drive the right Agent messages viewport", () => {
  const created = [];
  const listeners = new Map();
  const viewport = {};
  const content = {
    scrollTop: 150,
    clientHeight: 300,
    scrollHeight: 900,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const editor = {
    domManager: {
      getElementMetrics(element) {
        return {
          scrollTop: element.scrollTop || 0,
          clientHeight: element.clientHeight || 0,
          scrollHeight: element.scrollHeight || 0,
        };
      },
    },
    scrollerManager: {
      VERTICAL_TYPE: 0,
      createScroller(parent, type, isBody) {
        const scroller = {
          parentOBJ: parent,
          type,
          isBody,
          wheelTarget: null,
          ratio: 0,
          setScrollRatio(value) { this.ratio = value; },
          refreshMetrics() {},
          refresh() {},
        };
        created.push(scroller);
        return scroller;
      },
      addScroller() {},
    },
  };
  const SidebarScroller = loadGlobal(
    "src/js/scrollers/Sidebar.Scroller.js",
    "SidebarScroller",
    { MutationObserver: ObserverStub, ResizeObserver: ObserverStub },
  );
  const scroller = new SidebarScroller(editor, viewport, content);
  scroller.init();

  assert.equal(created[0].parentOBJ, viewport);
  assert.equal(created[0].wheelTarget, content);
  assert.equal(created[0].calcIsActive(), true);
  assert.equal(created[0].ratio, 0.25);
  assert.equal(listeners.has("scroll"), true);
  created[0].onScroll(0.5);
  assert.equal(content.scrollTop, 300);
  scroller.destroy();
  assert.equal(listeners.has("scroll"), false);
});

test("Agent sidebar bounds SidebarScroller to the messages viewport", () => {
  const source = fs.readFileSync(
    path.join(root, "src/js/sidebar/Agent.Sidebar.js"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(root, "src/html/index.html"),
    "utf8",
  );
  assert.match(source, /new SidebarScroller\(/);
  assert.match(source, /new SidebarScroller\(\s*this\.editor,\s*messagesViewport,\s*messages,/);
  assert.match(source, /sidebarManager\.rightScroller\s*=\s*this\.messagesScroller/);
  assert.match(source, /messagesElement\.scrollTop\s*=\s*this\.messagesElement\.scrollHeight/);
  assert.match(source, /vScroller\?\.setScrollRatio\(1\)/);
  assert.match(source, /this\.refresh\(\);\s*this\.scrollMessagesToBottom\(\);\s*this\.focusInput\(\);/s);
  assert.match(html, /js\/scrollers\/Sidebar\.Scroller\.js/);
  assert.doesNotMatch(html, /RightSidebar\.Scroller/);

  const css = fs.readFileSync(
    path.join(root, "src/css/sidebar/agent.css"),
    "utf8",
  );
  assert.match(css, /\.agent-sidebar-messages-viewport\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.agent-sidebar-messages-viewport\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.agent-sidebar-messages\s*\{[^}]*scrollbar-width:\s*none/s);
  assert.doesNotMatch(css, /\.agent-sidebar-messages\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.agent-sidebar-messages::\-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.agent-sidebar-markdown pre\s*\{[^}]*white-space:\s*pre-wrap/s);
  assert.doesNotMatch(css, /\.agent-sidebar-markdown pre\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.agent-sidebar-markdown table\s*\{[^}]*table-layout:\s*fixed/s);
});
