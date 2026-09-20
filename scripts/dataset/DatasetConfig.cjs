const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unknown argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (["resume", "artifacts", "keepWorkspaces", "printConfig", "dryRun"].includes(name)) out[name] = true;
    else if (["noResume", "noArtifacts", "noKeepWorkspaces"].includes(name)) out[name.slice(2, 3).toLowerCase() + name.slice(3)] = false;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`missing value for ${key}`); out[name] = argv[++i]; }
  }
  return out;
}
function loadDatasetConfig({ configPath, cli = {} } = {}) {
  const requested = configPath || path.resolve("dataset.json");
  if (!fs.existsSync(requested) && !configPath) throw new Error("Dataset configuration file not found: ./dataset.json");
  let file = {};
  if (fs.existsSync(requested)) { try { file = JSON.parse(fs.readFileSync(requested, "utf8")); } catch (error) { throw new Error(`Failed to parse ${path.basename(requested)}: ${error.message}`); } }
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Dataset config invalid: root must be an object");
  if (file.schemaVersion !== undefined && file.schemaVersion !== 1) throw new Error(`Unsupported dataset configuration schemaVersion: ${file.schemaVersion}`);
  const root = path.dirname(path.resolve(requested));
  const value = (key, fallback) => cli[key] !== undefined ? cli[key] : file[key] !== undefined ? file[key] : fallback;
  const bool = (key, fallback) => { const v = value(key, fallback); if (typeof v !== "boolean") throw new Error(`Dataset config invalid: "${key}" must be a boolean`); return v; };
  const config = { root, tasks: value("tasks"), output: value("output"), providerConfig: value("providerConfig"), artifacts: bool("artifacts", false), resume: bool("resume", false), keepWorkspaces: bool("keepWorkspaces", false), provider: value("provider"), model: value("model"), baseURL: value("baseURL"), apiKey: value("apiKey"), task: value("task"), limit: value("limit"), attempts: value("attempts", 1), limits: file.limits || {} };
  if (!config.tasks) throw new Error('Dataset config invalid: missing "tasks"');
  if (!config.output) throw new Error('Dataset config invalid: missing "output"');
  for (const key of ["tasks", "output", "providerConfig"]) if (config[key]) config[key] = path.resolve(root, config[key]);
  return config;
}
module.exports = { parseArgs, loadDatasetConfig };
