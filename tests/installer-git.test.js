"use strict";

const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Installer } = require("../dist/ts/installer/Installer.js");
const { tempDir } = require("./helpers/installer.js");

const networkSkip = process.env.NCE_INSTALLER_NETWORK === "1"
  ? false
  : "set NCE_INSTALLER_NETWORK=1 to download the real Git distribution";

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${executable} exited with ${code}`))));
  });
}

test("Installer installs the real Git package and reuses it on second call", { skip: networkSkip, timeout: 600000 }, async () => {
  const root = await tempDir("nce-installer-git-");
  try {
    const installer = new Installer({ userDataPath: root });
    const progress = [];
    const result = await installer.install("git", { onProgress: (event) => progress.push(event) });
    assert.equal(result.success, true, result.error);
    assert.equal(result.packageId, "git");
    assert.equal(result.installDir, path.join(root, "tools", "git", result.version));
    const version = await run(result.executable, ["--version"]);
    assert.match(version, /git version 2\.56\.1/);
    assert.ok(progress.some((event) => event.step === "download" && event.percent === 100));

    const again = await installer.install("git");
    assert.equal(again.success, true, again.error);
    assert.equal(again.alreadyInstalled, true);
    assert.equal(again.executable, result.executable);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});