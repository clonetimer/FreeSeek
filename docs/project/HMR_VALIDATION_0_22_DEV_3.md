# FreeSeek General HMR 0.22.0-dev.3 Validation

Date: 2026-08-22
Branch: `dev/0.22-hmr`
Milestone: **H3 — Extension Management / Durable Audit / Operator UX**

## Scope

H3 closes the trusted in-process General HMR v1 management surface without changing H0-H2 generation semantics. The milestone adds:

- host-neutral `list/status/reload/remove/reconcile/config/audit` management;
- durable operator enable/disable intent inside host-owned state;
- process-level Runtime/watcher/management audit projection;
- managed health for `ok`, LKG `degraded`, `pending`, `error`, `disabled`, `conflict`, `absent`;
- FreeSeek vendor ACP JSON-RPC management methods;
- provider-free Headless one-shot management;
- Desktop trusted-root settings and status/actions routed through Renderer -> preload -> Electron main -> ACP;
- VS Code explicit `freesek.extensionDirs` process host and minimal management command.

H3 does **not** implement H4 untrusted/model-generated execution, package install/marketplace/signing, runtime trust-root widening, Renderer plugin APIs, package-byte deletion, or live mutation of an Agent run's ToolRegistry.

## Management truth boundary

- `remove` is deliberately a durable operator **disable + retire** operation. H3 never deletes package bytes.
- Trust roots are owned by Host startup configuration. The management service can enable/disable a known Extension ID but cannot add or replace trust roots.
- Corrupt `extension-intent.json` is security-relevant and fails closed: the HMR Host refuses to construct rather than silently re-enable previously disabled trusted code.
- Forced `reload` creates a new candidate/generation even when the package fingerprint is unchanged; existing leased runs retain their old generation.
- Duplicate IDs do not choose a winner; the prior last-known-good generation remains available while management reports `conflict`.
- A failed candidate with an active generation reports `degraded` / last-known-good. A never-active failed package reports `error`. Missing extension dependencies report `pending`.

## Audit boundary

H3 uses two scopes rather than attributing process-wide reloads to arbitrary sessions:

1. `extension-audit.jsonl` is process-level durable lifecycle audit for Runtime, watcher and management events. The in-memory projection is capped at 2,000 rows, management query output at 500 rows, and the active journal rotates at 8 MiB.
2. Existing per-session EventLog continues to record `extension/lease` / `extension/release`, binding an Agent run to the exact generation set it executed.

Audit sink failures remain observability failures and do not mutate Runtime semantics. Operator intent is separate and fail-closed because it controls whether trusted code may activate.

## Host wiring

### ACP

H3 methods use FreeSeek vendor names under `freesek/extensions/*`:

- `list`
- `status`
- `reload`
- `remove`
- `reconcile`
- `config`
- `audit`

They are dispatched through a separate ACP adapter. ACP v1 session methods remain unchanged. Management requests wait for the process-shared Extension Host initial scan before projecting status.

### Headless

`--extension-manage list|status|reload|remove|reconcile|audit|enable|disable`:

- requires one or more explicit `--extension-dir` trust roots;
- does not require Provider URL, model or prompt;
- uses the same durable H3 state directory under the configured session directory;
- persists disable intent across separate process invocations.

### Desktop

- `DesktopStartRequest` / persisted non-secret settings include `extensionDirs`.
- Electron main validates absolute existing directories and forwards them to the ACP sidecar.
- Renderer receives only management projections/actions through preload IPC; it does not import filesystem, EventLog, ExtensionRuntime or FileExtensionHost.
- The Extensions panel exposes trust roots, health/LKG/error/dependency status, reload, enable/disable, reconcile and recent audit.
- Changing trusted roots takes effect on the next ACP connection; H3 does not hot-widen roots in an already running process.

### VS Code

- `freesek.extensionDirs` defaults to an empty list and admits only explicit absolute roots.
- No workspace-local Extension directory is auto-scanned.
- One process-level `FileExtensionHost` uses `globalStorageUri/extensions` for durable H3 state and its Runtime is injected into the existing `ChatViewProvider` / Agent path.
- `FreeSeek: 管理 General HMR 扩展` exposes reconcile/reload/enable/disable/audit projection.
- Trust-root setting changes require a VS Code window reload to rebuild the process-level Host.

## Validation results

### H0-H3 combined behavioral regression

Executed with the checkpoint's global `ts-node` runner because pinned local `node_modules` is absent. A **test-only external `iconv-lite` import shim** was used solely to satisfy module loading for the existing UTF-8 ACP/Headless test paths; it is not part of FreeSeek source/checkpoint and is not a production dependency substitute.

Test set:

- `tests/extension-runtime.test.ts`
- `tests/extension-package-watcher.test.ts`
- `tests/extension-package-contributions.test.ts`
- `tests/extension-registry-boundary.test.ts`
- `tests/tool-runtime.test.ts`
- `tests/skills.test.ts`
- `tests/extension-management.test.ts`
- `tests/acp-server.test.ts`
- `tests/headless.test.ts`
- `tests/desktop-host.test.ts`

Result at final candidate source before commit: **93/93 PASS**.

H3-specific coverage includes:

- disable/remove intent persistence across Host restart without deleting package bytes;
- forced reload producing a new generation at unchanged fingerprint;
- LKG `degraded`, duplicate `conflict`, dependency `pending`, never-active `error` projection;
- corrupt durable intent fail-closed;
- Runtime/watcher/management audit recovery across restart;
- 8 MiB audit journal rotation;
- durable audit payload bounds (4K text, 128 missing dependencies, 256 generation summaries) before persistence/projection;
- ACP vendor management list/config/reload/audit and invalid-parameter handling;
- Headless management without Provider/prompt and persistent disabled intent;
- Desktop ACP client management RPC coverage.

### Host-boundary structural regression

`tests/extension-management-host-wiring.test.ts`: **3/3 PASS**.

This checks that:

- vendor management is kept outside the ACP v1 session switch;
- Desktop Renderer remains privilege-minimal and management goes through preload/main;
- VS Code uses explicit configured roots/global host state and does not add a workspace Extension auto-scan path.

### Desktop security regression

`tests/desktop-security.test.ts`: **26/26 PASS**.

The suite continues to cover safeStorage, settings secret stripping, sidecar argv/env credential boundaries, BrowserWindow/CSP isolation, artifact path containment, recovery/update security and presentation history. H3 additionally persists/sanitizes `extensionDirs` as non-secret settings.

### Desktop strict TypeScript

Global TypeScript 5.8.3 against `tsconfig.desktop.json` with the available global Node type root: **PASS**.

### H3 selected-source TypeScript diagnostics

A strict global TypeScript 5.8 selected graph was run over the changed H3 Runtime/ACP/Headless files. The overall command cannot be green in this checkpoint because the dependency tree is absent and the global Node typings also expose existing baseline diagnostics (`vscode`, `iconv-lite`, and pre-existing `cdp.ts` generic differences). **Zero diagnostics referenced H3-changed files.** This is supporting evidence only; it is not represented as the pinned project typecheck.

### Repository checks

`scripts/check.mjs`:

- 3/8 hygiene: **PASS**; `src/hosts/acp/server.ts` management RPC was extracted instead of increasing the 600-line threshold.
- 4/8 Runtime boundary: **PASS**.
- 5/8 benchmark/private-holdout boundary: **PASS**.
- 6/8 Kernel -> Host dependency direction: **PASS**.
- 7/8 package/lock/project-state coherence: **PASS**.
- 1/8 source typecheck: **BLOCKED BY ENVIRONMENT** — `node_modules/typescript/bin/tsc` absent.
- 2/8 test typecheck: **BLOCKED BY ENVIRONMENT** — same missing pinned TypeScript executable.
- 8/8 export JSDoc remains advisory/non-blocking and reports pre-existing missing JSDoc exports.

`git diff --check`: **PASS**.

### Dependency-backed commands

- `npm test`: **BLOCKED BY ENVIRONMENT** before tests start because local pinned TypeScript is absent (esbuild also unavailable).
- `npm run desktop:build`: **BLOCKED BY ENVIRONMENT** at the same missing local TypeScript executable.

The repository/checkpoint does not contain `node_modules`, and the available npm offline cache is incomplete. No production source or release contract was weakened to manufacture a green dependency-backed result.

## Release-line separation

- `v0.20.0^{}` remains `67bbe2fe0b97a347e1bb6fa26fb196b553326df7`.
- frozen `dev/0.21-ui` remains `84d14cd68a07bb0b20dc5cd046157f7feed0cab5` (`0.21.0-rc.1`).
- `v0.21.0` remains absent.
- H3 code is only on `dev/0.22-hmr`; it is not backported to the pending 0.21 release candidate.

## Security conclusion

H3 improves **operator control and observability** for trusted in-process Extensions, but does not change the trust model. `trust=trusted` still means Node code trusted by the operator and running with the FreeSeek process privileges. Capability declarations remain admission/audit metadata, not enforceable OS isolation.

## Next milestone

**H4 only:** untrusted/model-generated Extension execution must move out of process with enforceable capability isolation, lifecycle supervision, bounded IPC and failure containment. H3 should not be reopened to simulate H4 with in-process policy metadata.
