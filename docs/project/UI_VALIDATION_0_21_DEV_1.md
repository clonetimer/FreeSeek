# FreeSeek Desktop UI 0.21.0-dev.1 — U0/U1 Validation

Date: 2026-08-21
Branch: `dev/0.21-ui`

## Scope

- U0: renderer-safe ACP session/update presentation projection.
- U1: Workspace/Conversation/Trajectory-Artifact three-pane shell with collapsible details.
- Typed tool card styling uses ACP coarse tool kinds; no new Agent/tool runtime is introduced.
- General HMR remains out of scope.

## Validation performed

- UI-only strict TypeScript check (`contracts.ts`, `presentation.ts`, `renderer.ts`): PASS.
- Native esbuild 0.21.5 browser bundle for Desktop renderer: PASS.
- Desktop Host + UI presentation focused tests: 7/7 PASS.
- `git diff --check`: PASS.
- FreeSeek non-type engineering gates from `scripts/check.mjs`:
  - hygiene: PASS;
  - runtime boundary: PASS;
  - benchmark boundary: PASS;
  - host boundary: PASS;
  - version/project-state coherence: PASS.

## Environment limitation

The current container does not have the lockfile-pinned `@types/node` and `@types/vscode` packages. Therefore the repository-wide source/test TypeScript gates in `npm run check` cannot be executed honestly here. They fail before product checking with `TS2688` missing type-definition errors. This is recorded as a validation-environment limitation, not as a passed full-repository gate.

## Architecture assertion

The UI presentation layer consumes ACP session/update payloads only. It does not import EventLog, ToolRuntime, Agent orchestration, Node filesystem/process APIs, or workspace-scanning logic. File mutation/diff/deliverable semantics remain deferred until ACP/Host exposes explicit evidence-backed projection fields.
