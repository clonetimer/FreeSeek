# FreeSeek Desktop UI 0.21.0-dev.3 — U3 Validation

Date: 2026-08-21

Branch: `dev/0.21-ui`
Milestone: **U3 — Trajectory Inspector**

## Scope closed in this checkpoint

- Added `apps/desktop/src/trajectory.ts`, a renderer-safe projection/search layer for Desktop trajectory rows.
- Trajectory categories now cover turn, assistant message, reasoning, tool, mode, permission, elicitation and unknown ACP/Host events.
- Live turns are created from the renderer's authorized `session/prompt` flow and close from its returned `stopReason`/error state.
- History replay turns are numbered from projected `user_message_chunk` order and labeled `history`; the Desktop does not invent persisted turn IDs, turn-end status, timestamps or durations that ACP does not expose.
- Permission/elicitation Host requests enter the inspector as `pending` and transition to `completed`/`cancelled`. The trajectory does not retain submitted elicitation answer content.
- Added category filtering and tokenized trajectory search using a bounded cached index. Large individual detail payloads are bounded for indexing; U5 virtualization remains separate.
- Added bidirectional tool navigation: Conversation tool cards can jump to the matching trajectory row, and trajectory details can jump back to the corresponding conversation/tool card.

## Evidence boundary

U3 keeps the 0.20 architecture boundary unchanged:

- Renderer consumes only ACP `session/update` and Desktop Host request events exposed through the existing contextBridge API.
- Renderer does **not** import EventLog, ToolRuntime, tool bodies, filesystem or child-process APIs.
- Historical permission/elicitation decisions are not currently replayed by ACP/Host. U3 therefore does not infer or fabricate them during `session/load`.
- Existing tool `toolCallId` is used where available to link permission/tool presentation. No second Desktop Agent event schema or Kernel implementation was introduced.
- Structured mutation evidence, produced deliverables and diff facts remain U4; the trajectory never crawls the workspace to derive those claims.
- Incremental Markdown, virtualization/output caps and broader keyboard/ARIA/performance hardening remain U5. General HMR remains deferred.

## Validation performed in this container

| Validation | Result | Notes |
| --- | --- | --- |
| U3 focused projection/search/navigation suite | **PASS 9/9** | Covers U2 regression, permission/elicitation lifecycle, answer non-retention, missing-detail fail-soft search indexing, semantic search/filter, bounded 5,000-row long-session index and architecture/source assertions |
| UI-only strict TypeScript check | **PASS** | Global TypeScript 5.8.3 with empty external type roots; validates Renderer/presentation/registry/trajectory/contracts |
| Focused test-source TypeScript check | **PASS** | Same compiler with minimal Node test-module declaration stubs because local `@types/node` is absent |
| Renderer privileged-import scan | **PASS** | No EventLog/ToolRuntime/runtime-tool/fs/child-process import in renderer presentation graph |
| `git diff --check` | **PASS** | No whitespace errors |
| Repository non-type gates (`scripts/check.mjs` stages 3–7) | **PASS** | Hygiene, runtime boundary, benchmark boundary, Host boundary and version/project-state coherence all pass; stages 1–2 cannot launch without local TypeScript |
| Frozen Stable refs | **PASS** | `v0.20.0^{}` and `origin/stable/0.20` remain at `67bbe2fe0b97a347e1bb6fa26fb196b553326df7` |
| npm registry preflight | **BLOCKED BY ENVIRONMENT** | `registry.npmjs.org` DNS resolution is unavailable; `npm ping` timed out and local dependency tree remains incomplete |
| Full `npm run check` | **BLOCKED BY ENVIRONMENT** | Repository script requires `node_modules/typescript/bin/tsc`, which is unavailable in the incomplete local dependency tree |
| Full `npm test` | **BLOCKED BY ENVIRONMENT** | Same dependency restore limitation |
| Fresh Desktop renderer build | **BLOCKED BY ENVIRONMENT** | `npm run desktop:build` cannot launch local TypeScript and local esbuild is also absent; build contract remains the U2 browser-IIFE path |

## Long-session interpretation

U3 does **not** claim that full trajectory virtualization is complete. Instead it avoids an avoidable U3 bottleneck by caching a bounded searchable index per projected row and coalescing streamed assistant/reasoning chunks into their existing trajectory rows. Virtualized row rendering, broader output caps and stress-budget work remain U5 by design.

## U3 exit decision

U3 is closed at the source/contract level. The inspector now exposes the lifecycle facts actually available through ACP/Host, with search/filter and navigation, while explicitly representing metadata gaps instead of bypassing the architecture boundary.

The next UI milestone is **U4 — evidence-backed file changes, diffs and deliverables**. U5 and General HMR remain deferred.
