const fs = require("node:fs");
const file = "dataset/private/provider.json";
const input = JSON.parse(fs.readFileSync(file, "utf8"));
if (input && input.schemaVersion === 2) { console.log("provider.json already uses schemaVersion 2"); process.exit(0); }
const entries = Array.isArray(input) ? input : [input]; const providers = {}; const routing = [];
for (const item of entries) { if (!item?.providerId || !item?.model || !item?.baseURL) continue; const providerId = item.providerId === "opencode-go" ? "opencode" : item.providerId; if (!providers[providerId]) providers[providerId] = { baseURL: item.baseURL, apiKey: item.apiKey, ...(item.sessionHeader ? { sessionHeader: item.sessionHeader } : providerId === "opencode" ? { sessionHeader: "x-opencode-session" } : {}), supportsTools: item.supportsTools !== false, supportsToolChoice: item.supportsToolChoice !== false, models: {} }; providers[providerId].models[item.model] = { enabled: true }; routing.push({ providerId, model: item.model }); }
if (!routing.length) throw new Error("provider.json contains no valid provider/model entries");
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, providers, routing: { primary: routing[0], fallbacks: routing.slice(1) }, recovery: { maxRetriesPerCandidate: 2, maxWaitMs: 30000, defaultCooldownMs: 30000 } }, null, 2) + "\n", { mode: 0o600 }); fs.chmodSync(file, 0o600); console.log(`Migrated ${routing.length} provider model entries across ${Object.keys(providers).length} providers.`);
