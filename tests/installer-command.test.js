"use strict";

const assert = require("node:assert");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runCommand } = require("../dist/ts/installer/command.js");
const { InstallerError } = require("../dist/ts/installer/errors.js");
const { tempDir } = require("./helpers/installer.js");

const NODE = process.execPath;
const freshSignal = () => new AbortController().signal;
const isCancelled = (error) => error instanceof InstallerError && error.code === "CANCELLED";

test("runCommand strips inherited GIT_* redirections and forces a safe locale", async () => {
  const saved = { ...process.env };
  process.env.GIT_DIR = "/hostile/repo.git";
  process.env.GIT_EXEC_PATH = "/hostile/exec";
  process.env.GIT_INDEX_FILE = "/hostile/index";
  try {
    const result = await runCommand(
      NODE,
      ["-e", "process.stdout.write(JSON.stringify({dir:process.env.GIT_DIR??null,exec:process.env.GIT_EXEC_PATH??null,index:process.env.GIT_INDEX_FILE??null,lc:process.env.LC_ALL,prompt:process.env.GIT_TERMINAL_PROMPT,locks:process.env.GIT_OPTIONAL_LOCKS}))"],
      { cwd: process.cwd(), timeoutMs: 10000, signal: freshSignal() },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      dir: null,
      exec: null,
      index: null,
      lc: "C",
      prompt: "0",
      locks: "0",
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("runCommand rejects a pre-aborted signal without spawning a process", async () => {
  const dir = await tempDir("nce-command-");
  const marker = path.join(dir, "spawned.txt");
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      runCommand(
        NODE,
        ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`],
        { cwd: dir, timeoutMs: 10000, signal: controller.signal },
      ),
      isCancelled,
    );
    assert.equal(
      await fs.stat(marker).then(() => true, () => false),
      false,
      "the fast path must not spawn the command",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runCommand cancels a running command promptly instead of waiting for the timeout", async () => {
  const controller = new AbortController();
  const start = Date.now();
  const pending = runCommand(NODE, ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: process.cwd(),
    timeoutMs: 30000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(pending, isCancelled);
  assert.ok(Date.now() - start < 5000, "cancellation interrupts the running command");
});

test("runCommand applies extra environment overrides on top of the sanitized base", async () => {
  const result = await runCommand(
    NODE,
    ["-e", "process.stdout.write(process.env.NCE_TEST_VAR ?? 'missing')"],
    { cwd: process.cwd(), timeoutMs: 10000, signal: freshSignal(), env: { NCE_TEST_VAR: "present" } },
  );
  assert.equal(result.stdout, "present");
});

test("runCommand surfaces a non-zero exit as STEP_FAILED with stderr detail", async () => {
  await assert.rejects(
    runCommand(NODE, ["-e", "process.stderr.write('boom'); process.exit(3)"], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      signal: freshSignal(),
    }),
    (error) => error instanceof InstallerError && error.code === "STEP_FAILED" && /boom/.test(error.message),
  );
});