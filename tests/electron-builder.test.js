const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const test = require("node:test");

test("native modules are rebuilt for each macOS architecture before packaging", () => {
  assert.equal(packageJson.build.npmRebuild, false);
  assert.equal(packageJson.build.beforeBuild, undefined);

  for (const scriptName of ["dist", "build", "test:electron"]) {
    const script = packageJson.scripts[scriptName];
    assert.match(script, /npm run rebuild:native/);
    assert.match(script, /electron-builder|tests\/electron\/smoke\.cjs/);
  }
  assert.match(packageJson.scripts["rebuild:native"], /scripts\/rebuild-native\.js/);
  const macBuild = packageJson.scripts["build:mac"];
  assert.match(macBuild, /npm run package:mac:x64/);
  assert.match(macBuild, /npm run package:mac:arm64/);
  for (const arch of ["x64", "arm64"]) {
    assert.match(
      packageJson.scripts[`package:mac:${arch}`],
      new RegExp(`rebuild-native\\.js --arch=${arch} && electron-builder --mac --${arch}`),
    );
  }

  const rebuildScript = fs.readFileSync(
    path.join(__dirname, "../scripts/rebuild-native.js"),
    "utf8",
  );
  assert.match(rebuildScript, /npm_config_arch/);
  assert.match(rebuildScript, /--arch/);
  assert.match(rebuildScript, /post-install\.js/);

  const releaseWorkflow = fs.readFileSync(
    path.join(__dirname, "../.github/workflows/release-build.yml"),
    "utf8",
  );
  assert.match(releaseWorkflow, /npm run build:mac/);
  assert.doesNotMatch(releaseWorkflow, /--mac --x64 --arm64/);
});

test("Windows NSIS offers per-user Open with NCE entries and removes only its own registry keys", () => {
  const nsis = packageJson.build.nsis;
  const installer = fs.readFileSync(path.join(__dirname, "../build/installer.nsh"), "utf8");
  const ci = fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8");
  assert.equal(packageJson.build.win.target, "nsis");
  assert.equal(nsis.oneClick, true, "retain electron-builder's one-click installer mode");
  assert.equal(nsis.perMachine, false);
  assert.equal(nsis.include, "build/installer.nsh");
  assert.match(installer, /Software\\Classes\\\*\\shell\\NCE\.OpenWith/);
  assert.match(installer, /Software\\Classes\\Directory\\shell\\NCE\.OpenWith/);
  assert.equal((installer.match(/"MultiSelectModel" "Player"/g) || []).length, 2,
    "both verbs accept multi-selection instead of the shell's single-document default");
  assert.match(installer, /\$\{APP_EXECUTABLE_FILENAME\}.*%1/);
  assert.match(installer, /!macro customUnInstall/);
  assert.equal((installer.match(/DeleteRegKey HKCU/g) || []).length, 2);
  assert.doesNotMatch(installer, /cmd\.exe/i);
  assert.equal(packageJson.build.fileAssociations, undefined, "NCE does not claim default file associations");
  assert.match(packageJson.scripts["test:nsis-install"], /test-nsis-install\.ps1/);
  assert.match(ci, /npm run build -- --win nsis/);
  assert.match(ci, /npm run test:nsis-install/);
  const installSmoke = fs.readFileSync(path.join(__dirname, "../scripts/test-nsis-install.ps1"), "utf8");
  assert.match(installSmoke, /upgrade path/);
  assert.match(installSmoke, /NCE\.UnrelatedSmokeEntry/);
});

test("macOS declares an alternate document handler without claiming default ownership", () => {
  const documentTypes = packageJson.build.mac.extendInfo.CFBundleDocumentTypes;
  assert.ok(documentTypes.length > 0);
  assert.ok(documentTypes.every((type) => type.LSHandlerRank === "Alternate"));
  assert.ok(documentTypes.some((type) =>
    type.CFBundleTypeRole === "Editor" && type.LSItemContentTypes.includes("public.data")));
  const folderType = documentTypes.find((type) => type.LSItemContentTypes.includes("public.folder"));
  assert.deepEqual(folderType, {
    CFBundleTypeName: "NCE Folder",
    CFBundleTypeRole: "Viewer",
    LSHandlerRank: "Alternate",
    LSItemContentTypes: ["public.folder"],
  });
  assert.equal(packageJson.build.mac.fileAssociations, undefined);
  const checkPackage = fs.readFileSync(
    path.join(__dirname, "../scripts/check-package.js"),
    "utf8",
  );
  assert.match(checkPackage, /lipo/);
  assert.match(checkPackage, /architecture must match/);
});

test("Linux AppImage and DEB desktop entries advertise Open with handlers without selecting defaults", () => {
  const linux = packageJson.build.linux;
  assert.deepEqual(linux.target, ["AppImage", "deb"]);
  assert.equal(packageJson.desktopName, "fr.ndl.nce.desktop");
  assert.equal(linux.syncDesktopName, true);
  assert.ok(linux.mimeTypes.includes("inode/directory"));
  assert.ok(linux.mimeTypes.includes("application/octet-stream"));
  assert.ok(linux.mimeTypes.includes("text/plain"));
  assert.equal(packageJson.build.fileAssociations, undefined);
});
