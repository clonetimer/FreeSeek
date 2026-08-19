# FreeSeek 0.18.0 Stable Integration Notes

## Release intent

0.18.0 treats FreeSeek as one host-independent Agent Kernel with two stable user-facing hosts: VS Code and CLI/Headless. The extension id/package name remains `freeseek-copilot` for upgrade compatibility; the new CLI is additive and reuses the same policy/runtime/event model.

## What was merged from the ergonomics/hotfix development line

### Runtime and safety

- `ToolRegistry` + `ToolRuntime` as the single model-tool execution boundary.
- Host-only runtime spec for effects, approvals, concurrency, shell/network capability and timeouts.
- Path/symlink escape hardening and FreeSeek-owned shadow Git checkpoints.
- AbortSignal propagation through Agent, subprocess, MCP and background jobs.
- MCP timeouts/cleanup and connector network/approval policy.
- Provider secret indirection / SecretStorage migration on the VS Code host.
- Atomic/serialized session index writes.
- Remote Sandbox `CommandRunner` seam with explicit workspace mapping.

### Durable state and observability

- Content-addressed attachment/image store.
- Canonical durable EventLog messages/snapshots with complete-recovery semantics.
- Turn/step/model/tool/approval lifecycle events.
- Byte-offset event index that can rebuild from authoritative JSONL.
- Workspace timeline, checkpoint anchors, historical materialization and true session fork.
- Trace projection and Eval Harness.

### Evaluation and context engineering

- FreeSeek Bench v1 public regression suite.
- Bench v2 private holdout + immutable Git source model + pinned real-repo tasks.
- Context Planner v1/v1.1/v1.2 plus retrieval/presentation A/B instrumentation.
- DeepSeek V4 runner and secure environment-variable benchmark entrypoint.

### Product surface

- Headless Kernel no longer needs VS Code runtime at module startup.
- 0.18 adds unified `freeseek run/eval/bench/doctor/sessions/replay` routing.
- `freeseek --prompt ...`, `freeseek-eval` and `freeseek-bench` remain compatible.
- Headless provider selection now exposes `openai|claude|gemini`, `native|react`, and auth-header modes; unauthenticated local OpenAI-compatible endpoints use explicit `authType=none` and may omit an API key.
- `--prompt -` accepts the task from stdin for CI and long prompts.

## Context Planner promotion decision

The supplied real DeepSeek v1.1→v1.2 A/B log covered 4 context cases × 3 repeats (12 attempts per side). Both sides achieved weighted score 100 and strict pass rate 1.0. v1.2 reduced total tokens, tool calls, steps, exploratory searches and unplanned reads, while total duration increased. This is positive evidence for v1.2 availability, but it does not by itself prove the full Public + Private Holdout + pinned Real Repo promotion gate. Therefore 0.18.0 ships v1.2 but keeps the product default at `off`.

## Compatibility

- VS Code extension package id/name remains `freeseek-copilot`.
- Existing extension settings and the 0.17.x command surface are retained.
- Existing direct Headless flags remain accepted through the unified CLI.
- Event JSONL remains authoritative; the new secondary index is rebuildable.
- Historical forks fail closed if no checkpoint anchor exists rather than mixing old conversation state with current code.

## Validation in the integration workspace

- `npm run check`: source typecheck, test typecheck, max-lines hygiene, Runtime boundary and benchmark boundary all passed. Existing exported-JSDoc findings remain warnings only.
- `npm test`: 322 tests passed, 0 failed (297 top-level tests, 4 suites).
- The uploaded dependency tree carries a Windows esbuild native binary, so this Linux integration environment cannot truthfully regenerate the production VS Code bundle with that binary. A platform-matching dependency install is still required for final VSIX generation.
