# FreeSeek Desktop UI 0.21.0-alpha.1 — U4 Validation

Date: 2026-08-21

Branch: `dev/0.21-ui`
Milestone: **U4 — Evidence-backed file changes, diffs and deliverables**

## Scope closed in this checkpoint

- Correlate successful `read_file` / mutation callbacks to the provider `toolCallId` inside `ToolRuntime`, so evidence remains correct even when read-safe calls execute concurrently.
- Reuse the existing durable EventLog for `presentation/file_evidence`; ACP `session/load` replays only facts that were actually persisted. Legacy sessions without these rows remain evidence-empty.
- Project file facts through ACP v1 tool-call presentation fields: standard `locations`, structured `diff` content for create/write/edit, plus namespaced FreeSeek provenance metadata carrying proven operation kind, path, line-change counts and deliverable status.
- Keep delete evidence fail-closed. The current `delete_file` callback does not retain a complete arbitrary pre-delete snapshot, so U4 records the confirmed deletion but does not fabricate structured Before/After content.
- Add a renderer-safe artifact-evidence projection shared by Conversation tool cards, Trajectory details and the Artifact pane. Generic ACP diffs without FreeSeek provenance remain generic `change` evidence instead of being guessed as create/edit.
- Group evidence by projected path, expose proven-create produced-deliverable chips, inspect structured Before/After data, and navigate between artifact evidence and its originating tool call.
- Keep current-file Preview/Open separate from historical evidence and behind the existing Electron-main authorized-root boundary; Renderer still has no direct filesystem, EventLog or ToolRuntime access.

## Evidence boundary

U4 deliberately distinguishes **observed execution evidence** from inference:

- File evidence originates only from successful FreeSeek tool-body callbacks (`onFileRead` / `onFileDiff`) correlated with the executing provider call ID.
- ACP standard `locations` and structured `diff` content are presentation projections of those facts; raw result prose is not parsed to discover files or mutations.
- Only an actual `create` mutation is labeled a produced deliverable. `write` / `edit` are mutations, not automatically "new outputs".
- `delete` remains a confirmed mutation with `diffAvailable=false` until the tool contract can provide a complete pre-delete snapshot.
- External/other ACP Agents can still supply standard diff content; without FreeSeek provenance the Desktop labels it only as a generic change and does not invent more specific semantics.
- Historical sessions are replayed from persisted evidence rows only. U4 does not crawl the current workspace to reconstruct missing history.
- Incremental Markdown, trajectory virtualization, broader large-output budgets, keyboard/ARIA polish and interaction/performance stress work remain U5. General HMR remains deferred.

## Validation performed in this container

| Validation | Result | Notes |
| --- | --- | --- |
| Desktop U2–U4 focused presentation suite | **PASS 12/12** | Covers typed presentation regressions, U4 standard evidence projection, create-only deliverables, generic fallback, delete-without-fake-diff, U3 permission/elicitation lifecycle, bounded 5,000-row trajectory search and architecture assertions |
| ACP U4 evidence/replay suite | **PASS 4/4** | Covers successful read/mutation projection, standard `locations` / diff content, create-only deliverables, delete fail-closed behavior, history replay and normal result-text preservation |
| ToolRuntime call-ID correlation probe | **PASS** | Actual `ToolRuntime.execute` wrapper forwarded the executing provider `callId` to read/diff evidence callbacks even when the tool body attempted to supply a different ID |
| ACP durable evidence collector probe | **PASS** | Collector persisted evidence as existing EventLog `presentation/file_evidence` rows and consumed evidence by `toolCallId` |
| Empty-file create evidence probe | **PASS** | Actual `write_file` body creates `empty.txt` and emits `kind=create` evidence even when unified line stats are `+0/-0`, so empty produced files are not lost |
| Renderer strict TypeScript check | **PASS** | Global TypeScript 5.8.3 with empty external type roots; validates contracts/presentation/artifact-evidence/registry/trajectory/renderer |
| Renderer privileged-import boundary | **PASS** | Focused source assertion confirms renderer presentation graph does not import EventLog, ToolRuntime, runtime tools, `node:fs` or `node:child_process` |
| `git diff --check` | **PASS** | No whitespace errors |
| Repository non-type gates (`scripts/check.mjs` stages 3–7) | **PASS** | Hygiene, runtime boundary, benchmark boundary, Host boundary and version/project-state coherence pass; ACP server remains under the repository line limit after evidence-store extraction |
| Frozen Stable refs | **PASS** | `v0.20.0^{}` and `origin/stable/0.20` both remain at `67bbe2fe0b97a347e1bb6fa26fb196b553326df7` |
| npm dependency restore | **BLOCKED BY ENVIRONMENT** | npm registry access times out in this container; the local dependency tree remains incomplete |
| Full `npm run check` | **BLOCKED BY ENVIRONMENT** | Stages 1–2 cannot launch because `node_modules/typescript/bin/tsc` is absent; stages 3–7 pass independently |
| Full `npm test` | **BLOCKED BY ENVIRONMENT** | Same incomplete dependency tree prevents the repository test runner from using its pinned local toolchain |
| Fresh Desktop renderer build | **BLOCKED BY ENVIRONMENT** | Local TypeScript/esbuild executables are unavailable; U2's browser-IIFE build contract is unchanged by U4 |

## U4 exit decision

U4 is closed at the source/contract level. FreeSeek can now present file reads, changes and produced files from execution-backed evidence, persist those facts for history replay, and expose the same semantics across Conversation, Trajectory and Artifact views without turning Desktop into a second Agent or allowing Renderer to infer runtime state.

The next UI milestone is **U5 — Large-session performance, accessibility and interaction polish**. U5 owns incremental Markdown, trajectory virtualization/long-history rendering, broader large-output budgets and keyboard/ARIA/performance hardening. General HMR remains deferred until the Desktop UI convergence line is complete.
