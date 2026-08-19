# Context Planner v1 — implementation notes

This stage introduces a benchmark-gated Context Planner and clarifies FreeSeek's product surfaces.

## Code

- Added `src/context-planner.ts`: bounded Repo Map, symbol retrieval, local dependency/importer expansion and budgeted rendering.
- Added `src/agent-context-planner.ts`: fail-open Agent integration plus durable `context/plan` / `system/message` events.
- Added `off|v1` and token budget configuration to VS Code, Headless, Eval and Bench.
- Added planner metrics to Trace/Eval/Bench reports.
- Added `freeseek-bench ab-context` for paired legacy-vs-v1 experiments.
- Changed core persona from “VS Code + DeepSeek” to host/provider-neutral FreeSeek identity.
- Kept extension/package id unchanged for compatibility; changed user-facing branding to `FreeSeek`.

## Validation

- Deterministic Public Bench context retrieval: expected production file Top-3 in 4/4 cases.
- Headless E2E verifies the planner fragment reaches the first model request and durable EventLog.
- Planner failure falls back to legacy tool exploration rather than aborting the Agent.
- `off` remains the default until real-model benchmark results justify promotion.

## Product surface decision

Current priority:

1. VS Code Extension — flagship interactive client.
2. CLI/Headless — first-class automation host.
3. Agent Server / ACP — next cross-editor protocol surface.
4. Web Console — later remote/control-plane UI, not a replacement editor.

Do not build a standalone IDE fork before benchmarked workflows demonstrate a capability gap that these surfaces cannot cover.
