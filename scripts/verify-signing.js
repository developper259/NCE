const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const releaseRoot = path.resolve(__dirname, "..", process.argv[2] || "release");

function findMacBundles(directory, bundles = []) {
  if (!fs.existsSync(directory)) return bundles;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name);
    if (entry.name.endsWith(".app")) bundles.push(file);
    else findMacBundles(file, bundles);
  }
  return bundles;
}

if (process.platform === "darwin") {
  const bundles = findMacBundles(releaseRoot);
  if (!bundles.length) {
    console.error("No macOS app bundle found for signature verification.");
    process.exit(1);
  }
  for (const bundle of bundles) {
    execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], {
      stdio: "inherit",
    });
    execFileSync("spctl", ["-a", "-vv", bundle], { stdio: "inherit" });
    console.log(`Signature verified: ${path.relative(releaseRoot, bundle)}`);
  }
} else if (process.platform === "win32") {
  const unpacked = path.join(releaseRoot, "win-unpacked");
  const executable = fs.existsSync(unpacked)
    ? fs.readdirSync(unpacked).find((name) => name.endsWith(".exe"))
    : null;
  if (!executable) {
    console.error("No packaged Windows executable found for signature verification.");
    process.exit(1);
  }
  const target = path.join(unpacked, executable);
  const status = execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `(Get-AuthenticodeSignature -LiteralPath '${target.replace(/'/g, "''")}').Status`,
  ], { encoding: "utf8" }).trim();
  if (status !== "Valid") {
    console.error(`Windows signature is not valid: ${status}`);
    process.exit(1);
  }
  console.log(`Signature verified: ${executable}`);
} else {
  console.log("Signature verification is not applicable on this platform.");
}
