const fs = require("node:fs/promises");
const path = require("node:path");
class DatasetExporter {
  async read(input) {
    const rows = (await fs.readFile(input, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    return rows.map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`${input}:${i + 1}: invalid JSON`);
      }
    });
  }
  eligible(s, includeFailures = false) {
    return includeFailures
      ? Boolean(s.task?.prompt && s.trajectory)
      : s.outcome === "validated_success" &&
          s.validation?.passed === true &&
          s.integrity?.valid === true &&
          s.quality?.usableForSFT !== false &&
          Boolean(s.task?.prompt && Array.isArray(s.trajectory));
  }
  conversation(s) {
    const messages = [{ role: "user", content: s.task.prompt }];
    let call = 0;
    for (const step of s.trajectory || []) {
      if (step.kind === "tool") {
        const id = `call_${++call}`;
        messages.push({
          role: "assistant",
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: step.name || step.toolName || "tool",
                arguments:
                  typeof step.arguments === "string"
                    ? JSON.parse(step.arguments)
                    : step.arguments || {},
              },
            },
          ],
        });
        messages.push({
          role: "tool",
          tool_call_id: id,
          name: step.name || step.toolName || "tool",
          content:
            typeof step.result === "string"
              ? step.result
              : JSON.stringify(step.result ?? {}),
        });
      }
    }
    if (s.agentResult?.response || s.finalResponse)
      messages.push({
        role: "assistant",
        content: s.agentResult?.response || s.finalResponse,
      });
    return messages;
  }
  async export({
    input,
    output,
    format = "nce-sft",
    split,
    bestOnly = true,
    allAttempts = false,
    includeFailures = false,
    dryRun = false,
  }) {
    let samples = (await this.read(input))
      .filter((s) => !split || s.task?.split === split)
      .filter((s) => split !== "benchmark" || Boolean(split));
    if (!includeFailures) samples = samples.filter((s) => this.eligible(s));
    if (bestOnly && !allAttempts) {
      const best = new Map();
      for (const s of samples) {
        const key = s.task?.id;
        if (
          !best.has(key) ||
          Number(s.objectiveScore?.total || 0) >
            Number(best.get(key).objectiveScore?.total || 0)
        )
          best.set(key, s);
      }
      samples = [...best.values()];
    }
    const rows = samples.map((s) => ({
      id: s.sampleId,
      taskId: s.task.id,
      split: s.task.split || "train",
      messages: this.conversation(s),
      metadata: {
        attempt: s.attempt,
        model: s.model?.model || null,
        outcome: s.outcome,
        trainingEligible: this.eligible(s),
      },
    }));
    if (dryRun)
      return {
        format,
        samples: rows.length,
        trainingEligible: rows.filter((x) => x.metadata.trainingEligible)
          .length,
      };
    const dir = path.join(output, format);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${split || "train"}.jsonl`);
    await fs.writeFile(
      target,
      rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : ""),
    );
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify(
        {
          format,
          input,
          samples: rows.length,
          trainingEligible: rows.filter((x) => x.metadata.trainingEligible)
            .length,
        },
        null,
        2,
      ) + "\n",
    );
    return { target, samples: rows.length };
  }
}
module.exports = { DatasetExporter };
