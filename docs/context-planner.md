# Context Planner

Context Planner is an experimental pre-model retrieval/presentation layer for FreeSeek. It does **not** replace normal tools. It gives the first model request a bounded candidate map so the agent can start closer to relevant code, then the model can still use `grep`, `search_files`, `read_file`, LSP and subagents when evidence is insufficient.

## Pipeline

```text
user task
   ↓
repository scan (bounded, symlink-safe)
   ↓
Repo Map + lightweight symbol extraction
   ↓
lexical/path/symbol ranking
   ↓
relative import + importer expansion
   ↓
context budget trimming
   ↓
Context Presentation
   ↓
normal Agent / ToolRegistry / ToolRuntime loop
```

## Modes

- `off` — legacy behavior. No precomputed context is injected; the model explores with normal tools.
- `v1` — initial Repo Map + Symbol + Dependency ranking with the legacy presentation.
- `v1.1` — same lightweight index, with negative-intent and production-path ranking corrections.
- `v1.2` — **same retrieval ordering as v1.1**, but a structured evidence presentation with explicit tool discipline and user exclusion boundaries.

`off` remains the default until real-model Public + Private + Real benchmark A/B shows a correctness-safe benefit.

VS Code settings:

- `freesek.contextPlanner = off|v1|v1.1|v1.2`
- `freesek.contextPlannerBudget = 3500` by default

Headless / Eval / Bench:

```bash
freeseek --context-planner v1.2 --context-plan-budget 3500 ...
freeseek-eval --context-planner v1.2 --context-plan-budget 3500 ...
freeseek-bench run --context-planner v1.2 --context-plan-budget 3500 ...
```

## Retrieval-only experiment

Before paying for model-level A/B, use the deterministic probe suite:

```bash
freeseek-bench context-retrieval \
  --context-plan-budget 1500 \
  --out ~/.freesek/bench/context-retrieval
```

It compares v1/v1.1/v1.2 on Hit@1 / Hit@3 / Hit@5 / MRR and planner token cost. Failures are classified as:

- `ranking_miss` — target exists but is ordered behind distracting candidates;
- `dependency_miss` — target is directly related by the lightweight import graph but expansion did not surface it;
- `budget_overflow` — target appears with a large context budget but was trimmed under the configured budget;
- `retrieval_miss` — target is absent from the bounded repo map;
- `hit` — target is ranked first.

This experiment decides **what mechanism to improve**, not whether a planner should become the default.

The v1.1 experiment is recorded in `experiments/context-planner-v1.1.md`. It showed the bottleneck was ranking, not repository coverage. The v1.2 experiment is recorded in `experiments/context-presentation-v1.2.md`; it intentionally keeps the v1.1 ranking fixed so presentation/tool-selection effects can be isolated.

## v1.2 structured evidence

v1.2 removes duplicated task text from the injected fragment and presents candidates as ranked evidence:

- `PRIMARY`, `CANDIDATE`, and dependency/importer `RELATED` labels;
- explicit `READ-ONLY BOUNDARY` labels for paths the user said not to modify;
- symbol and excerpt evidence;
- a short tool-discipline contract:
  - start from prefetched evidence;
  - avoid repeating broad `list_directory/search_files/grep` when the evidence already identifies the implementation;
  - use the excerpt directly when it contains the exact edit span;
  - otherwise `read_file` the specific candidate before editing;
  - escalate to targeted grep/LSP only when evidence is insufficient;
  - never edit a file merely because Planner listed it.

The guidance is advisory. ToolRuntime does **not** block search/read calls based on Planner heuristics, so an incorrect plan cannot trap the agent.

## Model-level A/B

Use identical suite/filter/repeat on both sides:

```bash
freeseek-bench ab-context \
  --baseline-planner v1.1 \
  --candidate-planner v1.2 \
  --base-url <url> \
  --api-key <key> \
  --model <model> \
  --repeat 3
```

Correctness remains primary. Efficiency and context-use metrics are separate deltas.

In addition to token/steps/tool-call/duration metrics, Trace/Bench now report post-plan behavior:

- `contextExploratorySearchCalls` — `grep/search_files/list_directory` calls after a plan;
- `contextPlannedReadCalls` / `contextUnplannedReadCalls`;
- `contextPlannedMutationCalls` / `contextUnplannedMutationCalls`;
- `contextTopCandidateTouches`.

These metrics are diagnostics, not an optimization target by themselves. A useful search is better than a wrong direct edit.

## v1.1 ranking rules

v1.1 (and therefore v1.2 retrieval) preserves the deterministic dependency-free implementation, then adds query-intent ranking:

- terms near negative cues such as `不要`, `do not`, `avoid`, or `must not` are not treated as positive path evidence;
- explicitly excluded `tests`, `legacy`, `build`, `dist`, `generated`, `example`, `sample`, and `fixtures` paths receive strong penalties;
- test files, docs, and examples are conservatively down-ranked unless the task asks to modify them;
- a small `src/lib/app/server/packages/runtime` bias is applied only when the query itself expresses production/runtime intent.

## Durable observability

Each planning attempt writes `context/plan` to the Session EventLog, including:

- planner variant and presentation style;
- ranked selected files;
- excerpt line counts;
- estimated planner tokens;
- planning duration and repo truncation.

The model-visible fragment is also recorded as canonical `system/message`, so replay can explain exactly what context the model received.

## Promotion rule

Retrieval Hit@K is **not** evidence that a real model solves more tasks. Promotion from experimental to default requires model-backed A/B on:

1. Public regression suite;
2. private holdout;
3. pinned real-repository suite.

For v1.2, the hypothesis is specifically: **same retrieval correctness, fewer unnecessary exploratory tool calls, no correctness regression**. If real-model results do not improve despite correct retrieval, inspect Context Presentation / Tool Selection traces before investing in Tree-sitter/LSP indexing. A heavier symbol/index layer is justified only when real-repository traces show actual `retrieval_miss` or symbol/dependency precision failures.
