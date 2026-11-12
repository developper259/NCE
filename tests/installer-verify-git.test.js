"use strict";

const assert = require("node:assert");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Installer } = require("../dist/ts/installer/Installer.js");
const { verifyGitFunctional } = require("../dist/ts/installer/verify-git.js");
const { resolveGitExecutable } = require("../dist/ts/manager/GitProcess.js");
const { tempDir } = require("./helpers/installer.js");

async function scratchRoot() {
  const root = await tempDir("nce-verify-git-");
  const tempRoot = path.join(root, "scratch");
  await fs.mkdir(tempRoot);
  return { root, tempRoot };
}

test("verifyGitFunctional completes a real temp-repo lifecycle and cleans up", async () => {
  const git = await resolveGitExecutable();
  const { root, tempRoot } = await scratchRoot();
  try {
    await verifyGitFunctional({
      executable: git,
      installDir: root,
      signal: new AbortController().signal,
      timeoutMs: 30000,
      tempRoot,
    });
    assert.deepEqual(await fs.readdir(tempRoot), [], "the probe repository must be removed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verifyGitFunctional reports VERIFICATION_FAILED for a non-Git executable and cleans up", async () => {
  const { root, tempRoot } = await scratchRoot();
  try {
    await assert.rejects(
      verifyGitFunctional({
        executable: process.execPath,
        installDir: root,
        signal: new AbortController().signal,
        timeoutMs: 30000,
        tempRoot,
      }),
      (error) => error.code === "VERIFICATION_FAILED",
    );
    assert.deepEqual(await fs.readdir(tempRoot), [], "the probe repository must be removed on failure");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verifyGitFunctional honours a pre-aborted signal without creating a repository", async () => {
  const git = await resolveGitExecutable();
  const { root, tempRoot } = await scratchRoot();
  try {
    await assert.rejects(
      verifyGitFunctional({
        executable: git,
        installDir: root,
        signal: AbortSignal.abort(),
        timeoutMs: 30000,
        tempRoot,
      }),
      (error) => error.code === "CANCELLED",
    );
    assert.deepEqual(await fs.readdir(tempRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Installer rejects an unknown functional verification kind", async () => {
  const root = await tempDir();
  try {
    const definition = {
      id: "tool",
      name: "Tool",
      version: "1.0.0",
      platforms: {
        [process.platform]: {
          [process.arch]: {
            download: { url: "https://example.invalid/tool.tar.gz", checksum: "a".repeat(64), checksumAlgorithm: "sha256" },
            archive: { format: "tar.gz", stripComponents: 0 },
            executable: "bin/tool",
          },
        },
      },
      verification: { executable: "bin/tool", args: ["--version"], functional: "bogus" },
    };
    const installer = new Installer({ userDataPath: root, registry: { tool: definition } });
    const result = await installer.install("tool");
    assert.equal(result.success, false);
    assert.equal(result.code, "INVALID_PACKAGE");
    assert.deepEqual(await fs.readdir(path.join(root, "tools")).catch(() => []), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});