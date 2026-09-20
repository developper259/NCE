#!/usr/bin/env node
const path = require("node:path");
const fs = require("node:fs");
const { parseArgs, loadDatasetConfig } = require("./DatasetConfig.cjs");
const { TaskSource } = require("../../src/js/agent/dataset/TaskSource");
const {
  WorkspaceFactory,
} = require("../../src/js/agent/dataset/WorkspaceFactory");
const { DatasetWriter } = require("../../src/js/agent/dataset/DatasetWriter");
const { DatasetBuilder } = require("../../src/js/agent/dataset/DatasetBuilder");

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const config = loadDatasetConfig({ configPath: cli.config, cli });
  const args = config;
  const configPath =
    config.providerConfig || path.resolve("dataset/private/provider.json");
  let fileConfig = {}, providerList = [];
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Dataset provider configuration invalid: ${error.message}`,
      );
    }
    if (fileConfig && fileConfig.schemaVersion === 2 && fileConfig.providers && fileConfig.routing?.primary) {
      const targets = [fileConfig.routing.primary, ...(fileConfig.routing.fallbacks || [])];
      providerList = targets.map((target) => {
        const definition = fileConfig.providers[target.providerId] || {};
        const canonicalId = target.providerId === "opencode-go" ? "opencode" : target.providerId;
        return { ...definition, providerId: canonicalId, model: target.model, sessionHeader: definition.sessionHeader };
      }).filter((item) => item.baseURL && item.model);
      fileConfig = providerList[0] || {};
    } else if (Array.isArray(fileConfig)) {
      providerList = fileConfig;
      const requestedProvider =
        config.provider || process.env.NCE_DATASET_PROVIDER;
      fileConfig =
        (requestedProvider &&
          fileConfig.find(
            (item) => item && item.providerId === requestedProvider,
          )) ||
        fileConfig[0];
    }
    if (
      !fileConfig ||
      typeof fileConfig !== "object" ||
      Array.isArray(fileConfig)
    )
      throw new Error(
        "Dataset provider configuration invalid: expected an object or provider list",
      );
    for (const field of ["providerId", "model"])
      if (!fileConfig[field] || typeof fileConfig[field] !== "string")
        throw new Error(
          `Dataset provider configuration invalid: missing "${field}"`,
        );
    if (fileConfig.apiKey && process.platform !== "win32") {
      const mode = fs.statSync(configPath).mode & 0o777;
      if (mode & 0o077)
        console.warn(
          "provider.json contains credentials and is readable by other users. Recommended permissions: chmod 600 provider.json",
        );
    }
  } else if (args["provider-config"])
    throw new Error(`Dataset provider configuration not found: ${configPath}`);
  const source = await TaskSource.read(config.tasks);
  let tasks = args.task
    ? source.tasks.filter((task) => task.id === args.task)
    : source.tasks;
  if (args.limit) tasks = tasks.slice(0, Number.parseInt(args.limit, 10));
  if (!tasks.length) throw new Error("no task selected");
  const writer = await new DatasetWriter(config.output, {
    artifacts: config.artifacts,
  }).initialize();
  const providerId =
    config.provider ||
    fileConfig.providerId ||
    process.env.NCE_DATASET_PROVIDER ||
    "openai-compatible";
  const model =
    config.model || fileConfig.model || process.env.NCE_DATASET_MODEL;
  const baseURL =
    config.baseURL || fileConfig.baseURL || process.env.NCE_DATASET_BASE_URL;
  const apiKey =
    config.apiKey || fileConfig.apiKey || process.env.NCE_DATASET_API_KEY;
  if (cli.printConfig || cli.dryRun) {
    console.log(
      `Dataset Builder configuration\nTasks: ${path.relative(process.cwd(), config.tasks)}\nOutput: ${path.relative(process.cwd(), config.output)}\nProvider: ${providerId}\nModel: ${model || "(missing)"}\nArtifacts: ${config.artifacts ? "enabled" : "disabled"}\nResume: ${config.resume ? "enabled" : "disabled"}\nAttempts: ${config.attempts}`,
    );
    return;
  }
  if (!model) throw new Error("--model or NCE_DATASET_MODEL is required");
  if (!baseURL)
    throw new Error("NCE_DATASET_BASE_URL is required for headless execution");
  const counts = {},
    durations = [],
    toolCounts = [],
    requestCounts = [];
  let completed = 0;
  const builder = new DatasetBuilder({
    writer,
    workspaceFactory: new WorkspaceFactory({ baseDir: source.baseDir }),
    keepWorkspaces: config.keepWorkspaces,
    appRoot: path.resolve(__dirname, "../.."),
    secrets: [apiKey],
    agentConfig: {
      providerId,
      model,
      baseURL,
      apiKey,
      provider: {
        id: providerId,
        baseURL,
        apiKey,
        requiresApiKey: Boolean(apiKey),
        supportsTools: true,
        ...(fileConfig.sessionHeader
          ? { sessionHeader: fileConfig.sessionHeader }
          : ["opencode-go", "opencode"].includes(providerId)
            ? { sessionHeader: "x-opencode-session" }
            : {}),
      },
      fallbackProviders: providerList.slice(1).map((item) => ({ id: item.providerId, model: item.model, baseURL: item.baseURL, apiKey: item.apiKey, supportsTools: true, requiresApiKey: Boolean(item.apiKey), ...(item.sessionHeader ? { sessionHeader: item.sessionHeader } : {}) })),
    },
    onResult(sample) {
      completed++;
      counts[sample.outcome] = (counts[sample.outcome] || 0) + 1;
      durations.push(sample.run.durationMs || 0);
      toolCounts.push(
        sample.metrics.toolCalls ||
          sample.trajectory.filter((step) => step.kind === "tool").length,
      );
      requestCounts.push(sample.metrics.modelRequests || 0);
      console.log(
        `[${completed}/${tasks.length}] ${sample.task.id}\n  Agent: ${sample.run.status}\n  Validator: ${sample.validation.passed ? "PASS" : "FAIL"}\n  Tools: ${toolCounts.at(-1)}\n  Model requests: ${requestCounts.at(-1)}\n  Duration: ${((sample.run.durationMs || 0) / 1000).toFixed(1)}s\n  Written: ${sample.sampleId}`,
      );
    },
  });
  await builder.build(tasks, { resume: config.resume, taskDelayMs: config.taskDelayMs, stopOnQuota: config.stopOnQuota });
  const average = (values) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  console.log(
    `\n${completed} tasks\n${Object.entries(counts)
      .map(([name, count]) => `${count} ${name}`)
      .join(
        "\n",
      )}\naverage duration: ${(average(durations) / 1000).toFixed(2)}s\naverage tools: ${average(toolCounts).toFixed(2)}\naverage model requests: ${average(requestCounts).toFixed(2)}`,
  );
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
