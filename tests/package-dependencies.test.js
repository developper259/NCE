"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { promises: fs } = require("node:fs");
const { test } = require("node:test");
const { serve, staticRoute, tempDir } = require("./helpers/installer.js");
const {
  toolFixture,
  toolDistribution,
  managedTool,
  createManager,
} = require("./helpers/version-manager.js");

/** Two fake packages where `app` declares `runtime` as a dependency. */
async function fixturePair() {
  const runtimeFixture = await toolFixture("1.0.0");
  const appFixture = await toolFixture("2.0.0");
  const server = await serve({
    "/runtime.tar.gz": staticRoute(runtimeFixture.body),
    "/app.tar.gz": staticRoute(appFixture.body),
  });
  const distributions = {
    runtime: toolDistribution(`${server.origin}/runtime.tar.gz`, runtimeFixture.checksum, "runtime", "1.0.0"),
    app: toolDistribution(`${server.origin}/app.tar.gz`, appFixture.checksum, "app", "2.0.0"),
  };
  const managed = [
    managedTool("runtime", "1.0.0"),
    managedTool("app", "2.0.0", { dependencies: ["runtime"] }),
  ];
  return { server, distributions, managed };
}

test("installing a package installs its declared dependency first", async () => {
  const { server, distributions, managed } = await fixturePair();
  const root = await tempDir("nce-deps-");
  const { manager, store } = createManager(root, { distributions, managed });
  try {
    await manager.initialize();
    const result = await manager.install("app");
    assert.equal(result.success, true, result.error);

    // The dependency was installed as a side effect, and recorded.
    const runtimeRecords = store.listByPackage("runtime");
    assert.equal(runtimeRecords.length, 1);
    assert.equal(runtimeRecords[0].state, "installed");
    assert.equal(store.listByPackage("app").length, 1);
  } finally {
    await manager.dispose?.();
    await server.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an already installed dependency is not installed twice", async () => {
  const { server, distributions, managed } = await fixturePair();
  const root = await tempDir("nce-deps-");
  const { manager, store } = createManager(root, { distributions, managed });
  try {
    await manager.initialize();
    assert.equal((await manager.install("runtime")).success, true);
    const before = store.listByPackage("runtime").length;

    assert.equal((await manager.install("app")).success, true);
    assert.equal(
      store.listByPackage("runtime").length,
      before,
      "the shared runtime must not be installed a second time",
    );
  } finally {
    await manager.dispose?.();
    await server.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a dependency the platform cannot run blocks the install with a reason", async () => {
  const root = await tempDir("nce-deps-");
  const managed = [
    managedTool("runtime", "1.0.0", { platforms: ["aix"] }),
    managedTool("app", "2.0.0", { dependencies: ["runtime"] }),
  ];
  const { manager, store } = createManager(root, { distributions: {}, managed });
  try {
    await manager.initialize();
    const result = await manager.install("app");
    assert.equal(result.success, false);
    assert.equal(result.code, "UNSUPPORTED_PLATFORM");
    assert.match(result.error, /requires Tool/);
    assert.equal(store.listByPackage("app").length, 0);
  } finally {
    await manager.dispose?.();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("uninstalling a runtime still needed by an installed package is refused", async () => {
  const { server, distributions, managed } = await fixturePair();
  const root = await tempDir("nce-deps-");
  const { manager, store } = createManager(root, { distributions, managed });
  try {
    await manager.initialize();
    assert.equal((await manager.install("app")).success, true);
    const runtimeId = store.listByPackage("runtime")[0].id;

    const result = await manager.uninstall(runtimeId);
    assert.equal(result.success, false);
    assert.equal(result.code, "PACKAGE_REQUIRED");
    assert.match(result.error, /still required by Tool/);
    // The installation is untouched.
    assert.equal(store.listByPackage("runtime")[0].state, "installed");
  } finally {
    await manager.dispose?.();
    await server.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the runtime becomes removable once its dependent is gone", async () => {
  const { server, distributions, managed } = await fixturePair();
  const root = await tempDir("nce-deps-");
  const { manager, store } = createManager(root, { distributions, managed });
  try {
    await manager.initialize();
    assert.equal((await manager.install("app")).success, true);

    const appId = store.listByPackage("app")[0].id;
    assert.equal((await manager.uninstall(appId)).success, true);

    const runtimeId = store.listByPackage("runtime")[0].id;
    const result = await manager.uninstall(runtimeId);
    assert.equal(result.success, true, result.error);
    assert.equal(store.listByPackage("runtime").length, 0);
  } finally {
    await manager.dispose?.();
    await server.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("removalCheck explains a refusal before the operation is attempted", async () => {
  const { server, distributions, managed } = await fixturePair();
  const root = await tempDir("nce-deps-");
  const { manager } = createManager(root, { distributions, managed });
  try {
    await manager.initialize();
    assert.equal((await manager.install("app")).success, true);

    const check = manager.removalCheck("runtime");
    assert.equal(check.allowed, false);
    assert.equal(check.requiredBy[0].packageId, "app");
    assert.match(check.reason, /still required by/);

    assert.equal(manager.removalCheck("app").allowed, true);
  } finally {
    await manager.dispose?.();
    await server.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
