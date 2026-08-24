# FreeSeek Desktop Architecture Decision

Status: **Accepted for 0.20**  
Date: 2026-08-20

## Decision

Use **Electron as the first desktop shell** and use the existing ACP v1 stdio Agent Server as the only Agent boundary.

Electron was selected for the first implementation because FreeSeek is already a Node/TypeScript system and the desktop main process can spawn the existing `freeseek-acp` artifact without adding a Rust/native bridge to the Kernel. The shell is replaceable later because the Agent boundary is ACP rather than Electron APIs.

## Security boundary

- Renderer: `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`.
- Preload: narrow `contextBridge` API only.
- Main process: workspace dialog, ACP lifecycle and host interaction routing.
- ACP child: Provider, Agent, ToolRegistry, ToolRuntime, EventLog, MCP, Skills.
- No Desktop source may import `runAgent`, `ToolRuntime`, `ToolRegistry` or raw tools.

## dev.1 scope

Implemented:

- standalone Electron application skeleton;
- provider/workspace bootstrap;
- ACP initialize/session/new/session/prompt/session/update;
- mode switch, cancel and durable session listing primitives;
- permission and elicitation bridge;
- explicit Desktop Host capability profile.

Deliberately temporary in dev.1:

- API key is memory-only, never persisted;
- permission uses `window.confirm`, elicitation uses `window.prompt`;
- ACP process requires an available `node` executable and built `dist/freeseek-acp.js`;
- no desktop installer/updater yet;
- no LSP/diff/image capability claims yet.

## Invariants

1. The Desktop shell can be deleted without losing sessions or Agent semantics.
2. ACP remains independently usable by third-party clients.
3. Any Desktop-only capability must be represented as a HostCapability, not a Kernel branch on Electron.
4. Provider secrets must move to OS-protected storage before beta.
5. General HMR remains outside 0.20 until Desktop Stable is complete.

## D1 runtime split

`DesktopRuntimeController` is Electron-independent and owns ACP child/session lifecycle. Electron `main.ts` is only an adapter for BrowserWindow, dialogs and IPC. This gives D1 two separate proof layers:

1. real DesktopRuntime → ACP child → Agent turn E2E (dev.2, passed);
2. real BrowserWindow → preload/contextBridge → IPC → DesktopRuntime → ACP child E2E (`npm run desktop:smoke`, alpha.1 gate).

Compiled path discovery must walk to the root package identity (`freeseek-copilot`) instead of assuming a fixed `__dirname` depth.
