# Context Planner v1.1 Experiment

## Hypothesis

Context Planner v1 already retrieves the correct production file, but negative instructions such as "不要修改 tests / legacy / build / example config" are treated as ordinary lexical evidence. Test files and examples therefore outrank the production implementation even when the correct file remains in Top-3.

The smallest useful intervention is a ranking fix, not a heavier AST/LSP index.

## Protocol

Run the deterministic retrieval-only probe suite before spending model tokens:

```bash
freeseek-bench context-retrieval \
  --context-plan-budget 1500 \
  --out ~/.freesek/bench/context-retrieval
```

The suite contains eight probes derived from the four public context-regression fixtures:

- 4 explicit-path controls;
- 4 path-hidden probes that keep the business requirement and negative instructions but remove the exact production path.

The target file is evaluator-only metadata and is never injected into the planner query.

## Result

| Variant | Hit@1 | Hit@3 | MRR | Avg estimated planner tokens | Ranking misses |
| --- | ---: | ---: | ---: | ---: | ---: |
| v1 | 50.0% | 100.0% | 0.729 | 512 | 4 |
| v1.1 | 100.0% | 100.0% | 1.000 | 579 | 0 |

On the four path-hidden probes specifically:

- v1: 0/4 Top-1, 4/4 Top-3;
- v1.1: 4/4 Top-1, 4/4 Top-3.

The stable failure mode in v1 was `ranking_miss`, not `retrieval_miss`, `dependency_miss`, or `budget_overflow`.

## Change selected by the experiment

v1.1 keeps the same bounded repo scan, lightweight symbols, import graph, and context budget. It only changes ranking semantics:

- negative-intent terms are not rewarded as positive lexical evidence;
- explicitly excluded tests/legacy/build/generated/example-like paths receive a strong penalty;
- tests/docs/examples receive conservative default penalties when the task does not ask to edit them;
- production/runtime paths receive a small positive bias only when the query itself expresses production/runtime intent.

## Decision

- Keep `off` as the product default.
- Keep both `v1` and `v1.1` selectable for controlled experiments.
- Do **not** add Tree-sitter/LSP indexing yet: this experiment does not show an indexing-coverage bottleneck.
- The next promotion gate is real-model A/B on Public + Private + Real suites.

Recommended model-level comparison:

```bash
freeseek-bench ab-context \
  --baseline-planner v1 \
  --candidate-planner v1.1 \
  --base-url <url> \
  --api-key <key> \
  --model <model> \
  --repeat 3
```

A default-on decision requires correctness to remain non-regressive. Token/step/tool-call savings are secondary metrics and cannot compensate for a correctness regression.
