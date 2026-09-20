const { WorkspaceFactory } = require("./WorkspaceFactory");
const { WorkspaceSnapshot } = require("./WorkspaceSnapshot");
const { TrajectoryRecorder } = require("./TrajectoryRecorder");
const { ObjectiveValidator } = require("./ObjectiveValidator");
const { DatasetSanitizer } = require("./DatasetSanitizer");
const { AgentHarness } = require("./AgentHarness");

class DatasetBuilder {
  constructor(options) {
    this.writer = options.writer;
    this.workspaceFactory =
      options.workspaceFactory || new WorkspaceFactory(options);
    this.snapshot = options.snapshot || new WorkspaceSnapshot(options);
    this.validator = options.validator || new ObjectiveValidator(options);
    this.harness = options.harness || new AgentHarness(options);
    this.keepWorkspaces = options.keepWorkspaces === true;
    this.agentConfig = options.agentConfig || {};
    this.secrets = options.secrets || [];
    this.onResult = options.onResult || (() => {});
  }
  async build(tasks, options = {}) {
    const results = [];
    for (const task of tasks) {
      if (options.resume && this.writer.hasTask(task.id)) continue;
      const result = await this.runTask(task).catch((error) => ({
        taskId: task.id,
        infrastructureError: error,
      }));
      if (result.infrastructureError) throw result.infrastructureError;
      results.push(result);
      this.onResult(result);
    }
    return results;
  }
  async runTask(task, attemptNumber = 1) {
    const attempt = Number(attemptNumber),
      sampleId = `${task.id}:${attempt}`;
    const workspace = await this.workspaceFactory.create(task, attempt);
    let written = false;
    try {
      const initialSnapshot = await this.snapshot.capture(workspace.root);
      const agent = await this.harness.create(workspace.root, {
        ...this.agentConfig,
        permissions: task.agent?.permissions || "code",
      });
      const recorder = new TrajectoryRecorder(this.agentConfig);
      let agentError = null,
        agentResult = null;
      recorder.attach(agent);
      try {
        agentResult = await agent.execute(task.prompt, {
          sessionId: sampleId,
          providerId: this.agentConfig.providerId,
        });
      } catch (error) {
        agentError = error;
      } finally {
        recorder.detach();
      }
      const recorded = recorder.build();
      const finalSnapshot = await this.snapshot.capture(workspace.root);
      const changes = this.snapshot.diff(initialSnapshot, finalSnapshot);
      const validation = await this.validator.validate({
        task,
        workspaceRoot: workspace.root,
        initialSnapshot,
        finalSnapshot,
        diff: changes,
      });
      const status =
        recorded.run?.status ||
        (agentError?.name === "AbortError"
          ? "aborted"
          : agentError
            ? "failed"
            : "completed");
      const outcome =
        status === "aborted"
          ? "aborted"
          : status !== "completed"
            ? "agent_failed"
            : !recorded.integrity.valid
              ? "invalid_trace"
              : validation.passed
                ? "validated_success"
                : "failed_validation";
      const modelEnds = recorder.events.filter(
        (event) => event.type === "model:request:end",
      );
      const usage = modelEnds.reduce(
        (sum, event) => {
          const item = event.payload?.usage || {};
          sum.inputTokens += item.inputTokens || item.promptTokens || 0;
          sum.outputTokens += item.outputTokens || item.completionTokens || 0;
          sum.totalTokens += item.totalTokens || 0;
          return sum;
        },
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      );
      const sample = {
        schemaVersion: 1,
        sampleId,
        attempt,
        task: {
          id: task.id,
          prompt: task.prompt,
          ...(task.metadata ? { metadata: task.metadata } : {}),
        },
        run: {
          sessionId: recorded.run?.sessionId || sampleId,
          runId: recorded.run?.runId || null,
          status,
          startedAt: recorded.run?.startedAt || null,
          endedAt: recorded.run?.endedAt || null,
          durationMs: recorded.run?.durationMs || null,
        },
        model: {
          providerId: this.agentConfig.providerId || agent.provider?.id || null,
          model: this.agentConfig.model || agent.model || null,
        },
        trajectory: recorded.trajectory,
        agentResult: {
          response: recorded.finalResponse || agentResult?.response || "",
          completion: agentResult || null,
          error: agentError
            ? {
                name: agentError.name,
                message: agentError.message,
                code: agentError.code || null,
              }
            : null,
        },
        changes,
        validation,
        metrics: {
          ...(recorded.run?.metrics || agentResult?.metrics || {}),
          modelRequests: modelEnds.length,
          retryCount: recorder.events.filter(
            (event) => event.type === "model:retry",
          ).length,
          fallbackCount: recorder.events.filter(
            (event) => event.type === "model:fallback",
          ).length,
          ...usage,
        },
        integrity: recorded.integrity,
        outcome,
        ...(Object.keys(recorded.diagnostics).length
          ? { diagnostics: recorded.diagnostics }
          : {}),
      };
      const sanitizer = new DatasetSanitizer({
        workspaceRoot: workspace.root,
        secrets: this.secrets,
      });
      const safeSample = sanitizer.sanitize(sample),
        safeEvents = sanitizer.sanitize(recorder.events);
      const quotaFailure = /quota|rate.?limit|too many requests|credits? exhausted|usage limit|429/i.test(agentError?.message || "");
      if (quotaFailure) {
        written = true;
        return safeSample;
      }
      await this.writer.write(safeSample, quotaFailure ? {} : {
        events: safeEvents,
        validation: safeSample.validation,
        changes: safeSample.changes,
        metadata: {
          initialSnapshot: sanitizer.sanitize(initialSnapshot),
          finalSnapshot: sanitizer.sanitize(finalSnapshot),
        },
      });
      written = true;
      return safeSample;
    } finally {
      if (!this.keepWorkspaces && written) await workspace.cleanup();
      else if (!this.keepWorkspaces && !written)
        console.error(
          `Dataset workspace preserved after write failure: ${workspace.root}`,
        );
    }
  }
}
module.exports = { DatasetBuilder };
