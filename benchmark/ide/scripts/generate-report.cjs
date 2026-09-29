#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { renderMarkdown } = require("../reporters/markdown.cjs");

const input = process.argv[2];
if (!input || input === "--help" || input === "-h") {
  console.log("Usage: node benchmark/ide/scripts/generate-report.cjs run.json [report.md]");
  process.exitCode = input ? 0 : 1;
} else {
  try {
    const source = path.resolve(input);
    const result = JSON.parse(fs.readFileSync(source, "utf8"));
    const output = path.resolve(process.argv[3] || source.replace(/\.json$/i, ".md"));
    fs.writeFileSync(output, renderMarkdown(result), "utf8");
    console.log(`Markdown report written to ${output}`);
  } catch (error) {
    console.error(`Could not generate report: ${error.message}`);
    process.exitCode = 1;
  }
}
