"use strict";

const assert = require("node:assert");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Installer } = require("../dist/ts/installer/Installer.js");
const { makeTarGz, makeZip, rawZipFixture, serve, sha256, staticRoute, tempDir } = require("./helpers/installer.js");

const NODE = process.execPath;

function definitionFor(url, checksum, overrides = {}) {
  return {
    id: "tool",
    name: "Tool",
    version: "1.0.0",
    platforms: {
      [process.platform]: {
        [process.arch]: {
          download: { url, checksum, checksumAlgorithm: "sha256" },
          archive: { format: "tar.gz", stripComponents: 0 },
          executable: "bin/tool",
        },
      },
    },
    verification: { executable: NODE, args: ["--version"] },
    ...overrides,
  };
}

function installerFor(userDataPath, definition, options = {}) {
  return new Installer({ userDataPath, registry: { tool: definition }, ...options });
}

async function fixtureArchive(entries, format = "tar.gz") {
  const dir = await tempDir("nce-installer-fixtures-");
  const file = path.join(dir, `fixture.${format === "zip" ? "zip" : "tar.gz"}`);
  if (format === "zip") await makeZip(entries, file);
  else await makeTarGz(entries, file);
  const body = await fs.readFile(file);
  return { dir, body, checksum: sha256(body) };
}

async function listing(dir) {
  return fs.readdir(dir).catch(() => []);
}

test("Installer rejects unknown packages and invalid definitions", async () => {
  const root = await tempDir();
  try {
    const installer = new Installer({ userDataPath: root, registry: {} });
    const unknown = await installer.install("missing");
    assert.equal(unknown.success, false);
    assert.equal(unknown.code, "PACKAGE_NOT_FOUND");

    const valid = definitionFor("https://example.invalid/tool.tar.gz", "a".repeat(64));
    const badChecksum = installerFor(root, { ...valid, platforms: { ...valid.platforms, [process.platform]: { [process.arch]: { ...valid.platforms[process.platform][process.arch], download: { url: "https://example.invalid/t.tar.gz", checksum: "nothex", checksumAlgorithm: "sha256" } } } } });
    assert.equal((await badChecksum.install("tool")).code, "INVALID_PACKAGE");

    const badUrl = installerFor(root, definitionFor("http://example.com/tool.tar.gz", "a".repeat(64)));
    assert.equal((await badUrl.install("tool")).code, "INVALID_PACKAGE");

    const badId = installerFor(root, { ...valid, id: "../evil" });
    assert.equal((await badId.install("../evil")).code, "PACKAGE_NOT_FOUND");
    const badIdInstaller = new Installer({ userDataPath: root, registry: { "../evil": { ...valid, id: "../evil" } } });
    assert.equal((await badIdInstaller.install("../evil")).code, "INVALID_PACKAGE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Installer reports unsupported platforms without downloading", async () => {
  const root = await tempDir();
  try {
    const definition = definitionFor("https://example.invalid/tool.tar.gz", "a".repeat(64));
    definition.platforms = { aix: { x64: definition.platforms[process.platform][process.arch] } };
    const installer = installerFor(root, definition);
    const result = await installer.install("tool");
    assert.equal(result.success, false);
    assert.equal(result.code, "UNSUPPORTED_PLATFORM");
    assert.match(result.error, /aix\/x64|does not provide|no verified distribution/);
    assert.deepEqual(await listing(path.join(root, "tools")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Installer selects the configuration for the current OS and architecture", async () => {
  const root = await tempDir();
  const current = await fixtureArchive([{ name: "bin/tool", data: "current-platform", mode: 0o755 }]);
  const other = await fixtureArchive([{ name: "bin/tool", data: "other-platform", mode: 0o755 }]);
  const server = await serve({
    "/current.tar.gz": staticRoute(current.body),
    "/other.tar.gz": staticRoute(other.body),
  });
  try {
    const definition = definitionFor(`${server.origin}/current.tar.gz`, current.checksum);
    const currentConfig = definition.platforms[process.platform][process.arch];
    const otherConfig = {
      ...currentConfig,
      download: { url: `${server.origin}/other.tar.gz`, checksum: other.checksum, checksumAlgorithm: "sha256" },
    };
    definition.platforms = {
      linux: { x64: otherConfig },
      darwin: { arm64: otherConfig },
      [process.platform]: { [process.arch]: currentConfig },
    };
    const installer = installerFor(root, definition);
    const result = await installer.install("tool");
    assert.equal(result.success, true, result.error);
    assert.equal(await fs.readFile(path.join(result.installDir, "bin", "tool"), "utf8"), "current-platform");
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(current.dir, { recursive: true, force: true });
    await fs.rm(other.dir, { recursive: true, force: true });
  }
});

test("Installer installs a TAR.GZ package end to end and reports progress", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([
    { name: "bin/", type: "directory" },
    { name: "bin/tool", data: "#!/bin/sh\necho tool\n", mode: 0o755 },
    { name: "README.md", data: "tool readme" },
  ]);
  const server = await serve({ "/tool.tar.gz": staticRoute(fixture.body) });
  try {
    const installer = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum));
    const progress = [];
    const result = await installer.install("tool", { onProgress: (event) => progress.push(event) });
    assert.equal(result.success, true, result.error);
    assert.equal(result.packageId, "tool");
    assert.equal(result.version, "1.0.0");
    assert.equal(result.installDir, path.join(root, "tools", "tool", "1.0.0"));
    assert.equal(result.executable, path.join(result.installDir, "bin", "tool"));
    assert.equal(await fs.readFile(path.join(result.installDir, "README.md"), "utf8"), "tool readme");
    if (process.platform !== "win32") {
      const stats = await fs.stat(result.executable);
      assert.ok(stats.mode & 0o111, "extracted executable keeps its exec bit");
    }
    assert.deepEqual(await listing(path.join(root, "tools")), ["tool"]);
    const download = progress.filter((event) => event.step === "download" && event.receivedBytes !== undefined);
    assert.ok(download.length > 0, "download progress is reported");
    assert.equal(download.at(-1).receivedBytes, fixture.body.length);
    assert.equal(download.at(-1).totalBytes, fixture.body.length);
    assert.equal(download.at(-1).percent, 100);
    const steps = new Set(progress.map((event) => event.step));
    for (const expected of ["download", "extract", "verify", "commit", "complete"])
      assert.ok(steps.has(expected), `progress includes ${expected}`);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("Installer reports and uninstalls an existing installation", async () => {
  const root = await tempDir();
  try {
    const installer = installerFor(
      root,
      definitionFor("https://example.invalid/tool.tar.gz", "a".repeat(64)),
    );
    const installDir = path.join(root, "tools", "tool", "1.0.0");
    const executable = path.join(installDir, "bin", "tool");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "installed tool");

    assert.equal(await installer.getInstallation("missing"), null);
    const installation = await installer.getInstallation("tool");
    assert.equal(installation?.success, true);
    assert.equal(installation.executable, executable);
    assert.equal(installation.installDir, installDir);
    assert.equal(installation.alreadyInstalled, true);

    const missing = await installer.uninstall("missing");
    assert.equal(missing.success, false);
    assert.equal(missing.code, "PACKAGE_NOT_FOUND");

    const removed = await installer.uninstall("tool");
    assert.equal(removed.success, true);
    assert.equal(removed.installDir, installDir);
    assert.equal(await installer.getInstallation("tool"), null);
    await assert.rejects(fs.stat(installDir));
    assert.deepEqual(await listing(path.join(root, "tools")), []);

    const again = await installer.uninstall("tool");
    assert.equal(again.success, false);
    assert.equal(again.code, "NOT_INSTALLED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Installer reuses a verified installation without re-downloading", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([{ name: "bin/tool", data: "#!/bin/sh\necho tool\n", mode: 0o755 }]);
  let requests = 0;
  const server = await serve({
    "/tool.tar.gz": (req, res) => { requests++; staticRoute(fixture.body)(req, res); },
  });
  try {
    const installer = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum));
    const first = await installer.install("tool");
    assert.equal(first.success, true, first.error);
    assert.equal(first.alreadyInstalled, undefined);
    assert.equal(requests, 1);

    const second = await installer.install("tool");
    assert.equal(second.success, true, second.error);
    assert.equal(second.alreadyInstalled, true);
    assert.equal(second.executable, first.executable);
    assert.equal(requests, 1, "a verified installation must not be downloaded again");
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("Installer installs a ZIP package and honours stripComponents", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([
    { name: "tool-1.0.0/", type: "directory" },
    { name: "tool-1.0.0/bin/tool", data: "zipped tool", mode: 0o100755 },
    { name: "tool-1.0.0/share/doc.txt", data: "docs" },
  ], "zip");
  const server = await serve({ "/tool.zip": staticRoute(fixture.body) });
  try {
    const definition = definitionFor(`${server.origin}/tool.zip`, fixture.checksum);
    definition.platforms[process.platform][process.arch].archive = { format: "zip", stripComponents: 1 };
    const installer = installerFor(root, definition);
    const result = await installer.install("tool");
    assert.equal(result.success, true, result.error);
    assert.equal(await fs.readFile(path.join(result.installDir, "bin", "tool"), "utf8"), "zipped tool");
    assert.equal(await fs.readFile(path.join(result.installDir, "share", "doc.txt"), "utf8"), "docs");
    assert.deepEqual(await listing(path.join(result.installDir, "tool-1.0.0")), []);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("Installer rejects checksum mismatches and cleans staging", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([{ name: "bin/tool", data: "tool" }]);
  const server = await serve({ "/tool.tar.gz": staticRoute(fixture.body) });
  try {
    const installer = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, sha256(Buffer.from("different"))));
    const result = await installer.install("tool");
    assert.equal(result.success, false);
    assert.equal(result.code, "CHECKSUM_MISMATCH");
    assert.deepEqual(await listing(path.join(root, "tools")), []);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("Installer surfaces HTTP errors, truncation and connection failures", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([{ name: "bin/tool", data: "tool" }]);
  const server = await serve({
    "/missing.tar.gz": (req, res) => { res.writeHead(500); res.end("boom"); },
    "/truncated.tar.gz": (req, res) => {
      res.writeHead(200, { "content-length": fixture.body.length + 1024 });
      res.end(fixture.body);
    },
  });
  const deadPort = await serve({});
  const deadOrigin = deadPort.origin;
  await deadPort.close();
  try {
    const httpError = installerFor(root, definitionFor(`${server.origin}/missing.tar.gz`, fixture.checksum));
    assert.equal((await httpError.install("tool")).code, "DOWNLOAD_FAILED");
    const truncated = installerFor(root, definitionFor(`${server.origin}/truncated.tar.gz`, fixture.checksum));
    assert.equal((await truncated.install("tool")).code, "DOWNLOAD_FAILED");
    const refused = installerFor(root, definitionFor(`${deadOrigin}/tool.tar.gz`, fixture.checksum));
    assert.equal((await refused.install("tool")).code, "DOWNLOAD_FAILED");
    assert.deepEqual(await listing(path.join(root, "tools")), []);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

for (const format of ["tar.gz", "zip"]) {
  test(`Installer blocks path traversal and absolute entries in ${format.toUpperCase()}`, async () => {
    const root = await tempDir();
    const entries = [
      { name: "bin/tool", data: "tool" },
      { name: "../evil.txt", data: "evil" },
    ];
    const fixture = format === "zip" ? await rawZipFixture(entries) : await fixtureArchive(entries, format);
    const server = await serve({ "/tool.archive": staticRoute(fixture.body) });
    try {
      const definition = definitionFor(`${server.origin}/tool.archive`, fixture.checksum);
      definition.platforms[process.platform][process.arch].archive = { format, stripComponents: 0 };
      const installer = installerFor(root, definition);
      const result = await installer.install("tool");
      assert.equal(result.success, false);
      assert.equal(result.code, "EXTRACTION_FAILED");
      assert.equal(await fs.stat(path.join(root, "evil.txt")).then(() => true, () => false), false);
      assert.equal(await fs.stat(path.join(root, "tools", "evil.txt")).then(() => true, () => false), false);
      assert.deepEqual(await listing(path.join(root, "tools")), []);
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test(`Installer rejects links escaping the destination and absolute paths in ${format.toUpperCase()}`, async () => {
    const root = await tempDir();
    const symlinkFixture = await fixtureArchive([
      { name: "bin/tool", data: "tool" },
      { name: "bin/link", type: "symlink", linkname: "/etc/passwd" },
    ], format);
    const absoluteFixture = format === "zip"
      ? await rawZipFixture([{ name: "/evil.txt", data: "evil" }])
      : await fixtureArchive([{ name: "/evil.txt", data: "evil" }], format);
    const server = await serve({
      "/symlink.archive": staticRoute(symlinkFixture.body),
      "/absolute.archive": staticRoute(absoluteFixture.body),
    });
    try {
      for (const [route, fixture] of [["/symlink.archive", symlinkFixture], ["/absolute.archive", absoluteFixture]]) {
        const definition = definitionFor(`${server.origin}${route}`, fixture.checksum);
        definition.platforms[process.platform][process.arch].archive = { format, stripComponents: 0 };
        const installer = installerFor(root, definition);
        const result = await installer.install("tool");
        assert.equal(result.success, false, `${route} must fail`);
        assert.equal(result.code, "EXTRACTION_FAILED");
      }
      assert.deepEqual(await listing(path.join(root, "tools")), []);
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(symlinkFixture.dir, { recursive: true, force: true });
      await fs.rm(absoluteFixture.dir, { recursive: true, force: true });
    }
  });
}

for (const format of ["tar.gz", "zip"]) {
  test(`Installer materializes in-tree links as regular copies in ${format.toUpperCase()}`, async () => {
    const root = await tempDir();
    const fixture = await fixtureArchive([
      { name: "bin/tool-link", type: "symlink", linkname: "tool" },
      { name: "bin/tool", data: "tool", mode: 0o755 },
    ], format);
    const server = await serve({ "/tool.archive": staticRoute(fixture.body) });
    try {
      const definition = definitionFor(`${server.origin}/tool.archive`, fixture.checksum);
      definition.platforms[process.platform][process.arch].archive = { format, stripComponents: 0 };
      const installer = installerFor(root, definition);
      const result = await installer.install("tool");
      assert.equal(result.success, true, result.error);
      const link = path.join(result.installDir, "bin", "tool-link");
      const stats = await fs.lstat(link);
      assert.ok(stats.isFile(), "the link is materialized as a regular file");
      assert.equal(stats.isSymbolicLink(), false);
      assert.equal(await fs.readFile(link, "utf8"), "tool");
      if (process.platform !== "win32") assert.ok(stats.mode & 0o111, "the copy keeps the target exec bit");
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });
}

test("Installer runs command steps and enforces required versus optional failures", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([{ name: "bin/tool", data: "tool" }, { name: "extra.txt", data: "extra" }]);
  const server = await serve({ "/tool.tar.gz": staticRoute(fixture.body) });
  const baseSteps = [{ type: "download" }, { type: "extract" }];
  try {
    const optional = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum, {
      install: {
        steps: [
          ...baseSteps,
          { type: "command", executable: NODE, args: ["-e", "process.exit(3)"], required: false },
          { type: "copy", from: "{installDir}/extra.txt", to: "{installDir}/copied.txt" },
          { type: "move", from: "{installDir}/copied.txt", to: "{installDir}/moved.txt" },
          { type: "delete", path: "{installDir}/extra.txt" },
        ],
      },
    }));
    const optionalResult = await optional.install("tool");
    assert.equal(optionalResult.success, true, optionalResult.error);
    assert.equal(await fs.readFile(path.join(optionalResult.installDir, "moved.txt"), "utf8"), "extra");
    assert.equal(await fs.stat(path.join(optionalResult.installDir, "copied.txt")).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(optionalResult.installDir, "extra.txt")).then(() => true, () => false), false);

    await fs.rm(path.join(root, "tools"), { recursive: true, force: true });
    const required = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum, {
      install: { steps: [...baseSteps, { type: "command", executable: NODE, args: ["-e", "process.exit(3)"] }] },
    }));
    const requiredResult = await required.install("tool");
    assert.equal(requiredResult.success, false);
    assert.equal(requiredResult.code, "STEP_FAILED");
    assert.deepEqual(await listing(path.join(root, "tools")), []);

    const escaping = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum, {
      install: { steps: [...baseSteps, { type: "command", executable: "{installDir}/../../outside" }] },
    }));
    assert.equal((await escaping.install("tool")).code, "STEP_FAILED");

    const timingOut = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum, {
      install: { steps: [...baseSteps, { type: "command", executable: NODE, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 300 }] },
    }));
    const timeoutResult = await timingOut.install("tool");
    assert.equal(timeoutResult.code, "STEP_FAILED");
    assert.match(timeoutResult.error, /timed out/);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("Installer never commits an installation that fails final verification", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([{ name: "bin/tool", data: "tool" }]);
  const server = await serve({ "/tool.tar.gz": staticRoute(fixture.body) });
  try {
    const definition = definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum, {
      verification: { executable: NODE, args: ["-e", "process.exit(1)"] },
    });
    const installer = installerFor(root, definition);
    const result = await installer.install("tool");
    assert.equal(result.success, false);
    assert.equal(result.code, "VERIFICATION_FAILED");
    assert.deepEqual(await listing(path.join(root, "tools")), []);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("Installer preserves a working previous installation and replaces a broken one", async () => {
  const root = await tempDir();
  const fixture = await fixtureArchive([{ name: "bin/tool", data: "new tool" }, { name: "marker.txt", data: "new" }]);
  const server = await serve({ "/tool.tar.gz": staticRoute(fixture.body) });
  const destination = path.join(root, "tools", "tool", "1.0.0");
  const markerVerification = {
    executable: NODE,
    args: ["-e", "require('fs').accessSync(process.argv[1])", "{installDir}/marker.txt"],
  };
  try {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "marker.txt"), "previous");
    const kept = installerFor(root, definitionFor("https://example.invalid/tool.tar.gz", "a".repeat(64), { verification: markerVerification }));
    const keptResult = await kept.install("tool");
    assert.equal(keptResult.success, true, keptResult.error);
    assert.equal(keptResult.alreadyInstalled, true);
    assert.equal(await fs.readFile(path.join(destination, "marker.txt"), "utf8"), "previous");

    await fs.rm(path.join(destination, "marker.txt"));
    const replaced = installerFor(root, definitionFor(`${server.origin}/tool.tar.gz`, fixture.checksum, { verification: markerVerification }));
    const replacedResult = await replaced.install("tool");
    assert.equal(replacedResult.success, true, replacedResult.error);
    assert.equal(replacedResult.alreadyInstalled, undefined);
    assert.equal(await fs.readFile(path.join(destination, "marker.txt"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(destination, "bin", "tool"), "utf8"), "new tool");

    await fs.rm(path.join(destination, "marker.txt"));
    const brokenFixture = await fixtureArchive([{ name: "bin/tool", data: "no marker" }]);
    const brokenServer = await serve({ "/broken.tar.gz": staticRoute(brokenFixture.body) });
    try {
      const failing = installerFor(root, definitionFor(`${brokenServer.origin}/broken.tar.gz`, brokenFixture.checksum, { verification: markerVerification }));
      const failingResult = await failing.install("tool");
      assert.equal(failingResult.success, false);
      assert.equal(failingResult.code, "VERIFICATION_FAILED");
      assert.equal(await fs.readFile(path.join(destination, "bin", "tool"), "utf8"), "new tool", "a failed install must not destroy the previous installation");
      assert.deepEqual((await listing(path.join(root, "tools"))).sort(), ["tool"]);
    } finally {
      await brokenServer.close();
      await fs.rm(brokenFixture.dir, { recursive: true, force: true });
    }
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("Installer cancellation aborts the download, cleans staging and frees the engine", async () => {
  const root = await tempDir();
  const total = 256 * 1024;
  const server = await serve({
    "/slow.tar.gz": (req, res) => {
      res.writeHead(200, { "content-length": total });
      const chunk = Buffer.alloc(1024, 7);
      let sent = 0;
      const timer = setInterval(() => {
        sent += chunk.length;
        res.write(chunk);
        if (sent >= total) {
          clearInterval(timer);
          res.end();
        }
      }, 20);
      res.on("close", () => clearInterval(timer));
    },
  });
  try {
    const installer = installerFor(root, definitionFor(`${server.origin}/slow.tar.gz`, sha256(Buffer.alloc(total, 7))));
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const pending = installer.install("tool", {
      onProgress: (event) => { if (event.receivedBytes > 0) started(); },
    });
    const busy = await installer.install("tool");
    assert.equal(busy.code, "INSTALL_BUSY");
    await startedPromise;
    installer.cancel();
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.code, "CANCELLED");
    assert.deepEqual(await listing(path.join(root, "tools")), []);
    const again = await installer.install("tool", { signal: AbortSignal.abort() });
    assert.equal(again.code, "CANCELLED");
    assert.deepEqual(await listing(path.join(root, "tools")), []);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});