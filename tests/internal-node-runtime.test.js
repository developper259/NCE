"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const {
  resolveInternalNodeRuntime,
  internalNodeRuntimePath,
  INTERNAL_NODE_VERSION,
} = require("../dist/ts/runtime/InternalNodeRuntime.js");
const config = require("../scripts/internal-node-config.cjs");

const root = path.resolve(__dirname, "..");

function stagedRuntime() {
  return path.join(root, "resources", config.RESOURCE_DIR, config.VERSION);
}

test("the build config pins one version shared with the runtime service", () => {
  assert.equal(config.VERSION, INTERNAL_NODE_VERSION);
  assert.ok(/^\d+\.\d+\.\d+$/.test(config.VERSION));
  for (const key of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
    const entry = config.getDistribution(...key.split("-"));
    assert.match(entry.checksum, /^[a-f0-9]{64}$/, `${key} must pin a SHA-256`);
    assert.ok(entry.size > 0, `${key} must pin a size`);
    assert.match(entry.url, new RegExp(`v${config.VERSION}`));
  }
});

test("the config rejects an unsupported platform", () => {
  assert.throws(() => config.getDistribution("freebsd", "x64"), /No embedded Node.js/);
});

test("runtime resolution reports a missing binary explicitly", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nce-runtime-empty-"));
  try {
    await assert.rejects(
      resolveInternalNodeRuntime({ resourcesPath: empty }),
      /internal Node\.js runtime is unavailable/,
    );
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("runtime resolution rejects a non-executable binary on POSIX", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nce-runtime-mode-"));
  try {
    const dir = path.join(tmp, config.RESOURCE_DIR, config.VERSION);
    fs.mkdirSync(dir, { recursive: true });
    const binary = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    fs.writeFileSync(binary, "not a node binary");
    fs.chmodSync(binary, 0o644);
    await assert.rejects(
      resolveInternalNodeRuntime({ resourcesPath: tmp, platform: "darwin" }),
      /not executable/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runtime resolution handles resource paths with spaces and special characters", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nce runtime [test] "));
  try {
    const dir = path.join(base, config.RESOURCE_DIR, config.VERSION);
    fs.mkdirSync(dir, { recursive: true });
    const binary = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    fs.writeFileSync(binary, "stub");
    fs.chmodSync(binary, 0o755);
    const info = await resolveInternalNodeRuntime({ resourcesPath: base });
    assert.equal(info.executable, binary);
    assert.equal(info.source, "development");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("development resolves the binary next to the app, packaged uses resourcesPath", async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nce-app-root-"));
  try {
    const dir = path.join(appRoot, "resources", config.RESOURCE_DIR, config.VERSION);
    fs.mkdirSync(dir, { recursive: true });
    const binary = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    fs.writeFileSync(binary, "stub");
    fs.chmodSync(binary, 0o755);

    const dev = await resolveInternalNodeRuntime({ appPath: appRoot, isPackaged: false });
    assert.equal(dev.executable, binary);
    assert.equal(dev.source, "development");

    await assert.rejects(
      resolveInternalNodeRuntime({ appPath: appRoot, isPackaged: true, resourcesPath: "/nonexistent" }),
      /does not exist/,
    );
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test("runtime path stays inside resources and never consults PATH", () => {
  const resources = "/opt/nce/resources";
  const expected = path.join(
    resources,
    "internal-node",
    config.VERSION,
    process.platform === "win32" ? "node.exe" : "node",
  );
  assert.equal(internalNodeRuntimePath({ resourcesPath: resources }), expected);
  assert.ok(expected.startsWith(resources + path.sep));
});

test("the staged runtime executes an independent script with piped stdio", () => {
  const dir = stagedRuntime();
  if (!fs.existsSync(path.join(dir, process.platform === "win32" ? "node.exe" : "node"))) {
    // The binary is staged by npm run build:internal-node, not by typecheck.
    return;
  }
  const script = path.join(os.tmpdir(), `nce-runtime-probe-${process.pid}.cjs`);
  fs.writeFileSync(
    script,
    'process.stdin.setEncoding("utf8");let s="";' +
      'process.stdin.on("data",(c)=>{s+=c;if(s.includes("\\n")){process.stdout.write("ECHO:"+s.trim()+"\\n");process.exit(0);}});' +
      'process.stdout.write("READY\\n");',
  );
  try {
    const child = spawnSync(
      path.join(dir, process.platform === "win32" ? "node.exe" : "node"),
      [script],
      { input: "ping\n", encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /READY/);
    assert.match(child.stdout, /ECHO:ping/);
  } finally {
    fs.rmSync(script, { force: true });
  }
});

test("the staged runtime reports its pinned version", () => {
  const dir = stagedRuntime();
  const binary = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
  if (!fs.existsSync(binary)) return;
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `v${config.VERSION}`);
  assert.ok(fs.existsSync(path.join(dir, "LICENSE")), "Node license must ship with the binary");
});
