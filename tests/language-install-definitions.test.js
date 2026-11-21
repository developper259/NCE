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

test("Node distribution uses official nodejs.org URLs and verified checksums", () => {
  const node = builtinPackages.node;
  assert.equal(node.version, "24.22.3");
  const darwin = node.platforms.darwin.arm64;
  assert.match(darwin.download.url, /^https:\/\/nodejs\.org\/dist\/v24\.22\.3\/node-v24\.22\.3-darwin-arm64\.tar\.gz$/);
  assert.equal(darwin.download.checksum, "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd");
  assert.equal(darwin.archive.stripComponents, 1);
  assert.equal(node.platforms.win32.x64.download.checksum, "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f");
  // Linux is intentionally absent: official Node Linux archives are .tar.xz.
  assert.equal(node.platforms.linux, undefined);
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
  const js = languages.get("javascript");
  assert.ok(js.fileExtensions.includes(".py") === false);
  for (const ext of [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]) {
    assert.ok(js.fileExtensions.includes(ext), `javascript covers ${ext}`);
  }
  for (const component of js.components) {
    assert.ok(packages.has(component.packageId), `${component.id} -> managed package ${component.packageId}`);
    assert.ok(builtinPackages[component.packageId], `${component.packageId} has an Installer distribution`);
  }
  assert.deepEqual(js.defaultSelection, ["javascript.runtime", "javascript.lsp"]);
});

test("selecting the JS LSP plans its runtime and compiler dependencies", () => {
  const packages = new PackageRegistry(builtinManagedPackages);
  const languages = new LanguageRegistry(builtinLanguages, packages);
  const js = languages.get("javascript");
  const plan = new ComponentPlanner().plan({
    language: js,
    selected: ["javascript.lsp"],
    installed: new Map(),
    platform: "darwin",
  });
  assert.deepEqual(plan.toInstall, [
    "javascript.runtime",
    "javascript.typescript",
    "javascript.lsp",
  ]);
  assert.deepEqual(plan.dependenciesToInstall.sort(), ["javascript.runtime", "javascript.typescript"]);
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
