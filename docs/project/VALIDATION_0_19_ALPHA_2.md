# FreeSeek 0.19.0-alpha.2 Validation Record

Date: 2026-08-19
Branch under test: `feat/m2-acp-stdio`
Integration branch: `dev/0.19`
Baseline tag: `v0.19.0-alpha.1`
Target tag: `v0.19.0-alpha.2`

## Scope

M2 introduces ACP v1 stdio as FreeSeek's third first-class Host without bypassing the existing Kernel, ToolRegistry/ToolRuntime or durable EventLog.

## Source / architecture evidence

- ACP transport: `src/hosts/acp/protocol.ts`.
- ACP lifecycle host: `src/hosts/acp/server.ts`.
- Durable ACP metadata: `src/hosts/acp/session-store.ts`.
- Standalone entry: `src/acp-server.ts`; unified route: `freeseek acp`.
- Per-session MCP runtime is injected through `ToolContext`; the process-global manager remains only as a compatibility fallback.
- ACP Host capability profile explicitly does not advertise interactive elicitation/LSP/image input.

## Protocol/runtime evidence

Implemented and tested:

- `initialize` (protocol v1, `loadSession:false`);
- `session/new`;
- `session/prompt` + `session/update` streaming;
- `session/cancel` → `stopReason=cancelled`;
- `session/list` with validated cursor;
- `session/resume`;
- `session/close`;
- reverse `session/request_permission` with ToolCallId correlation;
- per-session stdio MCP, including PATH-resolved commands;
- EventLog-backed conversation restoration.

Security/persistence invariants:

- ACP MCP metadata persists server names only.
- MCP command, args, env and secrets are not written to ACP metadata.
- Resume of an MCP-backed session requires the client to re-supply matching server names/configuration.
- Tool execution remains `ToolRegistry → ToolRuntime`; ACP never invokes raw tool bodies directly.
- Unsupported non-empty `additionalDirectories` fails closed.

## Automated gates

- `npm run check`: **8/8 PASS**; export JSDoc is advisory only.
- `npm test`: **336/336 PASS, 0 FAIL**.
- Source TypeScript typecheck: PASS.
- Test TypeScript typecheck: PASS.
- Runtime boundary: PASS.
- Benchmark/private-holdout boundary: PASS.
- Kernel/Host boundary: PASS.
- package/lock/project-state version coherence: PASS after alpha.2 version update.

## Process-boundary evidence

Two real child-process tests execute the transpiled entrypoints:

1. standalone `freeseek-acp` equivalent (`runAcpCli`);
2. unified `freeseek acp` route (`runFreeSeekCli(["acp", ...])`).

Both perform `initialize → session/new → session/prompt → session/close`, call a real local mock OpenAI-compatible SSE Provider, write durable EventLog files, exit 0, and keep stdout parseable as NDJSON JSON-RPC only.

## Explicitly deferred

- ACP `session/load` (`loadSession:false` is advertised);
- ACP user elicitation / FreeSeek `ask_user` parity;
- non-empty `additionalDirectories` / multi-root authorization;
- remote HTTP/WebSocket ACP transport;
- formal interoperability against two independent third-party ACP clients (M4 gate);
- independent desktop UI.

## Promotion decision

**TAGGABLE as `v0.19.0-alpha.2`** only after the version-updated tree re-runs `npm run check` and `npm test` with the same passing result and the M2 commit is on `dev/0.19`.
