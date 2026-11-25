"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Installer } = require("../dist/ts/installer/Installer.js");
const { builtinPackages } = require("../dist/ts/installer/packages/index.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { builtinManagedPackages } = require("../dist/ts/packages/index.js");
const { LanguageRegistry } = require("../dist/ts/languages/LanguageRegistry.js");
const { builtinLanguages } = require("../dist/ts/languages/index.js");
const { ComponentPlanner } = require("../dist/ts/languages/ComponentPlanner.js");
const { tempDir, makeTarGz, serve, staticRoute, sha256 } = require("./helpers/installer.js");

test("builtin Installer distributions validate for every declared platform", () => {
  for (const [id, definition] of Object.entries(builtinPackages)) {
    for (const [platform, arches] of Object.entries(definition.platforms)) {
      for (const [arch, config] of Object.entries(arches)) {
        const download = config.download;
        assert.match(download.url, /^https:\/\//, `${id} ${platform}/${arch} uses HTTPS`);
        const length = download.checksumAlgorithm === "sha512" ? 128 : 64;
        assert.match(download.checksum, new RegExp(`^[0-9a-f]{${length}}$`), `${id} checksum format`);
        assert.ok(["zip", "tar.gz"].includes(config.archive.format), `${id} supported archive`);
      }
    }
  }
});

test("Node.js is not an installable package: NCE ships its own runtime", () => {
  assert.equal(builtinPackages.node, undefined);
  assert.equal(
    builtinManagedPackages.some((definition) => definition.id === "node"),
    false,
  );
  for (const definition of builtinManagedPackages) {
    assert.equal(
      (definition.dependencies || []).includes("node"),
      false,
      `${definition.id} must not require a user-installed Node.js`,
    );
  }
});

test("npm tarballs use verified sha512 integrity and presence verification", () => {
  const ts = builtinPackages.typescript;
  const tsls = builtinPackages["typescript-language-server"];
  assert.match(ts.platforms.darwin.x64.download.url, /registry\.npmjs\.org\/typescript\/-\/typescript-5\.9\.3\.tgz/);
  assert.equal(ts.platforms.darwin.x64.download.checksumAlgorithm, "sha512");
  assert.equal(ts.verification.mode, "presence");
  assert.equal(ts.verification.executable, "lib/tsserver.js");
  assert.match(tsls.platforms.darwin.x64.download.url, /typescript-language-server-6\.1\.0\.tgz/);
  assert.equal(tsls.verification.mode, "presence");
  assert.equal(tsls.verification.executable, "lib/cli.mjs");
});

test("managed packages and language definitions are consistent with the registry", () => {
  const packages = new PackageRegistry(builtinManagedPackages);
  const languages = new LanguageRegistry(builtinLanguages, packages);

  // JavaScript and TypeScript are one environment. The runtime NCE uses for
  // its language servers is embedded in the app, not installed by the user.
  const js = languages.get("javascript");
  assert.equal(js.name, "JavaScript & TypeScript");
  assert.ok(js.fileExtensions.includes(".py") === false);
  for (const ext of [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]) {
    assert.ok(js.fileExtensions.includes(ext), `javascript covers ${ext}`);
  }
  for (const component of js.components) {
    assert.ok(packages.has(component.packageId), `${component.id} -> managed package ${component.packageId}`);
    assert.ok(builtinPackages[component.packageId], `${component.packageId} has an Installer distribution`);
  }
  assert.deepEqual(js.components.map((component) => component.id), [
    "javascript.typescript",
    "javascript.lsp",
  ]);
  assert.deepEqual(js.defaultSelection, ["javascript.typescript", "javascript.lsp"]);

  // The TypeScript environment no longer exists as a separate language.
  assert.equal(languages.has("typescript"), false);
});

test("selecting the JS LSP plans only its compiler dependency", () => {
  const packages = new PackageRegistry(builtinManagedPackages);
  const languages = new LanguageRegistry(builtinLanguages, packages);
  const js = languages.get("javascript");
  const plan = new ComponentPlanner().plan({
    language: js,
    selected: ["javascript.lsp"],
    installed: new Map(),
    platform: "darwin",
  });
  assert.deepEqual(plan.toInstall, ["javascript.typescript", "javascript.lsp"]);
  assert.deepEqual(plan.dependenciesToInstall, ["javascript.typescript"]);
  assert.deepEqual(plan.blockers, []);
});

test("selecting the TypeScript compiler needs no runtime component", () => {
  const packages = new PackageRegistry(builtinManagedPackages);
  const languages = new LanguageRegistry(builtinLanguages, packages);
  const js = languages.get("javascript");
  const plan = new ComponentPlanner().plan({
    language: js,
    selected: ["javascript.typescript"],
    installed: new Map(),
    platform: "darwin",
  });
  assert.deepEqual(plan.toInstall, ["javascript.typescript"]);
  assert.deepEqual(plan.dependenciesToInstall, []);
  assert.deepEqual(plan.blockers, []);
});

test("Python uses verified python-build-standalone archives across platforms", () => {
  const py = builtinPackages.python;
  assert.equal(py.version, "3.12.16");
  const expected = {
    "darwin/arm64": ["aarch64-apple-darwin", "e956e60bc9465d577ef8062059aa05cd3a2665b4b8678a2ed24e432368330b8f", "bin/python"],
    "darwin/x64": ["x86_64-apple-darwin", "83f2922437e6d546d0fcdb8c11f150a8e52787e8d9ea8651b1974e20908eb1bc", "bin/python"],
    "linux/x64": ["x86_64-unknown-linux-gnu", "c2f87d4b4e8db3abddb0f116c6ccfc503d0cbdbb9ee8faacddad1b679ec12e99", "bin/python"],
    "win32/x64": ["x86_64-pc-windows-msvc", "e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b", "python.exe"],
  };
  for (const [key, [target, checksum, executable]] of Object.entries(expected)) {
    const [platform, arch] = key.split("/");
    const config = py.platforms[platform][arch];
    assert.match(config.download.url, new RegExp(`cpython-3\\.12\\.16%2B20261110-${target}-install_only\\.tar\\.gz$`));
    assert.equal(config.download.checksum, checksum);
    assert.equal(config.executable, executable);
    assert.equal(config.archive.stripComponents, 1);
  }
});

test("Pyright LSP definition is verified and self-contained", () => {
  const pyright = builtinPackages.pyright;
  assert.equal(pyright.version, "1.1.414");
  assert.match(pyright.platforms.darwin.x64.download.url, /pyright-1\.1\.414\.tgz/);
  assert.equal(pyright.platforms.darwin.x64.download.checksumAlgorithm, "sha512");
  assert.equal(pyright.verification.executable, "langserver.index.js");
  assert.equal(pyright.verification.mode, "presence");
});

test("Python language definition resolves to real packages with dependency planning", () => {
  const packages = new PackageRegistry(builtinManagedPackages);
  const languages = new LanguageRegistry(builtinLanguages, packages);
  const py = languages.get("python");
  assert.deepEqual(py.fileExtensions, [".py", ".pyi", ".pyw"]);
  for (const component of py.components) {
    assert.ok(packages.has(component.packageId));
    assert.ok(builtinPackages[component.packageId]);
  }
  const plan = new ComponentPlanner().plan({
    language: py,
    selected: ["python.lsp"],
    installed: new Map(),
    platform: "darwin",
  });
  assert.deepEqual(plan.toInstall, ["python.runtime", "python.lsp"]);
  assert.deepEqual(plan.blockers, []);
});

test("presence verification installs a script package without an executable bit", async () => {
  const root = await tempDir();
  const archive = await tempDir("nce-npm-fixture-");
  const file = path.join(archive, "fixture.tar.gz");
  await makeTarGz([{ name: "package/lib/cli.mjs", data: "console.log('ok')", mode: 0o644 }], file);
  const body = await fs.readFile(file);
  const checksum = sha256(body);
  const server = await serve({ "/tool.tar.gz": staticRoute(body) });
  try {
    const definition = {
      id: "script-tool",
      name: "Script Tool",
      version: "1.0.0",
      platforms: {
        [process.platform]: {
          [process.arch]: {
            download: { url: `${server.origin}/tool.tar.gz`, checksum, checksumAlgorithm: "sha256" },
            archive: { format: "tar.gz", stripComponents: 1 },
            executable: "lib/cli.mjs",
            verification: { executable: "lib/cli.mjs", mode: "presence" },
          },
        },
      },
      verification: { executable: "lib/cli.mjs", mode: "presence" },
    };
    const installer = new Installer({ userDataPath: root, registry: { "script-tool": definition } });
    const result = await installer.install("script-tool");
    assert.equal(result.success, true, result.error);
    const installed = await fs.stat(result.executable);
    assert.equal(installed.isFile(), true);
    const verification = await installer.verifyInstallation("script-tool", result.installDir);
    assert.equal(verification.success, true);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(archive, { recursive: true, force: true });
  }
});
