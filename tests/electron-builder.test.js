const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const beforeBuild = require("../scripts/electron-before-build.js").default;

test("electron-builder skips only a prepared same-architecture Windows node-pty rebuild", async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "nce-electron-build-"));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const releaseDirectory = path.join(appDir, "node_modules", "node-pty", "build", "Release");
  const context = {
    platform: { nodeName: "win32" },
    arch: process.arch,
    appDir,
  };

  assert.equal(await beforeBuild(context), true, "missing runtime files leave builder rebuilding enabled");
  for (const file of [
    "conpty.node",
    path.join("conpty", "conpty.dll"),
    path.join("conpty", "OpenConsole.exe"),
  ]) {
    const target = path.join(releaseDirectory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "prepared");
  }

  assert.equal(await beforeBuild(context), false, "a prepared Windows native runtime is kept intact");
  const otherArch = process.arch === "arm64" ? "x64" : "arm64";
  assert.equal(await beforeBuild({ ...context, arch: otherArch }), true,
    "cross-architecture builds still use electron-builder's native rebuild");
  assert.equal(await beforeBuild({ ...context, platform: { nodeName: "darwin" } }), true,
    "other platforms keep electron-builder's normal rebuild behavior");
});
