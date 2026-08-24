# FreeSeek ACP Agent Server

FreeSeek 0.19.0-alpha.2 introduced the **ACP v1 stdio Host**; it is Stable from FreeSeek 0.19.0 onward. It is a protocol adapter over the same Agent Kernel used by VS Code and CLI, not a second Agent implementation.

## Start

Prefer environment variables for provider credentials so secrets do not appear in process arguments:

```bash
export FREESEEK_BASE_URL=https://api.deepseek.com
export FREESEEK_API_KEY=...
export FREESEEK_MODEL=deepseek-v4-flash

freeseek acp
# equivalent standalone bin
freeseek-acp
```

Local OpenAI-compatible services can disable authentication explicitly:

```bash
freeseek-acp \
  --base-url http://127.0.0.1:1234/v1 \
  --model local-model \
  --auth-type none
```

Useful Host flags:

```text
--session-dir <dir>       durable ACP sessions (default ~/.freesek/acp)
--yes                     auto-approve Runtime permissions
--allow-shell             allow command/code execution through ToolRuntime
--no-network              disable network tools
--skills-dir <dir>        add a Skill root (repeatable)
--enable-multi-agent      explicitly expose spawn_agent/spawn_agents
--context-planner <mode>  off|v1|v1.1|v1.2
--verbose                  diagnostics to stderr
```

**stdout is protocol-only.** ACP NDJSON JSON-RPC is written to stdout; Provider/MCP/Host diagnostics go to stderr.

## ACP v1 methods in alpha.2

Agent-side:

- `initialize` (protocolVersion 1; `loadSession:false`);
- `session/new`;
- `session/prompt`;
- `session/cancel`;
- `session/list`;
- `session/resume`;
- `session/close`.

Client-side callbacks used by FreeSeek:

- `session/update` for assistant/reasoning/tool-call/tool-result presentation;
- `session/request_permission` for ToolRuntime approval.

`session/cancel` aborts the active Provider/tool turn and returns `stopReason=cancelled` when cancellation wins.

## Durable sessions

ACP sessions reuse FreeSeek EventLog rather than creating a separate history model. A small metadata sidecar stores ACP-specific discovery fields such as cwd/title and MCP **server names**.

For MCP-backed sessions, command/args/env/secrets are intentionally not persisted. On `session/resume`, the client must re-supply MCP configuration and the server-name set must match the original session.

## MCP

Alpha.2 accepts ACP stdio MCP entries. The command may be either an absolute executable path or a PATH-resolved executable such as `node`, `npx` or `uvx`. Each active ACP session owns its own `McpManager`; closing/resuming one session does not tear down another session's MCP connections.

External MCP calls still pass through the shared ToolRegistry/ToolRuntime permission boundary. ACP does not invoke MCP or built-in raw tool bodies directly.

## Capability boundary

Alpha.2 intentionally does **not** claim:

- `session/load` (`loadSession:false`);
- generic FreeSeek `ask_user` / ACP elicitation parity;
- non-empty `additionalDirectories` / multi-root authorization;
- image/audio prompt content;
- remote ACP HTTP/WebSocket transport;
- production interoperability certification against independent third-party ACP clients.

Those are later M3/M4 gates. Independent desktop UI is deferred until the protocol-host path is mature.

## Validation

The alpha.2 release gate includes:

- full `npm run check`;
- full `npm test`;
- lifecycle/resume/cancel/MCP/permission protocol tests;
- real child-process tests for both `freeseek-acp` and unified `freeseek acp`;
- stdout-purity assertion (every stdout line must parse as JSON-RPC);
- durable EventLog verification.

See `docs/project/VALIDATION_0_19_ALPHA_2.md` for the exact release record.
