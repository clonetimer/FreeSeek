# FreeSeek Tool Runtime Consolidation Notes

This continuation patch consolidates FreeSeek's model-facing tool execution into a single host-side runtime boundary.

## What changed

- Added `src/tool-runtime.ts` as the only model-tool execution pipeline.
- Added `src/tool-runtime-spec.ts` as the host-only source of truth for effect, concurrency, read-only eligibility, approval policy, shell/network capability requirements, MCP approval, and tool-level timeout.
- Routed built-in tools, dynamic MCP tools, connectors, and Agent-native `spawn_agent` / `spawn_agents` / `send_message` through the same runtime.
- Removed the duplicated permission/hook/timeout/MCP dispatch tree from `agent.ts`.
- Moved generic approval policy out of `extension.ts`; the Extension now only renders approval UI when the Runtime asks.
- Made approval-required tools fail closed when no approval handler exists.
- Kept MCP as an independent approval boundary; a normal allow rule does not silently cancel MCP approval.
- Classified connectors as networked external capabilities, so `allowNetwork=false` blocks them before execution and enabled connectors require user approval.
- Applied dangerous shell-text checks to `run_code` bash/sh/shell in addition to `run_command`.
- Moved host-only timeout metadata out of model `ToolDefinition`, preventing provider schema leakage.
- Derived concurrency scheduling from the same Runtime spec instead of a second hard-coded safe-tool set.
- Wrapped Agent-native body execution with the same cancellation/error-normalization path as normal tools.
- Added a hard engineering gate: `executeToolBody` may only be invoked by `ToolRuntime`.
- Added `docs/tool-runtime.md` and repository rules explaining how future tools must be registered.

## Runtime order

`admission/mode -> permission rules -> generic approval -> MCP approval -> pre hooks -> cancel/timeout -> body -> post hooks -> offload/truncate`

## Validation

- `npm run typecheck` — passed.
- `npm run check` — passed, including the new Runtime boundary gate.
- Full temporary TypeScript emit + Node `node:test` run: **254 tests passed, 0 failed** across all 32 test files.

The repository's normal `npm test` / production esbuild pipeline is still not directly runnable in this Linux audit environment because the uploaded `node_modules` contains the Windows esbuild native package. Source-level and full Node-test validation above therefore remains the trustworthy validation method here unless a platform-matching dependency install is performed.
