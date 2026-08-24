# FreeSeek Desktop UI 0.21.0-dev.2 — U2 Validation

Date: 2026-08-21

Branch: `dev/0.21-ui`
Milestone: **U2 — Typed tool/output cards**

## Scope closed in this checkpoint

- Added `apps/desktop/src/presentation-registry.ts`, a renderer-safe registry derived only from the existing ACP presentation projection.
- Specialized card families: terminal/execute, read, search, mutation, web/fetch, code, JSON and generic fallback.
- Assistant and reasoning chunks now have explicit presentation intents; incremental Markdown rendering itself remains U5.
- Conversation tool cards and Trajectory tool details render the same `DesktopToolPresentation` model.
- Mutation cards intentionally do **not** infer diffs from raw text or inspect the workspace. Structured file-change/deliverable evidence remains U4.
- `scripts/desktop-build.mjs` now formalizes the browser renderer bundle required by Electron's `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true` boundary. It uses the already-locked esbuild dependency and does not introduce HMR.

## Boundary checks

U2 keeps the frozen architecture unchanged:

- Renderer consumes ACP/Host-projected data; it does not import EventLog, ToolRuntime, Agent Kernel, filesystem or child-process APIs.
- Desktop is still a Host/UI surface, not a second Agent implementation.
- `0.20.0 Stable` is unchanged and no RC/Stable promotion or release-signing workflow was reopened.
- DeepSeek Harness was used only as an interaction/reference model; no Harness runtime, plugin system or HMR implementation was copied into FreeSeek.

## Validation performed in this container

| Validation | Result | Notes |
| --- | --- | --- |
| Focused Desktop presentation suite | **PASS 7/7** | Includes U2 specialized cards, JSON/generic fallback, message intent and architecture assertions |
| Focused Desktop Host suite | **PASS 3/3** | Confirms Host behavior remains intact |
| UI-only strict TypeScript check | **PASS** | Used the available global TypeScript compiler with an empty external type root because local dependencies could not be restored |
| Renderer privileged-import scan | **PASS** | No direct EventLog/ToolRuntime/runtime-tool/fs/child-process import in renderer presentation modules |
| `node --check scripts/desktop-build.mjs` | **PASS** | Build script syntax valid |
| `git diff --check` | **PASS** | No whitespace errors |
| Repository non-type gates | **PASS** | hygiene, runtime boundary, benchmark boundary, host boundary and version/project-state coherence |
| Full `npm run check` | **BLOCKED BY ENVIRONMENT** | Typecheck stages cannot start because local `node_modules/typescript/bin/tsc` is absent after `npm ci` failed with registry DNS `EAI_AGAIN` |
| Full `npm test` | **BLOCKED BY ENVIRONMENT** | Build cannot start for the same missing local dependency tree |
| Current dev.2 native esbuild renderer execution | **BLOCKED BY ENVIRONMENT** | Build contract is integrated and statically tested, but the local esbuild executable is unavailable after failed dependency restore |

The preceding `0.21.0-dev.1` checkpoint had already executed an esbuild 0.21.5 browser bundle successfully. That prior evidence supports the bundling approach but is **not** counted as a fresh `dev.2` execution.

## U2 exit decision

U2 is closed at the source/contract level because the feature-specific tests, Host regression tests, TypeScript check and architecture boundaries pass, and the only unavailable gates require dependencies that this container could not restore. No product assertion failure is being waived.

The next UI milestone is **U3 — Trajectory inspector**. U4 file evidence/diffs and U5 incremental Markdown/performance/accessibility remain intentionally separate; General HMR remains deferred.
