const assert = require("node:assert/strict");
const packageJson = require("../package.json");
const test = require("node:test");

test("electron-builder keeps production dependency collection without rebuilding prepared native modules", () => {
  assert.equal(packageJson.build.npmRebuild, false);
  assert.equal(packageJson.build.beforeBuild, undefined);

  for (const scriptName of ["dist", "build", "test:electron"]) {
    const script = packageJson.scripts[scriptName];
    assert.match(script, /npm run rebuild:native/);
    assert.match(script, /electron-builder|tests\/electron\/smoke\.cjs/);
  }
});
