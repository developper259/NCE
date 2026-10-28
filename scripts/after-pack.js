const path = require("node:path");
const {
  flipFuses,
  FuseVersion,
  FuseV1Options,
} = require("@electron/fuses");

function resolveExecutable(context) {
  const productName = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === "darwin")
    return path.join(context.appOutDir, `${productName}.app`, "Contents", "MacOS", productName);
  if (context.electronPlatformName === "win32")
    return path.join(context.appOutDir, `${productName}.exe`);
  // LinuxPackager lowercases the sanitized product name for its executable.
  return path.join(context.appOutDir, context.packager.executableName);
}

async function afterPack(context) {
  await flipFuses(resolveExecutable(context), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
}

module.exports = afterPack;
module.exports.resolveExecutable = resolveExecutable;
