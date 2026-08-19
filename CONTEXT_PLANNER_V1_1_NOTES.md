# FreeSeek Context Planner v1.1 — Experiment-Driven Update

This update is intentionally smaller than the originally considered Tree-sitter/LSP indexing phase. The new development rule was applied first: reproduce a stable failure, classify it, then change only the mechanism implicated by the experiment.

## Experiment finding

The public context fixtures were probed twice: once with their explicit production path and once with that exact path removed while preserving the business requirement and negative instructions.

At a 1500-token planner budget:

| Variant | Hit@1 | Hit@3 | MRR | Avg estimated planner tokens | Ranking misses |
| --- | ---: | ---: | ---: | ---: | ---: |
| v1 | 50.0% | 100.0% | 0.729 | 512 | 4 |
| v1.1 | 100.0% | 100.0% | 1.000 | 579 | 0 |

The four path-hidden probes were 0/4 Top-1 under v1 while still 4/4 Top-3. The failure was therefore a ranking problem, not an indexing-coverage problem.

## What changed

- Added `contextPlanner=v1.1` as an experimental mode.
- v1.1 reuses the same bounded repo map, lightweight symbols, import/importer expansion and token budget as v1.
- Added negative-intent parsing for instructions such as "不要修改 tests/legacy/build/example" / "do not edit tests".
- Explicitly excluded paths are strongly down-ranked instead of receiving lexical credit from the task wording.
- Tests/docs/examples receive conservative penalties unless the task asks to edit them.
- Production/runtime paths receive a small query-dependent preference.
- Added `freeseek-bench context-retrieval` for deterministic Hit@K/MRR/failure-class experiments without model cost.
- Generalized `freeseek-bench ab-context` with `--baseline-planner` and `--candidate-planner` so real-model v1 → v1.1 experiments are first-class.

## What did not change

- Product default remains `contextPlanner=off`.
- v1 remains available for baseline reproduction.
- No Tree-sitter/LSP index daemon, vector store or embedding dependency was added.
- Retrieval-only results are not treated as evidence of better end-to-end Agent correctness.

## Promotion gate

Run the exact same model/provider/suite/filter/repeat across Public, Private Holdout and Real Repo where relevant:

```bash
freeseek-bench ab-context \
  --baseline-planner v1 \
  --candidate-planner v1.1 \
  --base-url <url> \
  --api-key <key> \
  --model <model> \
  --repeat 3
```

Only after correctness is non-regressive should token/steps/tool-call/duration savings be used to decide whether v1.1 should become the default.
