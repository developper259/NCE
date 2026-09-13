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
