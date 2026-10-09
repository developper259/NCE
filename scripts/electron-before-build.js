const fs = require("node:fs");
const path = require("node:path");

exports.default = async function skipRedundantWindowsNativeRebuild(context) {
  if (context.platform?.nodeName !== "win32" || context.arch !== process.arch) return;

  const releaseDirectory = path.join(
    context.appDir,
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  const preparedFiles = [
    "conpty.node",
    path.join("conpty", "conpty.dll"),
    path.join("conpty", "OpenConsole.exe"),
  ];
  if (!preparedFiles.every((file) => fs.existsSync(path.join(releaseDirectory, file)))) return;

  console.log("[NCE] Skipping redundant Windows native rebuild; node-pty is already rebuilt for this architecture.");
  return false;
};
