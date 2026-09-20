const EVENTS = ["run:start", "run:end", "model:request:start", "model:request:end", "model:retry", "model:fallback", "model:status", "tool:start", "tool:end", "response:token", "response:reasoning", "session:info", "agent:error"];

class TrajectoryRecorder {
  constructor(options = {}) {
    this.events = []; this.unsubscribers = []; this.startedAt = 0;
    this.maxToolResultChars = options.maxRecordedToolResultChars || 50000;
  }
  attach(agent) {
    if (this.unsubscribers.length) throw new Error("recorder already attached");
    this.startedAt = Date.now();
    for (const type of EVENTS) this.unsubscribers.push(agent.subscribe(type, (payload) => this.record(type, payload)));
    return this;
  }
  detach() { for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe(); }
  record(type, payload) { this.events.push({ seq: this.events.length + 1, type, timestamp: Date.now(), elapsedMs: Date.now() - this.startedAt, payload }); }
  build() {
    const issues = [], tools = new Map(), models = new Map(), trajectory = [];
    let runStarted = false, runEnded = false, finalResponse = "", reasoning = "", run = null;
    for (const event of this.events) {
      const p = event.payload || {};
      if (runEnded && event.type !== "run:end") issues.push({ code: "EVENT_AFTER_RUN_END", seq: event.seq, type: event.type });
      if (event.type === "run:start") { if (runStarted) issues.push({ code: "DUPLICATE_RUN_START", seq: event.seq }); runStarted = true; run = { ...p }; }
      if (event.type === "run:end") { if (!runStarted) issues.push({ code: "RUN_END_WITHOUT_START", seq: event.seq }); if (runEnded) issues.push({ code: "DUPLICATE_RUN_END", seq: event.seq }); runEnded = true; run = { ...(run || {}), ...p }; }
      if (event.type === "response:token") finalResponse += p.content || "";
      if (event.type === "response:reasoning") reasoning += p.content || "";
      if (event.type === "model:request:start") { const key = `${p.requestId}:${p.attempt}`; if (models.has(key)) issues.push({ code: "DUPLICATE_MODEL_START", seq: event.seq, requestId: p.requestId }); models.set(key, { step: trajectory.length + 1, kind: "model_request", ...p }); }
      if (event.type === "model:request:end") { const key = `${p.requestId}:${p.attempt}`; const step = models.get(key); if (!step) issues.push({ code: "MODEL_END_WITHOUT_START", seq: event.seq, requestId: p.requestId }); else { Object.assign(step, p); trajectory.push(step); models.delete(key); } }
      if (event.type === "model:retry" || event.type === "model:fallback") trajectory.push({ step: trajectory.length + 1, kind: event.type === "model:retry" ? "model_retry" : "model_fallback", ...p });
      if (event.type === "tool:start") { const key = p.toolCallId || `seq:${event.seq}`; if (tools.has(key)) issues.push({ code: "DUPLICATE_TOOL_START", seq: event.seq, toolCallId: p.toolCallId }); tools.set(key, { step: trajectory.length + 1, kind: "tool", toolCallId: p.toolCallId, name: p.toolName, arguments: p.arguments, startedAt: p.startedAt }); }
      if (event.type === "tool:end") { const key = p.toolCallId || [...tools.keys()].find((candidate) => candidate.startsWith("seq:")); const step = tools.get(key); if (!step) issues.push({ code: "TOOL_END_WITHOUT_START", seq: event.seq, toolCallId: p.toolCallId }); else { Object.assign(step, { status: p.status, result: p.result, error: p.error, durationMs: p.durationMs, endedAt: p.endedAt }); trajectory.push(step); tools.delete(key); } }
    }
    for (const step of tools.values()) issues.push({ code: "TOOL_START_WITHOUT_END", toolCallId: step.toolCallId });
    for (const step of models.values()) issues.push({ code: "MODEL_START_WITHOUT_END", requestId: step.requestId });
    if (runStarted && !runEnded) issues.push({ code: "RUN_START_WITHOUT_END" });
    trajectory.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).forEach((step, i) => { step.step = i + 1; });
    return { run, trajectory, finalResponse, diagnostics: reasoning ? { reasoning } : {}, integrity: { valid: issues.length === 0, issues } };
  }
}
module.exports = { TrajectoryRecorder, EVENTS };
