const fs = require("node:fs");
const file = "dataset/private/provider.json";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if (!config || config.schemaVersion !== 2 || !config.providers || !config.routing) throw new Error("provider.json must use schemaVersion 2 first");
config.providers.openrouter ||= { baseURL: "https://openrouter.ai/api/v1/chat/completions", apiKey: "", supportsTools: true, supportsToolChoice: true, models: { "qwen/qwen3-coder:free": { enabled: true }, "cohere/north-mini-code:free": { enabled: true }, "nvidia/nemotron-3-ultra-550b-a55b:free": { enabled: true } } };
config.providers.antigravity ||= { baseURL: "http://127.0.0.1:8080/v1/chat/completions", apiKey: "", supportsTools: true, supportsToolChoice: true, models: { MODEL_ID_1: { enabled: true }, MODEL_ID_2: { enabled: true } } };
const existing = new Set([config.routing.primary, ...(config.routing.fallbacks || [])].map((x) => `${x.providerId}:${x.model}`));
for (const [providerId, definition] of [["openrouter", config.providers.openrouter], ["antigravity", config.providers.antigravity]]) for (const model of Object.keys(definition.models || {})) if (definition.models[model].enabled !== false && !existing.has(`${providerId}:${model}`)) config.routing.fallbacks.push({ providerId, model });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 }); fs.chmodSync(file, 0o600); console.log("Added openrouter and antigravity provider routes.");
