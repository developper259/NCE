class RuntimeResolver {
  constructor(agent) {
    this.agent = agent;
    this.cache = new Map();
  }

  async resolve(strategy, projectRoot) {
    const key = `${strategy}:${projectRoot || ""}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const result = await this.agent.api?.resolveAgentRuntime?.({
      strategy,
      projectRoot,
    });
    const resolved =
      result && typeof result === "object" ? result : { available: true };
    this.cache.set(key, resolved);
    return resolved;
  }
}

window.RuntimeResolver = RuntimeResolver;
