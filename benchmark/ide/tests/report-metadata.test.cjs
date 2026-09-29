const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getReportFixtureVersion,
  assertReportFixtureVersion,
  setReportFixtureVersionFromManifest,
} = require("../runner/report-metadata.cjs");

test("matching report fixture versions resolve consistently", () => {
  const report = {
    environment: { fixtureVersion: "1.1.1" },
    configuration: { fixtureVersion: "1.1.1" },
  };
  assert.deepEqual(getReportFixtureVersion(report), { version: "1.1.1", warning: null });
  assert.equal(assertReportFixtureVersion(report), "1.1.1");
});

test("contradictory legacy report fixture versions are ambiguous", () => {
  const report = {
    environment: { fixtureVersion: "1.0.0" },
    configuration: { fixtureVersion: "1.1.1" },
  };
  assert.deepEqual(getReportFixtureVersion(report), {
    version: null,
    warning: "contradictory fixture versions: environment=1.0.0, configuration=1.1.1",
  });
  assert.throws(() => assertReportFixtureVersion(report), /contradictory fixture versions/);
});

test("legacy report with one fixture version field uses that field as a fallback", () => {
  assert.deepEqual(getReportFixtureVersion({ environment: { fixtureVersion: "1.1.1" } }), {
    version: "1.1.1",
    warning: null,
  });
  assert.deepEqual(getReportFixtureVersion({ configuration: { fixtureVersion: "1.0.0" } }), {
    version: "1.0.0",
    warning: null,
  });
});

test("new report fixture metadata is copied from the fixture manifest and kept in sync", () => {
  const report = { environment: {}, configuration: {} };
  assert.equal(setReportFixtureVersionFromManifest(report, { fixtureVersion: "1.1.1" }), "1.1.1");
  assert.deepEqual(report, {
    environment: { fixtureVersion: "1.1.1" },
    configuration: { fixtureVersion: "1.1.1" },
  });
  assert.equal(assertReportFixtureVersion(report), "1.1.1");
  assert.throws(() => setReportFixtureVersionFromManifest(report, {}), /no fixtureVersion/);
});
