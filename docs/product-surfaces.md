# FreeSeek Product Surfaces

FreeSeek is one Agent Kernel with multiple hosts.

```text
FreeSeek Kernel
├─ FreeSeek for VS Code        stable
├─ FreeSeek CLI / Headless     stable
├─ FreeSeek ACP Agent Server   stable
├─ FreeSeek SDK                0.25 library entry + `freeseek-sdk` CLI
├─ FreeSeek Desktop            0.20 in development
└─ FreeSeek Web Console        0.24 local HTTP/SSE console (0.25 browser approval)
```

## Standalone Desktop (0.20)

The desktop application is a **client of the stable ACP Host**, not a fourth copy of the Agent. Electron owns native window/dialog integration; `freeseek-acp` owns Agent execution, tools, permissions, MCP, Skills, EventLog and durable sessions.

Initial architecture:

```text
Renderer → contextBridge IPC → Electron Main → ACP stdio → FreeSeek Kernel
```

This keeps the desktop shell replaceable and proves the 0.19 cross-host boundary in a first-party product.

## Web Console (0.24)

The Web Console is a **local loopback HTTP/SSE host** that projects the same ACP control plane into a browser, mirroring the Desktop topology:

```text
Browser → HTTP/SSE → WebConsoleServer → ACP client → freeseek-acp sidecar → FreeSeek Kernel
```

Agent execution, tools, permissions, MCP, Skills and durable sessions are still owned by `freeseek-acp`; the console is transport/projection only. Entry: `freeseek web` / `freeseek-web` (default `127.0.0.1:3080`). Security defaults: loopback bind, random access token, same-origin guard, and fail-closed permission requests unless `--yes`. 0.25: permission requests and ask_user forms are pushed over SSE and answered via `POST /api/session/respond`; `--yes` still bypasses.

## SDK (0.25)

`require("freeseek")` and the `freeseek-sdk` CLI share one export surface: `runAgent` / `sandboxes` / `policy` / `sync`. It is a **library projection** of the headless host — same Kernel, same EventLog, same security defaults; `run` passes `--mode coder|plan|ask`, `--tui`, `--exec-policy`, and `--sandbox remote:*` through to the headless runner. See `docs/sdk.md`.

## CLI 0.25 additions

- `--tui`: interactive incremental terminal UI (streaming render + keyboard approval / ask_user forms); auto-degrades to plain streaming on non-TTY.
- `--exec-policy <policy.json>`: declarative ExecPolicy DSL overrides `run_command` default approval; behavior identical to 0.24 when absent.
- `--sandbox remote:docker|ssh|e2b@<target>`: executes `run_command` on a remote transport (three-state transport, see `docs/remote-sandbox.md`).
- `--mode coder|plan|ask`: aligned with the SDK CLI.

## Surface invariants

1. One session/event model across hosts.
2. One ToolRegistry/ToolRuntime security boundary.
3. Host capabilities are explicit and fail closed.
4. Desktop renderer has no Node/tool/filesystem privilege.
5. Desktop does not import Agent/ToolRuntime/Tools directly.
6. Web Console is loopback-only, token-gated, and same-origin guarded.
7. General HMR remains after Desktop Stable.
8. SDK is a library projection of the headless host, not a duplicate Kernel.
