"use strict";

const assert = require("node:assert");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { serve, staticRoute, tempDir } = require("./helpers/installer.js");
const {
  toolFixture,
  toolDistribution,
  managedTool,
  createManager,
  memorySettings,
} = require("./helpers/version-manager.js");

async function withServer(fixture, run) {
  const server = await serve({ "/tool.tar.gz": staticRoute(fixture.body) });
  try {
    return await run(`${server.origin}/tool.tar.gz`);
  } finally {
    await server.close();
  }
}

test("PackageManager installs a package, records the real version and emits events", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture("1.2.3");
  try {
    await withServer(fixture, async (url) => {
      const settings = memorySettings({ "tool.path": "" });
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, fixture.checksum) },
        managed: [managedTool("tool", "1.2.3", { managedSettings: ["tool.path"] })],
        settings,
      });
      const events = [];
      const unsubscribe = manager.subscribe((event) => events.push(event));
      await manager.initialize();

      const result = await manager.install("tool");
      assert.equal(result.success, true, result.error);
      assert.equal(result.source.url, url);

      const state = manager.getState();
      const pkg = state.packages.find((p) => p.id === "tool");
      assert.equal(pkg.state, "installed");
      assert.equal(pkg.installations.length, 1);
      assert.equal(pkg.installations[0].version, "1.2.3", "version parsed from verification stdout");
      assert.equal(pkg.installations[0].provenance, "managed");
      assert.equal(pkg.installations[0].source.checksum, fixture.checksum);
      assert.equal(settings.values["tool.path"], result.executable, "empty managed setting adopts the build");

      assert.ok(events.some((e) => e.type === "operation" && e.operation.kind === "install" && e.operation.state === "running"));
      assert.ok(events.some((e) => e.type === "operation" && e.operation.progress?.percent === 100));
      assert.ok(events.some((e) => e.type === "operation" && e.operation.state === "completed"));
      assert.ok(events.some((e) => e.type === "inventory-changed"));
      unsubscribe();
      const before = events.length;
      manager.getState();
      assert.equal(events.length, before, "unsubscribe stops events");
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager reports a failed settings write instead of a successful install", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture("1.2.3");
  try {
    await withServer(fixture, async (url) => {
      const settings = memorySettings({ "tool.path": "" });
      settings.set = async () => false;
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, fixture.checksum) },
        managed: [managedTool("tool", "1.2.3", { managedSettings: ["tool.path"] })],
        settings,
      });
      const events = [];
      manager.subscribe((event) => events.push(event));
      await manager.initialize();

      const result = await manager.install("tool");
      assert.equal(result.success, false);
      assert.equal(result.code, "SETTINGS_UPDATE_FAILED");
      assert.ok(
        events.some((event) => event.type === "operation" &&
          event.operation.state === "failed" && event.operation.error?.code === "SETTINGS_UPDATE_FAILED"),
        "the operation event carries the failure code",
      );
      assert.ok(
        !events.some((event) => event.type === "inventory-changed"),
        "no inventory change is announced for a failed operation",
      );
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager reconciles a pre-existing installation without reinstalling", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture("9.9.9");
  try {
    await withServer(fixture, async (url) => {
      const distributions = { tool: toolDistribution(url, fixture.checksum, "tool", "1.2.3") };
      const managed = [managedTool("tool", "1.2.3")];
      // First manager installs an older build, then a fresh manager (new inventory) must import it.
      const first = createManager(userDataPath, { distributions, managed });
      await first.manager.initialize();
      const installed = await first.manager.install("tool");
      assert.equal(installed.success, true);

      const second = createManager(userDataPath, { distributions, managed });
      await second.manager.initialize();
      const pkg = second.manager.getState().packages.find((p) => p.id === "tool");
      assert.equal(pkg.state, "installed");
      assert.equal(pkg.installations.length, 1);
      assert.equal(pkg.installations[0].installDir, installed.installDir);
      assert.ok(pkg.installations[0].installedAt > 0, "installedAt recovered from the directory");
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager recovers an install interrupted at commit time", async () => {
  const userDataPath = await tempDir("nce-pm-crash-");
  const fixture = await toolFixture("1.2.3");
  try {
    await withServer(fixture, async (url) => {
      const distributions = { tool: toolDistribution(url, fixture.checksum) };
      const managed = [managedTool("tool", "1.2.3")];
      const first = createManager(userDataPath, { distributions, managed });
      await first.manager.initialize();
      const installed = await first.manager.install("tool");
      assert.equal(installed.success, true);

      // Simulate a crash after `rename(destination, backup)` but before the
      // validated replacement was moved into place.
      const staging = path.join(userDataPath, "tools", ".staging-tool-interrupted");
      await fs.mkdir(staging, { recursive: true });
      await fs.rename(installed.installDir, path.join(staging, "previous"));
      await first.store.remove(first.store.listByPackage("tool")[0].id);

      const second = createManager(userDataPath, { distributions, managed });
      await second.manager.initialize();
      const pkg = second.manager.getState().packages.find((p) => p.id === "tool");
      assert.equal(pkg.state, "installed", "the previous working install must be restored");
      assert.equal(pkg.installations.length, 1);
      assert.equal(pkg.installations[0].installDir, installed.installDir);
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager uninstalls, clears managed settings and preserves external choices", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture();
  try {
    await withServer(fixture, async (url) => {
      const settings = memorySettings({ "tool.path": "" });
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, fixture.checksum) },
        managed: [managedTool("tool", "1.2.3", { managedSettings: ["tool.path"] })],
        settings,
      });
      await manager.initialize();
      const installed = await manager.install("tool");
      const installationId = manager.getState().packages[0].installations[0].id;

      const removed = await manager.uninstall(installationId);
      assert.equal(removed.success, true, removed.error);
      assert.equal(await fs.stat(installed.installDir).then(() => true, () => false), false);
      assert.equal(manager.getState().packages[0].installations.length, 0);
      assert.equal(manager.getState().packages[0].state, "not-installed");
      assert.equal(settings.values["tool.path"], "", "managed setting cleared after uninstall");
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager never overrides or clears an explicit external setting", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture();
  try {
    await withServer(fixture, async (url) => {
      const external = path.join(path.sep, "usr", "bin", "external-tool");
      const settings = memorySettings({ "tool.path": external });
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, fixture.checksum) },
        managed: [managedTool("tool", "1.2.3", { managedSettings: ["tool.path"] })],
        settings,
      });
      await manager.initialize();
      const installed = await manager.install("tool");
      assert.equal(settings.values["tool.path"], external, "external choice preserved on install");
      const installationId = manager.getState().packages[0].installations[0].id;
      await manager.uninstall(installationId);
      assert.equal(settings.values["tool.path"], external, "external choice preserved on uninstall");
      assert.equal(await fs.stat(installed.installDir).then(() => true, () => false), false);
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager does not record a failed installation and reports the failure", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture();
  try {
    await withServer(fixture, async (url) => {
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, "0".repeat(64)) },
        managed: [managedTool()],
      });
      await manager.initialize();
      const result = await manager.install("tool");
      assert.equal(result.success, false);
      assert.equal(result.code, "CHECKSUM_MISMATCH");
      const pkg = manager.getState().packages[0];
      assert.equal(pkg.installations.length, 0);
      assert.equal(pkg.state, "failed");
      assert.equal(pkg.lastError.code, "CHECKSUM_MISMATCH");
      assert.deepEqual(await fs.readdir(path.join(userDataPath, "tools")).catch(() => []), [], "staging cleaned");
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager marks a broken installation corrupted and drops a vanished one", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture();
  try {
    await withServer(fixture, async (url) => {
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, fixture.checksum) },
        managed: [managedTool()],
      });
      await manager.initialize();
      const installed = await manager.install("tool");

      await fs.rm(installed.executable, { force: true });
      await manager.refresh();
      let pkg = manager.getState().packages[0];
      assert.equal(pkg.state, "corrupted");
      assert.equal(pkg.installations[0].state, "corrupted");
      assert.ok(pkg.installations[0].error, "corruption keeps an exploitable error");

      await fs.rm(installed.installDir, { recursive: true, force: true });
      await manager.refresh();
      pkg = manager.getState().packages[0];
      assert.equal(pkg.installations.length, 0, "vanished installation is dropped");
      assert.equal(pkg.state, "not-installed");
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager verify re-validates an installation", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture("3.0.0");
  try {
    await withServer(fixture, async (url) => {
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, fixture.checksum) },
        managed: [managedTool()],
      });
      await manager.initialize();
      await manager.install("tool");
      const installationId = manager.getState().packages[0].installations[0].id;
      const verified = await manager.verify(installationId);
      assert.equal(verified.success, true);
      assert.equal(verified.installation.state, "installed");
      assert.equal(verified.installation.version, "3.0.0");
      assert.ok(verified.installation.verifiedAt > 0);
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager guards concurrent operations on the same package", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture();
  const server = await serve({
    "/tool.tar.gz": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fixture.body.length + 4096 });
      res.write(fixture.body.subarray(0, 8));
    },
  });
  try {
    const url = `${server.origin}/tool.tar.gz`;
    const { manager } = createManager(userDataPath, {
      distributions: { tool: toolDistribution(url, fixture.checksum) },
      managed: [managedTool()],
    });
    await manager.initialize();
    const first = manager.install("tool");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await manager.install("tool");
    assert.equal(busy.success, false);
    assert.equal(busy.code, "OPERATION_BUSY");
    assert.equal(manager.cancel("tool"), true);
    const cancelled = await first;
    assert.equal(cancelled.success, false);
    assert.equal(cancelled.code, "CANCELLED");
    assert.equal(manager.getState().packages[0].installations.length, 0);
  } finally {
    await server.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("PackageManager rejects unknown packages and installations", async () => {
  const userDataPath = await tempDir("nce-pm-");
  try {
    const { manager } = createManager(userDataPath, {
      distributions: {},
      managed: [managedTool()],
    });
    await manager.initialize();
    assert.equal((await manager.install("missing")).code, "PACKAGE_NOT_FOUND");
    assert.equal((await manager.uninstall("missing")).code, "INSTALLATION_NOT_FOUND");
    assert.equal((await manager.verify("missing")).code, "INSTALLATION_NOT_FOUND");
    assert.equal(manager.cancel("missing"), false);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test("PackageManager reports unknown state for an unsupported platform", async () => {
  const userDataPath = await tempDir("nce-pm-");
  const fixture = await toolFixture();
  try {
    await withServer(fixture, async (url) => {
      const { manager } = createManager(userDataPath, {
        distributions: { tool: toolDistribution(url, fixture.checksum) },
        managed: [managedTool("tool", "1.2.3", { platforms: ["win32", "linux", "darwin"].filter((p) => p !== process.platform) })],
      });
      await manager.initialize();
      const installed = await manager.install("tool");
      assert.equal(installed.success, false);
      assert.equal(installed.code, "UNSUPPORTED_PLATFORM");
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});