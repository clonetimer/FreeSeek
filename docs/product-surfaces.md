# FreeSeek Product Surfaces

FreeSeek is **one Agent Kernel with multiple hosts**, not a VS Code-only agent and not a collection of separate agents.

## Decision

```text
FreeSeek Kernel
├─ FreeSeek for VS Code        primary interactive client (stable)
├─ FreeSeek CLI / Headless     terminal, CI, benchmark, automation (stable)
├─ FreeSeek Agent Server       ACP/protocol adapter for other IDEs (next)
└─ FreeSeek Web Console        remote tasks/trace/bench/sandbox control plane (later)
```

The package/extension id `freeseek-copilot` stays unchanged for upgrade compatibility. `FreeSeek` is the user-facing product name.

## Why VS Code remains the primary client

The daily coding loop benefits from editor-native state that a generic web chat cannot reproduce cheaply:

- current editor/selection and multi-root workspace context;
- diff review and explicit accept/reject flows;
- diagnostics, LSP symbols and navigation;
- terminal/task integration;
- file permission prompts close to the edited artifact.

The VS Code extension should therefore stay the flagship interactive surface while the Kernel remains host-independent.

## Why CLI / Headless is a first-class stable surface

CLI/Headless is not a fallback UI. It is the stable automation host for:

- CI and scheduled tasks;
- benchmark/eval runs;
- scripts and terminal-first users;
- remote sandbox jobs;
- future PR/issue automation.

It must reuse `runAgent → ToolRegistry → ToolRuntime → EventLog`; it must not grow a second security or agent implementation.

## Why not build a standalone IDE now

A CodeBuddy-style native IDE would require owning editor rendering, extensions, terminal, SCM, settings, updates and platform compatibility. That cost does not improve the FreeSeek Kernel itself. VS Code + a future Agent Server reaches most IDE users without taking on an editor fork.

A standalone shell/desktop app can be reconsidered only if benchmarked workflows require capabilities that editor plugins and Agent Server clients cannot provide.

## Agent Server / ACP direction

The next cross-editor surface should be a protocol adapter, not another bespoke UI. The adapter should expose session lifecycle, streaming messages, approvals, tool presentation and cancellation while keeping policy/tool execution inside FreeSeek Kernel.

The protocol layer must never be allowed to call raw tool bodies or bypass `ToolRuntime`.

## Web Console direction

A future Web Console should be a **control plane**, not the primary code editor. High-value views are:

- active/local/remote sessions;
- background/scheduled jobs;
- trace and EventLog inspection;
- Bench/Eval comparisons;
- remote sandbox/workspace status;
- checkpoint/fork/time-travel controls;
- team policy/provider management.

If code editing is required, the console should link/open the relevant IDE or remote workspace rather than reimplement a full editor first.

## Surface invariants

1. One session/event model across all hosts.
2. One `ToolRegistry` / `ToolRuntime` security boundary.
3. Host capabilities are injected; Kernel code does not import VS Code at module load time.
4. Provider identity is runtime configuration, never part of the core persona.
5. A feature is not complete if it only works in one host without an explicit host-capability reason.
6. Web/Agent Server clients render approvals; policy ownership stays in Runtime.
