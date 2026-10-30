const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  classifyGitFailure,
  killProcessTree,
  resolveGitExecutable,
  trustedGitCandidates,
} = require("../dist/ts/manager/GitProcess.js");

test("trusted Git candidates prefer platform install locations", () => {
  assert.deepEqual(
    trustedGitCandidates("darwin", {}),
    ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"],
  );
  assert.deepEqual(
    trustedGitCandidates("linux", {}),
    ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/snap/bin/git"],
  );
  assert.deepEqual(
    trustedGitCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\nce\\AppData\\Local",
    }),
    [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      "C:\\Users\\nce\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
    ],
  );
  assert.deepEqual(trustedGitCandidates("win32", {}), []);
});

test("resolveGitExecutable validates candidates and falls back to PATH", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-process-"));
  try {
    const missing = path.join(root, "missing-git");
    const executable = path.join(root, "executable-git");
    await fs.writeFile(executable, "#!/bin/sh\n");
    await fs.chmod(executable, 0o755);
    assert.equal(
      await resolveGitExecutable({
        platform: process.platform,
        candidates: [missing, executable],
      }),
      executable,
    );
    if (process.platform !== "win32") {
      const plain = path.join(root, "plain-git");
      await fs.writeFile(plain, "#!/bin/sh\n");
      assert.equal(
        await resolveGitExecutable({ platform: "linux", candidates: [plain] }),
        "git",
        "a file without execute bits is not trusted",
      );
    }
    assert.equal(
      await resolveGitExecutable({ platform: "linux", candidates: [missing] }),
      "git",
    );
    assert.equal(
      await resolveGitExecutable({ explicit: "/custom/bin/git" }),
      "/custom/bin/git",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("killProcessTree only starts taskkill for a Windows SIGKILL", () => {
  const spawns = [];
  const spawnProcess = (command, args, options) => {
    spawns.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  const signals = [];
  const child = {
    pid: 4242,
    kill(signal) {
      signals.push(signal);
      return true;
    },
  };
  killProcessTree(child, "SIGTERM", "win32", spawnProcess);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(spawns.length, 0, "a graceful signal does not force-kill the tree");

  killProcessTree(child, "SIGKILL", "win32", spawnProcess);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(spawns.length, 1);
  assert.match(spawns[0].command, /taskkill\.exe$/);
  assert.deepEqual(spawns[0].args, ["/pid", "4242", "/T", "/F"]);
  assert.deepEqual(spawns[0].options, { windowsHide: true, stdio: "ignore" });

  let killed = false;
  killProcessTree({ pid: undefined, kill() { killed = true; } }, "SIGKILL", "win32", spawnProcess);
  assert.equal(killed, false, "a child without a pid is ignored");
  assert.equal(spawns.length, 1);
});

test("killProcessTree terminates a real Windows process tree", {
  skip: process.platform !== "win32" && "Windows only",
  timeout: 20_000,
}, async () => {
  const child = spawn("ping.exe", ["-n", "30", "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const closed = new Promise((resolve) => child.once("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    killProcessTree(child, "SIGKILL", process.platform);
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the Git process survived taskkill")), 10_000)),
    ]);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }
});

test("classifyGitFailure surfaces a concurrent index lock", () => {
  const locked = classifyGitFailure(
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
  );
  assert.equal(locked.code, "GIT_INDEX_LOCKED");
  assert.match(locked.message, /already running/i);
  assert.equal(
    classifyGitFailure("fatal: not a git repository").code,
    "GIT_COMMAND_FAILED",
  );
  assert.equal(classifyGitFailure(undefined).code, "GIT_COMMAND_FAILED");
});
