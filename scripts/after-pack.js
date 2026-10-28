const path = require("node:path");
const {
  flipFuses,
  FuseVersion,
  FuseV1Options,
} = require("@electron/fuses");

module.exports = async function afterPack(context) {
  const productName = context.packager.appInfo.productFilename;
  const executable = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${productName}.app`, "Contents", "MacOS", productName)
    : context.electronPlatformName === "win32"
      ? path.join(context.appOutDir, `${productName}.exe`)
      : path.join(context.appOutDir, productName);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};
