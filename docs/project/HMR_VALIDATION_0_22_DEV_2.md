# FreeSeek General HMR 0.22.0-dev.2 Validation

Date: 2026-08-22
Branch: `dev/0.22-hmr`
Starting H0/H1 checkpoint: `1aaf9e9ad435e4f3bfb2d220eeebf7954b59fc9f`
Frozen UI RC: `0.21.0-rc.1 @ 84d14cd68a07bb0b20dc5cd046157f7feed0cab5`

This record validates **H2 contribution expansion**. It does not promote the separate 0.21 RC, does not create `v0.21.0`, and does not start H3/H4.

## Scope closed in dev.2

### H2-A — Skill roots/assets

- Add generation-owned `ExtensionSkillContribution` and `capabilities.skills`.
- Add declarative package `contributions.skillRoots` adapter.
- Resolve roots strictly inside the trusted package; reject root/SKILL symlink escapes.
- Snapshot Skill markdown during candidate activation rather than retaining a mutable package path.
- Bound package Skill snapshots to 128 assets / 2 MiB per candidate.
- Mount snapshots into a run-local `SkillManager` only after the immutable ToolRegistry is fixed.
- Mark extension Skill entries read-only and restore the original host/base SkillManager when the generation lease releases.
- Package edits are picked up by the existing package fingerprint watcher and therefore create a later generation; an already leased run keeps the old bytes.

### H2-B — Policy/Hook contributions

- Add generation-owned `registerPolicy` and `registerHook`, gated by `capabilities.hooks=true`.
- Execute policy and hooks through the pinned `ExtensionLease` inside `ToolRuntime`; no global callback registry is introduced.
- Policy is monotonic: block/warn only. It cannot return an allow/grant that bypasses built-in deny, approval, MCP approval or sandbox admission.
- Pre-tool hooks may block/warn. Failures are fail-closed.
- Post-tool hooks may append warnings/notes only; they cannot replace the tool result or retroactively undo a completed side effect. Post-hook failure is appended as a diagnostic.

### H2-C — MCP contribution adapter

- Add generation-owned `ExtensionMcpContribution` and canonical `mcp__ext_<extension>_<server>__<tool>` projection.
- Add declarative package `contributions.mcpServers` adapter backed by one candidate-owned `McpManager` per configured server.
- `capabilities.mcp=true` is required by Runtime registration; declarative stdio additionally requires `shell=true`, while HTTP additionally requires `network=true`.
- Connection/tool projection failure fails candidate activation and preserves last-known-good.
- The `McpManager` disposer belongs to the generation effect scope; retired connections remain usable by old leases and dispose only after the final release.
- H2 intentionally projects MCP tools only. Resources/prompts are not claimed as extension contributions in dev.2.

## Focused regression

H0-H2 core/regression set:

- `tests/extension-runtime.test.ts`
- `tests/extension-package-watcher.test.ts`
- `tests/extension-package-contributions.test.ts`
- `tests/extension-registry-boundary.test.ts`
- `tests/tool-runtime.test.ts`
- `tests/skills.test.ts`

Result after H2 refactor: **67/67 PASS**.

Host regression set:

- `tests/acp-server.test.ts`
- `tests/headless.test.ts`
- `tests/desktop-host.test.ts`

Result: **16/16 PASS**.

Total focused/Host assertions: **83/83 PASS**.

Important H2 evidence includes:

- real `SKILL.md` bytes changing V1 → V2 while an old generation lease still reads V1;
- run-boundary SkillManager mount and restoration without mutating the base manager;
- ToolRuntime extension policy block/warning and pre/post hook semantics;
- a real local stdio MCP mock server being connected, namespaced, executed and retained by an old lease after package retirement;
- stdio MCP activation failing before process mount when `capabilities.shell=true` is absent;
- a real ACP process loading a package with declarative Skill roots, successfully executing `load_skill`, then enforcing an extension policy against `read_file` on a later turn;
- the existing ACP V1→V2 trusted tool HMR E2E, session/resume/MCP/cancel/elicitation/additionalDirectories contracts, Headless runtime paths and Desktop launch/client contracts remaining green.

## Type / architecture gates

- A global TypeScript 5.8.3 strict selected-source pass was used because the project-pinned local compiler tree is absent. After fixing H2 contextual callback typing, **no diagnostics point to the H2 extension/runtime/ToolRuntime/Skill files**. Remaining diagnostics are environment/baseline imports (`vscode`, `iconv-lite` declarations) plus an existing Node Buffer typing difference in `src/cdp.ts`.
- `git diff --check`: **PASS**.
- Repository `scripts/check.mjs` stages 3–7/8: **PASS** after refactoring contribution construction out of `runtime.ts`.
- `src/kernel/extensions/runtime.ts`: about 516 physical lines, below the existing 600-line gate.
- `src/agent.ts`: 799 physical lines (`scripts/check.mjs` reports within the existing 800-line policy); no max-line exception was added or raised.
- ToolRegistry → ToolRuntime, benchmark/private-holdout, Kernel → Host direction and version/project-state coherence gates remain green.

## Environment-blocked full gates

The checkpoint does not contain the project-pinned local `node_modules` tree. `npm ci --offline --ignore-scripts` fails because the npm cache is missing at least `yazl-2.5.1.tgz`; network registry recovery is unavailable in this environment.

Therefore repository `scripts/check.mjs` stages 1–2 cannot start because `node_modules/typescript/bin/tsc` is absent. Full project-pinned `npm test` and production builds are **not** claimed as completed. The focused tests were executed with the globally available `ts-node` plus globally available runtime dependencies solely as a validation workaround.

## Security / truth boundary

- `trust=trusted` remains operator-trusted in-process Node code, not a JavaScript/OS sandbox.
- H2 capabilities are explicit admission/audit declarations. The declarative MCP adapter refuses to silently infer shell/network privilege from `mcp=true`.
- Skill paths/bytes are evidence from candidate activation and are not reread through a mutable path inside an already leased run.
- Policy/Hook contributions cannot grant permissions or weaken existing ToolRuntime deny/approval/sandbox semantics.
- MCP resources/prompts, cross-host management UX and untrusted execution are deliberately not represented as completed features.

## Release-line separation

- `v0.20.0^{}` remains `67bbe2fe0b97a347e1bb6fa26fb196b553326df7`.
- `dev/0.21-ui` remains frozen at `84d14cd68a07bb0b20dc5cd046157f7feed0cab5` (`0.21.0-rc.1`).
- `v0.21.0` remains absent.
- Windows native Electron/DPAPI/recovery/upgrade/interop evidence is still required before the separate 0.21 Stable promotion.

## Next milestone

**H3 only**: cross-host extension management/configuration, durable activation/reload audit/status projection and operator UX. H4 untrusted/model-generated out-of-process sandbox remains later and must not be pulled into H3 implicitly.
