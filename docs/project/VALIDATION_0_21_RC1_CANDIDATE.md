# FreeSeek Desktop 0.21.0-rc.1 — Stable Consolidation Candidate

**Date:** 2026-08-22  
**Branch:** `dev/0.21-ui`  
**Scope:** local/internal Desktop Stable promotion candidate; public signing remains separate.

## Frozen product scope

This RC contains the completed Desktop UI Experience Convergence U0–U5 only. It does not start General HMR, duplicate the Agent/Kernel, or reopen the frozen 0.20 Stable line.

Included UI contracts:

- renderer-safe ACP presentation projection and three-pane Desktop shell;
- typed terminal/read/search/mutation/web/code/JSON/generic tool cards;
- Trajectory Inspector with turn/tool/mode/permission/elicitation lifecycle, filter/search and bidirectional navigation;
- execution-backed file read/mutation evidence, ACP `locations`/structured diff projection and create-only produced deliverables;
- bounded long-session rendering (120 Conversation / 160 Trajectory mounted windows), 8K mutable streaming Markdown tail, bounded/deferred large output and accessibility/focus hardening.

## Release-tooling correction discovered during promotion

The existing RC planner only accepted `dev.N -> rc.1`, although the documented project line had already progressed through `alpha.N` and `beta.N`. The candidate therefore includes a narrowly scoped release-tooling fix: `dev/alpha/beta -> same-base rc.1` is allowed; base-version drift, skipped `rc.1`, direct prerelease-to-Stable promotion and non-sequential published RC increments remain rejected.

## Candidate-local validation

- Desktop U2–U5 focused suite + release-promotion suite: **22/22 PASS**.
- Renderer strict TypeScript with no external ambient types: **PASS**.
- `git diff --check` and release/build script syntax: **PASS**.
- Repository gates 3–7/8 (hygiene, Runtime boundary, benchmark boundary, Host boundary, version/state coherence): **PASS**.

Full dependency-backed repository typecheck, `npm test` and production Desktop build are not marked green in this container because the pinned local dependency tree is unavailable.

## Required evidence before local/internal Stable freeze

Run the provided Windows x64 validation kit against the exact final RC1 commit. It must return all of the following on the same commit/version:

1. `npm ci`, full `npm run check` and `npm test`;
2. candidate-bound Official ACP TypeScript SDK 1.3.0 + OpenClaw acpx 0.13.0 interoperability;
3. official Electron 43.3.0 archive integrity verification;
4. development and productized packaged Desktop E2E with `app.isPackaged=true`;
5. Windows DPAPI secureStorage;
6. packaged forced-kill same-session recovery;
7. unsigned/local portable artifact construction plus 0.20.0 -> 0.21.0-rc.1 fresh-install/upgrade/rollback preflight.

Public Authenticode signing is not implied by the local/internal Stable target. No `v0.21.0` Stable tag should be created until the returned RC evidence has been reviewed.
