const fs = require("node:fs/promises");
const path = require("node:path");

class DatasetWriter {
  constructor(outputDir, options = {}) {
    this.outputDir = path.resolve(outputDir);
    this.filePath = path.join(this.outputDir, "dataset.jsonl");
    this.artifacts = options.artifacts === true;
    this.ids = new Set();
    this.taskIds = new Set();
  }
  async initialize() {
    await fs.mkdir(this.outputDir, { recursive: true });
    let input = "";
    try {
      input = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const [index, line] of input.split(/\r?\n/).entries())
      if (line.trim()) {
        let sample;
        try {
          sample = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `${this.filePath}:${index + 1}: invalid existing JSONL`,
          );
        }
        this.ids.add(sample.sampleId);
        if (sample.task?.id) this.taskIds.add(sample.task.id);
      }
    return this;
  }
  hasTask(id) {
    return this.taskIds.has(id);
  }
  async write(sample, debug = {}) {
    if (this.ids.has(sample.sampleId))
      throw new Error(`duplicate sampleId: ${sample.sampleId}`);
    const line = JSON.stringify(sample) + "\n";
    await fs.appendFile(this.filePath, line, "utf8");
    this.ids.add(sample.sampleId);
    if (sample.task?.id) this.taskIds.add(sample.task.id);
    if (this.artifacts) await this.writeArtifacts(sample.sampleId, debug);
    return this.filePath;
  }
  async writeArtifacts(sampleId, debug) {
    const safeId = sampleId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const dir = path.join(this.outputDir, "artifacts", safeId);
    await fs.mkdir(dir, { recursive: true });
    if (debug.events)
      await fs.writeFile(
        path.join(dir, "events.jsonl"),
        debug.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
    for (const name of ["validation", "changes", "metadata"])
      if (debug[name])
        await fs.writeFile(
          path.join(dir, `${name}.json`),
          JSON.stringify(debug[name], null, 2) + "\n",
        );
  }
}
module.exports = { DatasetWriter };
