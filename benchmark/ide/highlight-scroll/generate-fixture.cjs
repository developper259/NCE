const fs = require("node:fs");
const path = require("node:path");

const fixtureLines = 1400;

function createFixtureText() {
  const rows = [];
  for (let moduleIndex = 0; moduleIndex < 40; moduleIndex += 1) {
    const name = `Feature${String(moduleIndex).padStart(2, "0")}`;
    const base = moduleIndex * 17;
    rows.push(
      `/** Coordinates ${name} state and asynchronous updates. */`,
      `export class ${name}Service {`,
      `  #revision = ${base};`,
      `  #entries = new Map();`,
      `  constructor(repository, logger = console) {`,
      `    this.repository = repository;`,
      `    this.logger = logger;`,
      `    this.options = { retryLimit: ${2 + moduleIndex % 4}, staleAfterMs: ${3000 + moduleIndex * 11} };`,
      `  }`,
      `  async load${name}(accountId, signal) {`,
      `    const key = String(accountId ?? "").trim();`,
      `    if (!key) throw new TypeError("account id is required");`,
      `    const cached = this.#entries.get(key);`,
      `    if (cached && Date.now() - cached.updatedAt < this.options.staleAfterMs) return cached.value;`,
      `    for (let attempt = 0; attempt <= this.options.retryLimit; attempt += 1) {`,
      `      try {`,
      `        const value = await this.repository.read(key, { signal, revision: this.#revision });`,
      `        this.#entries.set(key, { value, updatedAt: Date.now(), attempt });`,
      `        return value;`,
      `      } catch (error) {`,
      `        if (signal?.aborted || attempt === this.options.retryLimit) throw error;`,
      `        await new Promise((resolve) => setTimeout(resolve, 4 + attempt * 3));`,
      `      }`,
      `    }`,
      `    return null;`,
      `  }`,
      `  update${name}(entry, changes = {}) {`,
      `    const current = this.#entries.get(entry.id)?.value ?? entry;`,
      `    const next = { ...current, ...changes, revision: ++this.#revision };`,
      `    this.#entries.set(String(next.id), { value: next, updatedAt: Date.now(), attempt: 0 });`,
      `    return Object.freeze(next);`,
      `  }`,
      `  summarize${name}(values) {`,
      `    return values.reduce((result, value) => {`,
      `      const bucket = value?.status === "ready" ? "ready" : "pending";`,
      `      result[bucket] = (result[bucket] || 0) + 1;`,
      `      return result;`,
      `    }, { ready: 0, pending: 0 });`,
      `  }`,
      `  invalidate${name}(predicate = () => true) {`,
      `    for (const [key, record] of this.#entries) {`,
      `      if (predicate(record.value, key)) this.#entries.delete(key);`,
      `    }`,
      `    this.#revision += 1;`,
      `  }`,
      `}`,
      `export const ${name.toLowerCase()}Defaults = Object.freeze({`,
      `  pageSize: ${20 + moduleIndex % 5 * 10},`,
      `  sortBy: ["updatedAt", "displayName"],`,
      `  flags: { enabled: ${moduleIndex % 2 === 0}, audit: ${moduleIndex % 3 === 0} },`,
      `});`,
      ``,
    );
  }
  return rows.slice(0, fixtureLines).join("\n");
}

function generateFixture(outputPath = path.resolve(".benchmark-data/ide/fixtures/highlight-scroll.js")) {
  const text = createFixtureText();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, "utf8");
  return {
    path: outputPath,
    bytes: Buffer.byteLength(text),
    lines: fixtureLines,
    maxLineLength: Math.max(...text.split("\n").map((line) => line.length)),
  };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(generateFixture())}\n`);

module.exports = { createFixtureText, generateFixture, fixtureLines };
