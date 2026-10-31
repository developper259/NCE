const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const script = process.argv[2] || "test";
const isWindows = process.platform === "win32";
const child = spawn(isWindows ? "npm.cmd" : "npm", [script], {
  cwd: root,
  env: process.env,
  shell: isWindows,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
const forward = (target) => (chunk) => {
  target.write(chunk);
  output += chunk.toString("utf8");
  if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024);
};
child.stdout.on("data", forward(process.stdout));
child.stderr.on("data", forward(process.stderr));
child.on("error", (error) => {
  console.error(`::error::Unable to run npm ${script}: ${error.message}`);
  process.exit(1);
});
child.on("close", (code) => {
  if (code === 0) process.exit(0);
  const lines = output.split(/\r?\n/);
  const failures = lines
    .filter((line) => /^not ok \d+ - /.test(line))
    .map((line) => line.replace(/^not ok \d+ - /, "").slice(0, 200));
  const details = lines
    .filter((line) => /^(?:Error:|\[Renderer\] Uncaught|.*Timed out .*)/.test(line.trim()))
    .map((line) => line.trim().slice(0, 400));
  for (const failure of [...new Set(failures)].slice(0, 20))
    console.log(`::error::Failing test: ${failure}`);
  for (const detail of [...new Set(details)].slice(0, 10))
    console.log(`::error::${detail}`);
  if (!failures.length && !details.length) {
    const tail = output.trim().split(/\r?\n/).slice(-8).join(" | ").slice(0, 1_000);
    console.log(`::error::npm ${script} failed without a TAP failure. Last output: ${tail}`);
  }
  process.exit(code ?? 1);
});
