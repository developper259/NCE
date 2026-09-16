const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = { window: {} };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../src/js/agent/utils/AgentPath.js"), "utf8"),
  context,
);
const AgentPath = context.window.AgentPath;

test("AgentPath.isInside honors normalized path boundaries", () => {
  for (const [candidate, parent] of [
    ["/foo/bar", "/foo/bar"],
    ["/foo/bar/a.js", "/foo/bar"],
    ["/foo/bar/sub/a.js", "/foo/bar/"],
    ["/foo/./bar/sub/../a.js", "/foo/bar"],
    ["tmp", "tmp/"],
    ["tmp/a.js", "./tmp"],
    ["/foo", "/"],
  ]) assert.equal(AgentPath.isInside(candidate, parent), true, candidate);

  for (const [candidate, parent] of [
    ["/foo/bar2/a.js", "/foo/bar"],
    ["/foo/other/a.js", "/foo/bar"],
    ["tmp2/a.js", "tmp"],
    ["", "/foo"],
  ]) assert.equal(AgentPath.isInside(candidate, parent), false, candidate);
});

test("AgentPath.isInside compares Windows paths without case or separator sensitivity", () => {
  for (const candidate of [
    "C:/Project/Tmp",
    "c:/project/tmp/a.js",
    "C:\\PROJECT\\TMP\\sub\\a.js",
    "C:/Project/Tmp/./sub/../a.js",
  ]) assert.equal(AgentPath.isInside(candidate, "C:\\Project\\Tmp\\"), true, candidate);
  assert.equal(AgentPath.isInside("c:/project/a.js", "C:/"), true);
  assert.equal(AgentPath.isInside("C:/Project/Tmp2/a.js", "c:/project/tmp"), false);
  assert.equal(AgentPath.isInside("D:/Project/Tmp/a.js", "C:/Project/Tmp"), false);
});
