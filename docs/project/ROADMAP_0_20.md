# FreeSeek 0.20 Roadmap — Standalone Desktop UI

## Goal

Ship a standalone desktop application **without creating a second Agent implementation**.
The desktop product is a native shell and ACP client over the stable 0.19 Kernel:

```text
Electron Renderer
      │ contextBridge IPC
Electron Main / Desktop Host
      │ ACP v1 NDJSON stdio
freeseek-acp child process
      │
FreeSeek Kernel → ToolRegistry → ToolRuntime → EventLog
```

## Milestones

1. **D0 — Governance / architecture (`0.20.0-dev.1`)**
   - branch `dev/0.20`, version ledger and desktop architecture decision;
   - `desktop` HostCapability kind;
   - hard boundary: Desktop code may not import Agent/ToolRuntime/Tools directly.
2. **D1 — Electron shell + ACP bridge (`0.20.0-alpha.1`)**
   - D1-A (`0.20.0-dev.2`): real DesktopRuntime → ACP child Agent-turn E2E;
   - D1-B (`alpha.1` gate): real Electron BrowserWindow/preload/renderer execution;
   - secure BrowserWindow/preload boundary;
   - workspace/provider bootstrap;
   - new session, prompt streaming, mode switch, cancel;
   - permission and form elicitation mapped to desktop UI.
3. **D2 — Session UX (`0.20.0-alpha.2`)**
   - dev.3 foundation: workspace-scoped list/resume + first-class permission/elicitation dialogs;
   - durable history/list/resume/close/fork UX;
   - structured tool cards, reasoning, task state and approvals;
   - replace dev.1 `confirm/prompt` surfaces with first-class dialogs.
4. **D3 — Feature parity (`0.20.0-beta.1`)**
   - provider/settings management, MCP, Skills, optional Multi-Agent;
   - artifact/file views and diff review strategy;
   - reuse shared Webview presentation components where practical.
5. **D4 — Packaging/security (`0.20.0-rc.1`)**
   - OS-protected provider secrets;
   - bundled/managed ACP sidecar; signed Windows/macOS/Linux artifacts;
   - provenance-bound signed updater metadata, guarded install/rollback journal, crash recovery, CSP and desktop threat-model audit;
   - candidate-bound RC aggregate evidence: exact Electron, packaged launch, secureStorage, signing/notarization, installer rollback and two independent ACP clients;
   - execution order and promotion rules: `DEVELOPMENT_PLAN_0_20_D4_TO_STABLE.md`.
6. **D5 — Stable (`0.20.0`)**
   - cross-platform install/uninstall and upgrade tests;
   - no runtime divergence from stable Kernel contracts.

## Explicitly deferred

- General HMR/plugin runtime remains **after Desktop Stable**.
- DeepSeek-Harness-inspired Desktop UI experience convergence is recorded in `UI_REFERENCE_DEEPSEEK_HARNESS.md` and also remains **post-0.20**; D4 does not absorb its UI/runtime architecture.
- No editor fork/IDE implementation in 0.20.
- Desktop renderer never receives raw filesystem/process privileges.

## Post-0.20 product order

1. Desktop UI Experience Convergence: typed output presentation, trajectory inspection, tool/file-change visibility and long-session UX, while keeping ACP as the only Agent boundary.
2. General HMR Extension Runtime: start only after the Desktop Stable boundary and keep it architecturally independent from the UI presentation layer.
