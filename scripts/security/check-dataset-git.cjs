#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const forbidden = tracked.filter((file) => file === "dataset/private/provider.json" || file.startsWith("dataset/output/") || file.startsWith("dataset/artifacts/") || file.startsWith("dataset/workspaces/") || file.startsWith(".nce/dataset-workspaces/"));
if (forbidden.length) { console.error("SECURITY ERROR:\nDo not commit Dataset Builder credentials or generated datasets.\n" + forbidden.join("\n")); process.exit(1); }
console.log("Dataset Git safety: OK");
