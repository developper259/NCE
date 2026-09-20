# NCE-Agent-Bench v0.1 — Generation report

## Created

- 100 original task definitions: 20 NO_TOOL, 20 READ_ONLY, 20 WRITE, 20 DEBUG_TEST, 20 ERROR_RECOVERY.
- 25 synthetic projects containing 6–9 files each across TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, and HTML/JavaScript.
- 60 evaluator-only hidden-test specifications for all mutation, debugging, and recovery tasks.
- Common adapter API plus NCE/local, generic OpenAI-compatible, OpenAI, Anthropic, and mock adapters.
- Isolated runner, normalized traces, filesystem snapshots/diffs, deterministic evaluator, validator, reports, comparison, filtering, multiple runs, resume and dry-run support.

## NCE integration inspected

The benchmark loads NCE through `src/js/agent/dataset/AgentHarness.js` and therefore uses the production `Agent`, `AgentRunner`, system prompt, message format, limits, and tool registry. Detected tool schemas include `run_tests`, `task_complete`, `get_changed_files`, `get_diff`, `create_file`, `write_file_chunk`, `rename_file`, `delete_file`, `modify_file`, `read_file`, `get_project_map`, and `search_code`. Completion follows NCE's real diff-review and `task_complete` protocol. No production agent code was modified.

## Commands

- `npm run benchmark:validate`
- `npm run benchmark -- --model <name> [--runs 3] [--resume]`
- `npm run benchmark:compare -- <model-a> <model-b>`
- `npm run benchmark:report`

## Known limitations

- Fine-grained semantic hallucination detection remains conservative and deterministic.
- Cost is recorded when providers expose enough usage/pricing metadata; the benchmark does not guess missing prices.
- Cross-language hidden checks are declarative and focus on observable filesystem outcomes.
- The mock adapter is only a framework smoke test and must not be interpreted as a model result.

## Validation target

Run `npm run benchmark:validate` to verify task counts, IDs, JSON, projects, permissions, hidden-test references, task content, fixture sizes, and hidden-test isolation.
