# FreeSeek General HMR 0.22.0-dev.1 Validation

Date: 2026-08-22  
Branch: `dev/0.22-hmr`  
Fork point / frozen UI RC: `0.21.0-rc.1 @ 84d14cd68a07bb0b20dc5cd046157f7feed0cab5`

This record validates H0/H1 of the General HMR Extension Runtime. It does **not** promote `0.21.0-rc.1` to Stable and does not create `v0.21.0`.

## Scope closed in dev.1

### H0 — generation lifecycle and run-boundary atomicity

- Host-neutral `ExtensionRuntime` lifecycle: discover → validate → stage → activate generation → lease → retire → dispose.
- Immutable generation lease per Agent run; retained child/subagent leases keep the parent's exact generation.
- Reload atomically changes only the active generation pointer. A running turn never mutates its live `ToolRegistry`.
- Retired generations remain executable while leased and dispose only after the final lease releases.
- Reversible activation effects, dependency `PENDING`, last-known-good rollback and explicit trusted capability declarations.
- Extension schemas without a generation-bound executor fail closed and cannot fall back to raw tool dispatch.

### H1 — trusted package HMR and host mount

- Explicit operator-trusted CommonJS package format: `freeseek-extension.json` + `.js`/`.cjs` entry.
- Package/entry containment checks, manifest/entry symlink rejection, duplicate-ID fail-closed behavior and bounded package hashing.
- Dependency-free polling watcher with serialized scans, clean stop/drain, syntax/activation failure rollback, removal/retirement and last-known-good preservation.
- Repeatable `--extension-dir` trust roots for ACP/Headless; no automatic workspace plugin execution.
- One process-shared Extension Runtime/watcher for the ACP server, shared across durable ACP sessions.
- Desktop ACP launch contract can forward the same explicit extension roots without moving HMR into the Renderer/Desktop Agent layer.

## Focused regression

Combined command covered:

- `tests/extension-runtime.test.ts`
- `tests/extension-package-watcher.test.ts`
- `tests/extension-registry-boundary.test.ts`
- `tests/desktop-host.test.ts`
- `tests/acp-server.test.ts`

Result: **25/25 PASS**.

Important covered behavior includes:

- real filesystem package load and V1 → V2 reload;
- an old lease continuing to execute V1 after V2 activates;
- a later Agent/ACP turn acquiring and executing V2;
- failed reload preserving the last-known-good generation;
- dependency `PENDING` and reconciliation;
- package deletion retiring future visibility without killing a leased generation;
- duplicate extension IDs and entry traversal failing closed;
- actual watcher polling observing a later edit;
- a never-active broken package returning to `absent` after removal;
- orphan `ext__...` schemas being rejected without a generation executor;
- existing Desktop Host and ACP session/resume/MCP/cancel/elicitation/additionalDirectories contracts remaining green in the focused suite.

## Type / architecture gates

- Isolated strict TypeScript for `src/kernel/extensions/*`: **PASS** using TypeScript 5.8.3 with minimal host-neutral stubs.
- `git diff --check`: **PASS**.
- Repository `scripts/check.mjs` stages 3–7/8: **PASS**:
  - hygiene / file-size policy;
  - ToolRegistry → ToolRuntime boundary;
  - benchmark/private-holdout boundary;
  - Kernel → Host dependency direction;
  - package / lock / project-state version coherence.
- `src/agent.ts`: 798 physical lines; existing max-line debt threshold was **not** raised.
- `src/hosts/acp/server.ts`: 599 physical lines; HMR process ownership was split into a Host helper rather than increasing the existing threshold.

## Environment-blocked full gates

This container still lacks the project-pinned local dependency tree. `scripts/check.mjs` stages 1–2 cannot start because `node_modules/typescript/bin/tsc` is absent. Full dependency-backed `npm test` / production builds therefore are not claimed as completed here. This is the same environment limitation already recorded for the 0.21 UI candidate.

The focused runtime/Host tests above were executed with the globally available TypeScript/`ts-node` runtime solely as a validation workaround; this does not replace the project-pinned release gate.

## Security / evidence boundary

`trust=trusted` means operator-trusted **in-process Node code** in H1. Capability declarations are lifecycle/policy metadata and ToolRuntime constraints, **not a JavaScript sandbox**. FreeSeek does not auto-load extension code from a workspace. Untrusted or model-generated extension code remains H4 and must be out-of-process / sandboxed before admission.

Activation/reload audit callbacks exist, and run generation lease/release is projected to EventLog. A complete durable cross-host extension-management/audit surface is intentionally deferred to H3; dev.1 does not claim it.

## Release-line separation

- `v0.20.0^{}` remains `67bbe2fe0b97a347e1bb6fa26fb196b553326df7`.
- `dev/0.21-ui` remains frozen at `84d14cd68a07bb0b20dc5cd046157f7feed0cab5` (`0.21.0-rc.1`).
- `v0.21.0` does not exist in this checkpoint.
- Windows native Electron/DPAPI/recovery/upgrade/interop evidence is still required before the separate 0.21 Stable promotion.

## Next milestone

`H2 / 0.22.0-dev.2`: Skill roots/assets, Hook/policy contributions and MCP contribution adapters. H3 management UX/durable audit and H4 untrusted sandbox remain later milestones and must not be pulled into H2 implicitly.
