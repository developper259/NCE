const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ARCH_PATTERN = /^[a-z0-9_]+$/i;

function parseArch(args) {
  const option = args.find((arg) => arg === "--arch" || arg.startsWith("--arch="));
  if (!option) return process.arch;
  const value = option === "--arch"
    ? args[args.indexOf(option) + 1]
    : option.slice("--arch=".length);
  if (!value || !ARCH_PATTERN.test(value))
    throw new Error(`Invalid native architecture: ${value || "(missing)"}`);
  return value;
}

const arch = parseArch(process.argv.slice(2));
const root = path.resolve(__dirname, "..");
const env = { ...process.env, npm_config_arch: arch };
const rebuildCli = path.join(
  path.dirname(require.resolve("@electron/rebuild")),
  "cli.js",
);

execFileSync(
  process.execPath,
  [rebuildCli, "-f", "-w", "node-pty", "--arch", arch],
  { cwd: root, env, stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [path.join(root, "node_modules", "node-pty", "scripts", "post-install.js")],
  { cwd: root, env, stdio: "inherit" },
);
