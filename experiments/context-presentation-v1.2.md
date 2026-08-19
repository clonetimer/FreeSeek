# Context Presentation v1.2 Experiment

## Hypothesis

With v1.1 retrieval held constant, a structured evidence bundle and explicit tool-discipline guidance can reduce unnecessary broad exploration (`grep/search_files/list_directory`) without reducing task correctness.

This is a **presentation/tool-selection** experiment. It must not change retrieval ordering.

## Protocol

1. Use the same public retrieval manifest and budget for v1.1 and v1.2.
2. Assert selected file ordering is identical probe-by-probe.
3. Compare planner token cost.
4. Run synthetic Headless/Bench E2E only to verify the instrumentation can observe different tool-selection paths.
5. Run real-model `v1.1 → v1.2` A/B with identical suite/filter/repeat on Public, Private Holdout and pinned Real Repo before changing the default.

Recommended command:

```bash
freeseek-bench ab-context \
  --baseline-planner v1.1 \
  --candidate-planner v1.2 \
  --base-url <url> \
  --api-key <key> \
  --model <model> \
  --repeat 3
```

## Offline result

At 1500 planner tokens on the built-in 8-probe retrieval suite:

| Variant | Hit@1 | Hit@3 | MRR | Avg estimated planner tokens |
| --- | ---: | ---: | ---: | ---: |
| v1.1 | 100% | 100% | 1.000 | ~579 |
| v1.2 | 100% | 100% | 1.000 | ~564 |

The selected path order is identical for v1.1 and v1.2. v1.2 is slightly smaller because it removes duplicated user-task text and uses a compact evidence contract.

## Synthetic E2E

A fake OpenAI-compatible model is used only as a harness test:

- under v1.1 it deliberately performs one `grep` before the same successful write;
- under v1.2 it deliberately writes directly from the supplied evidence;
- both variants must remain 100% correct;
- Trace/Bench must report the candidate with one fewer exploratory search/tool call.

This proves the measurement path, **not** that a real model will behave this way.

## Decision

Keep `off` as the product default. Keep v1.2 experimental until real-model Public + Private + Real A/B shows:

- correctness non-regression (primary gate);
- fewer or more targeted exploration steps;
- acceptable planner token overhead;
- no increase in unplanned mutations.

If retrieval remains correct but real-model behavior does not improve, investigate prompt placement, evidence granularity and tool descriptions. Do not add Tree-sitter/LSP indexing unless real-repository traces show retrieval/symbol/dependency misses.
