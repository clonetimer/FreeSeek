# FreeSeek Plugin Runtime Gap Analysis

Date: 2026-08-19
Basis: FreeSeek `dev/0.19` plus user-provided `deepseek-harness(3).zip` source audit.

> **Implementation update — 2026-08-22:** the deferred line is active on `dev/0.22-hmr`. H0/H1 implement generation leases, reversible effects, dependency/PENDING, last-known-good rollback, trusted Tool/Connector contributions and filesystem package HMR. H2 (`0.22.0-dev.2`) adds generation-snapshotted Skill assets, monotonic ToolRuntime Policy/Hook contributions, and generation-owned MCP tool adapters. H3 (`0.22.0-dev.3`) adds durable operator intent/audit plus ACP, Headless, Desktop and VS Code management projection without widening roots or mutating live Agent registries. H4 (`0.22.0-dev.4`) adds Linux-only out-of-process execution for untrusted Tool contributions with namespaces/chroot/Node Permission Model, startup-only filesystem/network grants, bounded IPC and worker failure containment. See `HMR_RUNTIME_0_22.md`. The historical gap analysis below remains the design rationale.

## 1. Conclusion

FreeSeek 0.19 currently has **dynamic extension primitives**, but it does **not** yet provide a general-purpose DeepSeek-Harness/Cordis-style runtime plugin HMR system.

The distinction is deliberate:

- FreeSeek freezes a `ToolRegistry` snapshot per Agent run so provider tool schema and executable capability cannot silently drift mid-run.
- DeepSeek-Harness/Cordis models plugin registrations as reversible effects owned by a plugin/fiber lifecycle, so an old plugin can be disposed and a new version mounted at runtime.

FreeSeek should keep its immutable per-run registry invariant and implement hot swap at the **turn/run boundary**, not mutate a live provider schema in place.

## 2. Current FreeSeek extension surfaces

| Surface | Dynamic today | Runtime hot reload today | Notes |
| --- | --- | --- | --- |
| MCP | Yes | Partial | `McpManager.reconnect()` disposes all server connections and reconnects; new tool definitions enter a later Agent run snapshot. |
| Connector | Yes | Partial | `registerConnector()` / `unregisterConnector()` change the process registry, but a current Agent run keeps an immutable tool schema snapshot. No version/generation/refcount lifecycle. |
| Skills | Partial | No | `SkillManager` scans configured directories at construction and is cached by the VS Code host. Existing skill status/delete can mutate the manager, but newly added external skills are not watched/discovered automatically. |
| Expert Kit | Install/uninstall | No | A kit copies `skills/commands/agents` into project locations and records reversible file installation; it does not load executable plugin modules or own a live lifecycle. |
| Hookify | File/config driven | No generic module HMR | Rules participate in runtime policy, but they are not a general versioned plugin module system. |
| Generic executable plugin | No | No | No standard manifest + module loader + dependency graph + effect ownership + atomic reload/rollback exists. |

## 3. DeepSeek-Harness/Cordis capabilities observed in the uploaded source

The uploaded DeepSeek-Harness source provides two related extension layers:

1. **Profile package/plugin management** (`apps/cli/src/plugin.ts`): `dsh plugin --profile ...` forwards package operations, then reconciles installed dependencies that declare a `dsh.bundle` into the profile layer stack.
2. **Cordis runtime composition/HMR**:
   - config entries have stable `id` and can be disabled/re-enabled without deleting identity;
   - plugin unload releases its registered effects;
   - reload follows service dependencies;
   - missing injected services leave a plugin in `PENDING`, and it can become active when providers appear;
   - `@deepseek-ai/cordis-plugin-hmr` watches files and performs unload -> reload on save;
   - dynamic Cordis plugins have explicit plugin/package/run identities and retract/undefine lifecycle;
   - host/client halves can be separately governed and sandbox/approval boundaries exist.

This is materially stronger than FreeSeek's current install/reconnect/registry primitives.

## 4. FreeSeek Extension Runtime target semantics

The future runtime should add the Cordis lessons **without replacing FreeSeek's existing safety architecture**.

Required lifecycle:

`discover -> validate -> stage -> activate generation -> lease snapshot -> retire -> dispose`

### Hard invariants

1. **No mid-run schema mutation**: a running Agent keeps its immutable `ToolRegistry` snapshot.
2. **Turn-boundary atomic switch**: a newly validated plugin generation becomes visible only to a subsequent run/turn.
3. **Generation leases**: old plugin instances remain alive while active runs still reference them; dispose only after the final lease is released.
4. **Reversible effects**: every plugin contribution must return/own a disposer; unload is complete, ordered and idempotent.
5. **Last-known-good rollback**: failed stage/activation never destroys the currently active generation.
6. **Capability declaration**: manifests declare tool/network/filesystem/process/persistence/UI requirements before activation.
7. **Trust tiers**: trusted installed plugins may use a constrained in-process API; untrusted/model-generated code must run out-of-process or in an OS/runtime sandbox.
8. **Dependency/PENDING state**: missing required services/plugins produce an observable pending state rather than silent partial activation.
9. **Audit events**: discovery, approval, activation, reload, rollback, retire and dispose are written to EventLog/trace.
10. **Host neutrality**: plugin lifecycle belongs below VS Code/CLI/ACP UI; hosts only expose management UX.

## 5. First implementation scope

When the HMR line is eventually started **after the standalone Desktop UI line**, implement Extension Runtime v1 contributions in this order:

1. Tool / Connector contributions;
2. Skill roots/assets;
3. Hook/policy contributions;
4. MCP server contribution adapters;
5. only later: host-specific UI contributions.

Do not attempt browser/desktop UI plugin APIs in the first runtime version.

## 6. Version placement

Do not add this feature to the 0.19 RC stabilization diff. 0.19 should finish ACP client interoperability and become the cross-host stable baseline first.

Priority is now explicitly: **0.19 Cross-host Stable → standalone Desktop UI → General HMR Extension Runtime**. This document remains the deferred HMR design baseline, not the active post-0.19 implementation plan.
