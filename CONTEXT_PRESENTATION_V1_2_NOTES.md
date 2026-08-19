# FreeSeek Context Presentation v1.2 Notes

## Scope

This increment starts from **Context Planner v1.1** and deliberately freezes retrieval ordering. v1.2 changes only how selected evidence is presented to the model and how subsequent tool usage is measured.

## Why this change

The v1.1 retrieval experiment already reached 100% Hit@1 / Hit@3 and MRR=1.000 on the built-in 8 probes. That removes retrieval coverage/ranking as the immediate bottleneck for those cases. The next falsifiable hypothesis is whether models use already-correct candidates efficiently.

## v1.2 behavior

- same file scoring/order/dependency expansion as v1.1;
- removes duplicated task text from planner injection;
- structured `PRIMARY / CANDIDATE / RELATED` evidence;
- explicit `READ-ONLY BOUNDARY` label for user-excluded paths;
- advisory tool discipline: prefer prefetched evidence, avoid repeated broad search when unnecessary, use exact `read_file` only when the excerpt is insufficient;
- no Runtime tool blocking based on Planner heuristics.

## New trace metrics

After a successful `context/plan`, Trace/Bench project:

- `contextExploratorySearchCalls`;
- `contextPlannedReadCalls`;
- `contextUnplannedReadCalls`;
- `contextPlannedMutationCalls`;
- `contextUnplannedMutationCalls`;
- `contextTopCandidateTouches`.

These are diagnostic metrics. Correctness remains the promotion gate.

## Evidence available in this environment

Offline deterministic retrieval/presentation experiment at a 1500-token planner budget:

- v1.1: Hit@1 100%, Hit@3 100%, MRR 1.000, ~579 estimated planner tokens;
- v1.2: Hit@1 100%, Hit@3 100%, MRR 1.000, ~564 estimated planner tokens;
- selected file ordering is identical.

A fake-model E2E verifies that the A/B harness can observe one fewer exploratory search while both variants remain correct. This is instrumentation validation, **not real-model evidence**.

## Promotion gate

Keep product default `off`. Run real-model A/B:

```bash
freeseek-bench ab-context \
  --baseline-planner v1.1 \
  --candidate-planner v1.2 \
  --base-url <url> \
  --api-key <key> \
  --model <model> \
  --repeat 3
```

Run it on Public regression, Private Holdout and pinned Real Repo. Promote only if correctness does not regress and context-use/efficiency metrics improve materially.
