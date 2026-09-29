const REPORT_VERSION = 2;

function getReportFixtureVersion(report) {
  const environmentVersion = report?.environment?.fixtureVersion;
  const configurationVersion = report?.configuration?.fixtureVersion;
  const hasEnvironmentVersion = typeof environmentVersion === "string" && environmentVersion.length > 0;
  const hasConfigurationVersion = typeof configurationVersion === "string" && configurationVersion.length > 0;

  if (hasEnvironmentVersion && hasConfigurationVersion && environmentVersion !== configurationVersion) {
    return {
      version: null,
      warning: `contradictory fixture versions: environment=${environmentVersion}, configuration=${configurationVersion}`,
    };
  }
  return {
    version: hasEnvironmentVersion ? environmentVersion : hasConfigurationVersion ? configurationVersion : null,
    warning: null,
  };
}

function assertReportFixtureVersion(report) {
  const resolved = getReportFixtureVersion(report);
  if (!resolved.version || resolved.warning ||
      typeof report?.environment?.fixtureVersion !== "string" ||
      typeof report?.configuration?.fixtureVersion !== "string") {
    throw new Error(resolved.warning || "Report must contain matching environment and configuration fixture versions");
  }
  return resolved.version;
}

function setReportFixtureVersionFromManifest(report, fixtureManifest) {
  const version = fixtureManifest?.fixtureVersion;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Validated fixture manifest has no fixtureVersion");
  }
  if (!report?.environment || !report?.configuration) {
    throw new Error("Report environment and configuration must exist before setting fixture metadata");
  }
  report.environment.fixtureVersion = version;
  report.configuration.fixtureVersion = version;
  assertReportFixtureVersion(report);
  return version;
}

module.exports = {
  REPORT_VERSION,
  getReportFixtureVersion,
  assertReportFixtureVersion,
  setReportFixtureVersionFromManifest,
};
