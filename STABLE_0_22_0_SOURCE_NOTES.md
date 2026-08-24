# FreeSeek 0.22.0 Stable Source Notes

**Status:** Local/Internal Source Stable; public/native artifact certification pending  
**Date:** 2026-08-22  
**Direct source RC:** 0.22.0-rc.1 @ b7997b76d01944cabec07ddf76c6a5c70d7724d2

## Scope

FreeSeek 0.22.0 freezes the completed Desktop UI Experience Convergence U0-U5 together with General HMR H0-H4 on one shared Agent/Kernel. CLI/Headless, ACP, VS Code and Desktop remain hosts of the same kernel/runtime; HMR is a platform capability, not a second Agent implementation.

## Stable source surfaces

- FreeSeek shared Agent/Kernel and ToolRuntime/EventLog.
- CLI / Headless host.
- ACP v1 stdio Agent Server plus FreeSeek-namespaced HMR management RPC.
- VS Code host.
- Standalone Desktop host using Electron -> ACP -> shared Kernel.
- General HMR Extension Runtime: generation leases, trusted package HMR, Skill/Policy/Hook/MCP contributions, durable management/audit, and Linux-only untrusted Tool sandbox.

## Release boundary

This source baseline is frozen for local/internal source deployment and downstream packaging. The current environment cannot restore the project-pinned dependency tree, so full pinned typecheck/test/build, VSIX/npm packaging and native Desktop installer evidence have not been regenerated on the source-stable metadata commit. Therefore this repository does **not** create the immutable public `v0.22.0` tag. The tag must be created only after the existing release contract is satisfied on the exact candidate.

H4 untrusted Tool execution is Linux-only and fail-closed elsewhere; shell/process spawn and untrusted Connector/Skill/Hook/MCP/UI contributions remain unsupported.
