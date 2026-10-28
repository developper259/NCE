const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const releaseRoot = path.resolve(__dirname, "..", process.argv[2] || "release");
const electronBinary = require("electron");

function findAsars(directory, asars = []) {
  if (!fs.existsSync(directory)) return asars;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.endsWith(".unpacked")) findAsars(file, asars);
    } else if (entry.name === "app.asar") {
      asars.push(file);
    }
  }
  return asars;
}

function hostArchitectureMatches(asarPath) {
  if (process.platform !== "darwin") return true;
  const pty = path.join(
    `${asarPath}.unpacked`,
    "node_modules",
    "node-pty",
    "build",
    "Release",
    "pty.node",
  );
  if (!fs.existsSync(pty)) return false;
  try {
    const archs = execFileSync("lipo", ["-archs", pty], { encoding: "utf8" }).trim();
    const expected = process.arch === "x64" ? "x86_64" : process.arch;
    return archs.split(/\s+/).includes(expected);
  } catch {
    return false;
  }
}

function smokeAsar(asarPath) {
  const script = `
    const pty = require(${JSON.stringify(path.join(asarPath, "node_modules", "node-pty"))});
    const shell = ${process.platform === "win32" ? JSON.stringify(process.env.ComSpec || "cmd.exe") : JSON.stringify("/bin/sh")};
    const term = pty.spawn(shell, [], {
      name: "xterm-256color", cols: 80, rows: 24,
      cwd: ${JSON.stringify(os.homedir())}, env: process.env,
    });
    let data = "";
    term.onData((chunk) => {
      data += chunk;
      if (data.includes("NCE_PTY_OK")) {
        console.log("PTY_OK");
        term.kill();
        process.exit(0);
      }
    });
    term.write(${process.platform === "win32" ? JSON.stringify("echo NCE_PTY_OK\r\n") : JSON.stringify("echo NCE_PTY_OK\n")});
    setTimeout(() => {
      console.error("PTY_TIMEOUT");
      term.kill();
      process.exit(1);
    }, 8000);
  `;
  const result = spawnSync(electronBinary, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 20000,
  });
  return {
    ok: result.status === 0 && String(result.stdout || "").includes("PTY_OK"),
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    error: result.error ? String(result.error) : null,
  };
}

const asars = findAsars(releaseRoot);
if (!asars.length) {
  console.error("No packaged app.asar found under release/.");
  process.exit(1);
}
let checked = 0;
for (const asarPath of asars) {
  if (!hostArchitectureMatches(asarPath)) continue;
  const result = smokeAsar(asarPath);
  checked += 1;
  if (!result.ok) {
    console.error(`Packaged PTY smoke test failed for ${asarPath}`);
    console.error(result.error || result.stderr || result.stdout || "");
    process.exit(1);
  }
  console.log(`Packaged PTY smoke test passed: ${path.relative(releaseRoot, asarPath)}`);
}
if (!checked) {
  console.error("No packaged PTY smoke test could be executed for the host architecture.");
  process.exit(1);
}
