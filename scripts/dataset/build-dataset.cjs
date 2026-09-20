#!/usr/bin/env node
const path = require("node:path");
const fs = require("node:fs");
const { TaskSource } = require("../../src/js/agent/dataset/TaskSource");
const { WorkspaceFactory } = require("../../src/js/agent/dataset/WorkspaceFactory");
const { DatasetWriter } = require("../../src/js/agent/dataset/DatasetWriter");
const { DatasetBuilder } = require("../../src/js/agent/dataset/DatasetBuilder");

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (["--resume", "--keep-workspaces", "--artifacts"].includes(key)) options[key.slice(2)] = true;
    else if (key.startsWith("--")) { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`missing value for ${key}`); options[key.slice(2)] = argv[++i]; }
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!options.tasks || !options.output) throw new Error("usage: npm run dataset:build -- --tasks path/to/tasks.jsonl --output path/to/output [--provider id] [--model id] [--provider-config path] [--resume] [--artifacts]");
  return options;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const configPath = args["provider-config"] || path.resolve("dataset/private/provider.json");
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try { fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (error) { throw new Error(`Dataset provider configuration invalid: ${error.message}`); }
    for (const field of ["providerId", "model"]) if (!fileConfig[field] || typeof fileConfig[field] !== "string") throw new Error(`Dataset provider configuration invalid: missing "${field}"`);
    if (fileConfig.apiKey && process.platform !== "win32") { const mode = fs.statSync(configPath).mode & 0o777; if (mode & 0o077) console.warn("provider.json contains credentials and is readable by other users. Recommended permissions: chmod 600 provider.json"); }
  } else if (args["provider-config"]) throw new Error(`Dataset provider configuration not found: ${configPath}`);
  const source = await TaskSource.read(args.tasks);
  let tasks = args.task ? source.tasks.filter((task) => task.id === args.task) : source.tasks;
  if (args.limit) tasks = tasks.slice(0, Number.parseInt(args.limit, 10));
  if (!tasks.length) throw new Error("no task selected");
  const writer = await new DatasetWriter(args.output, { artifacts: args.artifacts }).initialize();
  const providerId = args.provider || fileConfig.providerId || process.env.NCE_DATASET_PROVIDER || "openai-compatible";
  const model = args.model || fileConfig.model || process.env.NCE_DATASET_MODEL;
  const baseURL = fileConfig.baseURL || process.env.NCE_DATASET_BASE_URL;
  const apiKey = fileConfig.apiKey || process.env.NCE_DATASET_API_KEY;
  if (!model) throw new Error("--model or NCE_DATASET_MODEL is required");
  if (!baseURL) throw new Error("NCE_DATASET_BASE_URL is required for headless execution");
  const counts = {}, durations = [], toolCounts = [], requestCounts = [];
  let completed = 0;
  const builder = new DatasetBuilder({
    writer,
    workspaceFactory: new WorkspaceFactory({ baseDir: source.baseDir }),
    keepWorkspaces: args["keep-workspaces"],
    appRoot: path.resolve(__dirname, "../.."),
    secrets: [apiKey],
    agentConfig: { providerId, model, baseURL, apiKey, provider: { id: providerId, baseURL, apiKey, requiresApiKey: Boolean(apiKey), supportsTools: true } },
    onResult(sample) {
      completed++; counts[sample.outcome] = (counts[sample.outcome] || 0) + 1; durations.push(sample.run.durationMs || 0); toolCounts.push(sample.metrics.toolCalls || sample.trajectory.filter((step) => step.kind === "tool").length); requestCounts.push(sample.metrics.modelRequests || 0);
      console.log(`[${completed}/${tasks.length}] ${sample.task.id}\n  Agent: ${sample.run.status}\n  Validator: ${sample.validation.passed ? "PASS" : "FAIL"}\n  Tools: ${toolCounts.at(-1)}\n  Model requests: ${requestCounts.at(-1)}\n  Duration: ${((sample.run.durationMs || 0) / 1000).toFixed(1)}s\n  Written: ${sample.sampleId}`);
    },
  });
  await builder.build(tasks, { resume: args.resume });
  const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  console.log(`\n${completed} tasks\n${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join("\n")}\naverage duration: ${(average(durations) / 1000).toFixed(2)}s\naverage tools: ${average(toolCounts).toFixed(2)}\naverage model requests: ${average(requestCounts).toFixed(2)}`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
