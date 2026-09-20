const fs = require("node:fs/promises");
const path = require("node:path");

class TaskSource {
  static async read(filePath) {
    const absolutePath = path.resolve(filePath);
    const input = await fs.readFile(absolutePath, "utf8");
    const tasks = [];
    const ids = new Set();
    for (const [index, raw] of input.split(/\r?\n/).entries()) {
      if (!raw.trim()) continue;
      let task;
      try { task = JSON.parse(raw); }
      catch (error) { throw new Error(`${absolutePath}:${index + 1}: invalid JSON: ${error.message}`); }
      const fail = (message) => { throw new Error(`${absolutePath}:${index + 1}: ${message}`); };
      if (!task || typeof task !== "object" || Array.isArray(task)) fail("task must be an object");
      if (typeof task.id !== "string" || !task.id.trim()) fail("id is required");
      if (ids.has(task.id)) fail(`duplicate id: ${task.id}`);
      if (typeof task.prompt !== "string" || !task.prompt.trim()) fail("prompt is required");
      if (!task.workspace || typeof task.workspace.template !== "string" || !task.workspace.template.trim()) fail("workspace.template is required");
      if (task.validation != null && (typeof task.validation !== "object" || Array.isArray(task.validation))) fail("validation must be an object");
      ids.add(task.id);
      tasks.push({ ...task, id: task.id.trim(), prompt: task.prompt.trim(), sourceLine: index + 1 });
    }
    return { tasks, filePath: absolutePath, baseDir: path.dirname(absolutePath) };
  }
}

module.exports = { TaskSource };
