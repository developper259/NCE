const AgentPrompts = (() => {
  const modePrompts = {
    coder: AgentPromptCoder,
    ask: AgentPromptAsk,
    plan: AgentPromptPlan,
    explain: AgentPromptExplain,
  };

  const modelPrompts = {
    openai: AgentPromptModelOpenAI,
    anthropic: AgentPromptModelAnthropic,
    qwen: AgentPromptModelQwen,
    llama: AgentPromptModelLlama,
    mistral: AgentPromptModelMistral,
  };

  function resolveModelFamily(modelId = "") {
    const id = String(modelId).trim().toLowerCase();
    if (/^(?:qwen|qwen\/)/.test(id)) return "qwen";
    if (/^(?:llama-|meta-llama\/)/.test(id)) return "llama";
    if (/^(?:claude|anthropic\/)/.test(id)) return "anthropic";
    if (/^(?:mistral|codestral)/.test(id)) return "mistral";
    if (/^(?:gpt-|openai\/)/.test(id)) return "openai";
    return null;
  }

  function getSystemPrompt({ agentId, modelId } = {}) {
    const modePrompt = modePrompts[agentId];
    if (typeof modePrompt !== "string") {
      throw new Error(`Prompt agent inconnu : ${agentId || "(vide)"}`);
    }
    const modelFamily = resolveModelFamily(modelId);
    return [AgentPromptBase, modePrompt, modelPrompts[modelFamily]]
      .filter((part) => typeof part === "string" && part.trim())
      .map((part) => part.trim())
      .join("\n\n");
  }

  return {
    getSystemPrompt,
    resolveModelFamily,
  };
})();
