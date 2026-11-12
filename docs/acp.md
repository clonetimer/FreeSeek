# FreeSeek ACP Agent Server

FreeSeek exposes its shared Agent Kernel through the stable Agent Client Protocol (ACP) v1 stdio host. ACP is a host adapter: it does not create a second Agent implementation.

## Start

Provider credentials should be supplied through environment variables so secrets do not appear in process arguments:

```bash
export FREESEEK_BASE_URL=https://api.deepseek.com
export FREESEEK_API_KEY=...
export FREESEEK_MODEL=deepseek-v4-flash

freeseek acp
# or the standalone executable
freeseek-acp
```

Useful host flags:

```text
--session-dir <dir>       durable ACP sessions (default ~/.freesek/acp)
--yes                     auto-approve Runtime permissions
--allow-shell             allow command/code execution through ToolRuntime
--no-network              disable network tools
--skills-dir <dir>        add a Skill root (repeatable)
--enable-multi-agent      explicitly expose spawn_agent/spawn_agents
--context-planner <mode>  off|v1|v1.1|v1.2
--verbose                 diagnostics to stderr
```

**stdout is protocol-only.** ACP NDJSON JSON-RPC is written to stdout; Provider, MCP and host diagnostics are written to stderr.

## Stable ACP v1 capability profile

Initialization negotiates protocol version 1. The host advertises:

- `loadSession: true`.
- Session capabilities: `list`, `resume`, `close` and `additionalDirectories`.
- Prompt capabilities: image, audio and embedded context are not advertised.
- ACP MCP capabilities: HTTP and SSE are not advertised; the host accepts per-session MCP stdio servers only.
- Session modes: `coder`, `craft`, `plan` and `ask`.

Tool permission requests use `session/request_permission`. When the connected client advertises `elicitation.form`, structured user input can use `elicitation/create`.

## Session lifecycle

| Method | Behavior |
| --- | --- |
| `session/new` | Creates a durable session and initializes the shared Agent Kernel |
| `session/prompt` | Runs a prompt and streams session updates |
| `session/cancel` | Cancels the active turn without destroying the session |
| `session/list` | Lists sessions for the requested working directory |
| `session/resume` | Reopens a closed session with the original authorized roots |
| `session/load` | Loads a session and replays prior history through session updates |
| `session/close` | Closes the active session while preserving durable history |
| `session/set_mode` | Changes the session mode and emits a current-mode update |

ACP sessions reuse FreeSeek EventLog rather than creating a separate history model. ACP metadata stores session discovery information, including the canonical working directory, additional roots and MCP server names.

## Workspace authorization

`cwd` must be an existing absolute directory. `additionalDirectories` accepts up to 32 existing absolute directories. FreeSeek resolves real paths, removes duplicates and the primary workspace, and treats the resulting set as the session's authorized workspace roots.

For `session/resume` and `session/load`, clients must re-supply the same additional roots that were authorized when the session was created. A different root set is rejected; roots are not silently widened or reduced.

## MCP integration

ACP session configuration currently accepts MCP stdio servers only. Each entry supplies a server name, command, optional arguments and environment entries. HTTP and legacy SSE MCP entries are rejected by the ACP host. Each active ACP session owns its own `McpManager`; closing or resuming one session does not tear down another session's MCP connections.

External MCP calls still pass through the shared ToolRegistry and ToolRuntime permission boundary. ACP does not invoke MCP or built-in raw tool bodies directly.

For MCP-backed sessions, command, arguments, environment values and secrets are intentionally not persisted in session metadata. On `session/resume` or `session/load`, the client must re-supply the MCP configuration and the server-name set must match the original session.

## Interoperability and validation

The production host remains stable ACP v1. The official `@agentclientprotocol/sdk` is used as an independent client in the test suite; its experimental v2 entrypoint is not enabled in the production host.

The P2 interoperability test starts the compiled FreeSeek stdio host and connects the official SDK client. It verifies initialization and capabilities, session creation, prompt streaming, listing, close, resume, load/history replay and additional-directory authorization.

Run the relevant checks:

```bash
npm run check
npm test
```

ACP v2 remains experimental and isolated until the protocol is stable and independently validated.
