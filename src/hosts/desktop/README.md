# FreeSeek Desktop Host

The Desktop Host is a **client of the stable FreeSeek ACP boundary**. It does not import
`runAgent`, `ToolRegistry`, `ToolRuntime`, or raw tool bodies.

0.20 invariants:

1. Electron owns windows/native dialogs only.
2. Agent execution remains in the `freeseek-acp` child process.
3. Renderer code has no Node integration; privileged operations cross preload IPC.
4. Provider secrets are process-local in dev.1 and must move to OS-protected storage before beta.
5. ACP session/update, permission and elicitation are the only Agent/UI bridge.
