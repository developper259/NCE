const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");

function configurableActions() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(root, "src/config/Application.js"), "utf8")}
     this.actions = USERCONFIG_KEYBINDING
       .filter((binding) => binding.description)
       .map((binding) => binding.action);`,
    context,
  );
  return Array.from(context.actions).sort();
}

test("renderer and native application menus expose every user-facing action", () => {
  const expected = configurableActions();
  const TitleBar = loadGlobal("src/js/addon/TitleBar.js", "TitleBar");
  const titleBar = Object.create(TitleBar.prototype);
  const titleBarActions = Array.from(
    titleBar.menuDefinitions
      .flatMap((menu) => menu.items)
      .filter(Boolean)
      .map((item) => item[1])
      .filter((action) => expected.includes(action)),
  ).sort();

  const nativeMenuSource = fs.readFileSync(
    path.join(root, "src/ts/addon/Menu.ts"),
    "utf8",
  );
  const nativeActions = [
    ...nativeMenuSource.matchAll(/this\.getAccelerator\("([^"]+)"\)/g),
  ]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(titleBarActions, expected);
  assert.deepEqual(nativeActions, expected);
  assert.match(nativeMenuSource, /id:\s*"unselect-all"/);
  assert.match(nativeMenuSource, /"unselect-all",/);
});
