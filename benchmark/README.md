# NCE-Agent-Bench v0.1

NCE-Agent-Bench compares coding models as agents: it measures task completion, the decision not to use tools, read-only discipline, grounded workspace use, recovery, efficiency, termination, latency, tokens, and cost metadata. Its primary score is deterministic and does not use an LLM judge.

## Contents

- `tasks/`: 100 original tasks, split equally across NO_TOOL, READ_ONLY, WRITE, DEBUG_TEST, and ERROR_RECOVERY.
- `projects/`: 25 isolated synthetic fixtures in nine language families.
- `hidden_tests/`: evaluator-only declarative checks. These are outside copied workspaces.
- `runners/`: the common adapter contract, NCE runner, OpenAI-compatible, OpenAI, Anthropic, and deterministic mock adapters.
- `evaluator/`: success, permissions, tool policy, grounding, efficiency, recovery, and loop scoring.
- `results/`: raw execution traces. Empty in source control.
- `reports/`: generated leaderboards and per-model reports. Empty until real runs exist.

## Scoring

Each task is scored on 100 points: task success 50, permission respect 15, tool selection 10, grounding 10, efficiency 5, recovery 5, and completion/loop avoidance 5. An unrequested write or delete caps the total at 20. Cost, token, and latency metrics are reported separately.

## Setup and model configuration

Copy `config/models.example.json` to `config/models.json` and edit endpoints/model names. Secrets are read only from the environment variables named by `apiKeyEnv` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NCE_API_KEY`, etc.). `NCE_BENCH_MODELS` can point to another model configuration file. Default temperature is zero.

All providers receive the same task, production NCE tool schemas and loop, workspace fixture, limits, and hidden checks. Provider adapters only translate wire formats. The runner copies the fixture into a fresh OS temporary directory, and `AgentHarness` rejects paths outside it. Hidden tests are never copied there.

## Commands

```bash
npm run benchmark:validate
npm run benchmark -- --model nce-coder
npm run benchmark -- --model qwen-base --runs 3
npm run benchmark -- --model mock --task no_tool_001
npm run benchmark -- --model nce-coder --category read_only
npm run benchmark -- --model nce-coder --difficulty hard --resume
npm run benchmark -- --model gpt --dry-run
npm run benchmark:compare -- nce-coder qwen-base
npm run benchmark:report
```

`--keep-workspaces` retains temporary workspaces for debugging. Without it they are removed after the trace is saved. Each result is stored under `results/<run-id>/<model>/<task-id>.json`; it includes prompt, model, messages where applicable, normalized calls/results, timestamps, usage, iterations, latency, final answer, filesystem diff, score, and failure flags.

## Adding a model or task

Add a model entry using `mock`, `nce`, `openai-compatible`, `openai`, or `anthropic`. Add tasks as JSON beneath the matching category directory. A task declares its project, permissions, limits and either structured facts or a hidden-test ID. Hidden checks support `file_contains`, `json_value`, `workspace_changed`, and `final_answer`. Run validation after every change.

## Reproducibility and limitations

The configuration records benchmark version, seed, temperature, prompts, model name and limits. Provider-side model revisions and nondeterministic infrastructure remain external variables. Grounding detection is conservative: deterministic evidence and explicit runtime flags are scored, but subtle semantic hallucinations may require later analysis. Declarative hidden checks intentionally favor portability across fixture languages; they are not a substitute for full compiler suites. The mock validates framework plumbing only and is excluded from reports unless explicitly executed and reported; it is not a model score.
