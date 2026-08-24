# FreeSeek UI Reference — DeepSeek-Harness Interaction Patterns

Status: **0.21 Desktop UI Experience Convergence U0–U5 complete; 0.20 Stable remains frozen separately**
Reviewed: 2026-08-22
Reference input: user-provided `deepseek-harness(4).zip`

## 1. Purpose

This note records interaction and information-architecture patterns worth adapting after FreeSeek 0.20 Desktop Stable. It is deliberately not a request to copy DeepSeek-Harness into FreeSeek, and it does not change the 0.20 Agent boundary.

The reviewed DeepSeek-Harness root source is MIT-licensed. FreeSeek should still prefer concept-level adaptation; if any substantial source is later reused, its copyright/license notice must be preserved as required by MIT.

## 2. What is actually valuable

The strongest ideas are not cosmetic. They are presentation contracts that make a tool-using Agent legible:

| DeepSeek-Harness pattern observed | FreeSeek value | Adaptation rule |
| --- | --- | --- |
| `ui-layout` three-column shell: sidebar / conversation / details, resizable handles, narrow-screen concession | Keep navigation, conversation and inspection visible without turning chat into a dashboard | Reimplement with FreeSeek state; do not import Harness slot/runtime framework |
| `ui-tool` compact `ToolRow` plus expandable details | Dense tool runs remain scannable while preserving full evidence | Add a FreeSeek presentation registry over ACP-projected tool events |
| Specialized terminal/read/search/diff/web primitives | Output form follows semantic type instead of flattening everything into prose | Use typed presentation models with a safe generic fallback |
| `ui-trajectory` turn-aware table/timeline, search index and virtual rows | Make Agent execution, tool calls and phase changes inspectable | Project an explicit trajectory model from ACP/session events; Renderer must not read EventLog directly |
| Produced-files row derived from mutation-tool outputs | Users can immediately see what changed/was created without trusting closing prose | Derive deliverables from authorized mutation results, never from prose heuristics |
| Host-mediated open-file affordance | UI can open artifacts without obtaining raw filesystem privileges | Keep path opening behind constrained Desktop IPC/HostCapability |
| Incremental Markdown pipeline and finalized code highlighting | Streaming remains stable while completed content becomes richer | Separate streaming parse/render state from finalized rich rendering |
| Trajectory virtualization and search | Long sessions remain usable | Introduce virtualization only after semantics/data contracts are stable |
| Dedicated approval/question/task states | Agent lifecycle is visible rather than hidden inside text | Present ACP permission/elicitation/task state as first-class UI state |

## 3. FreeSeek architecture boundary remains unchanged

Future UI work must keep the 0.20 boundary:

```text
Electron Renderer
  -> sandboxed preload/contextBridge IPC
  -> DesktopRuntime / Desktop Host
  -> ACP sidecar
  -> shared FreeSeek Kernel / ToolRegistry / ToolRuntime / EventLog
```

The following shortcuts are forbidden even if they would make a trajectory panel easier to build:

1. Renderer directly reading `EventLog` or session storage files.
2. Desktop importing or reimplementing `ToolRuntime`, tool bodies or Agent orchestration.
3. Renderer scanning the workspace to infer changed/produced files.
4. A Desktop-only second tool schema or second Agent event model that can drift from ACP/Kernel semantics.
5. Pulling DeepSeek-Harness Cordis/slot/HMR runtime into FreeSeek 0.20. General HMR remains deferred until Desktop Stable.

## 4. Proposed FreeSeek presentation model

Post-Stable UI should treat raw Agent/session data and presentation as two separate layers.

### 4.1 Presentation registry

A future `PresentationRegistry` (name provisional) should map authorized ACP/session payloads into views such as:

- assistant Markdown / reasoning;
- code / JSON;
- terminal execution;
- file read;
- workspace search;
- diff / mutation;
- web/retrieval result;
- generic/unknown tool fallback.

Unknown or malformed tool payloads must degrade to a generic expandable representation instead of crashing the conversation.

### 4.2 Trajectory projection

A future trajectory panel should be a **projection**, not a second source of truth. Candidate event categories:

- turn start/end;
- assistant/reasoning chunks;
- tool call start/result/error/cancel;
- permission request/decision;
- elicitation request/result;
- context/compaction markers when exposed by the protocol;
- file mutation/deliverable references;
- child-agent lifecycle when explicitly supported.

If ACP does not yet expose enough metadata, extend the ACP/Host projection contract after 0.20 rather than bypassing it in Electron.

### 4.3 File changes and deliverables

File UI should distinguish:

- **read/reference** files;
- **mutated** files;
- **produced deliverables**;
- **diff evidence**.

The source of these facts must be shared ToolRuntime/Kernel events projected through ACP or an explicit host capability. Desktop may render/open them, but must not infer truth by crawling the filesystem.

## 5. Current ACP readiness for this UI direction

FreeSeek already projects enough information to support the first UI iteration without a second Agent protocol. Current ACP updates include:

- `agent_message_chunk` and `agent_thought_chunk`;
- `tool_call` with `toolCallId`, tool title, coarse `kind`, status and `rawInput`;
- `tool_call_update` with completion/failure status and `rawOutput`;
- `current_mode_update`;
- history replay of the same user/assistant/reasoning/tool presentation events through `session/load`.

This is enough for U1/U2 typed cards and the U3 renderer-side Trajectory Inspector. U3 deliberately numbers turns from projected user-message order and treats live Host requests as ephemeral lifecycle facts; it does not claim protocol-level persisted turn IDs or historical approval replay. U4 additionally projects successful file-tool facts through ACP v1 `locations` / structured `diff` content plus namespaced provenance metadata, backed by existing ToolRuntime callbacks and durable EventLog replay. The remaining semantic gaps for a richer Harness-like inspector are:

1. explicit turn/step identity plus timestamps/durations for timeline/waterfall views;
2. context-plan/compaction and task-state projection where those facts are safe and protocol-stable;
3. optional child-agent lifecycle projection;
4. long-trajectory paging/index metadata so virtualization does not require loading the whole EventLog.

Those gaps are candidates for post-0.20 ACP/Host presentation extensions. They are **not** justification for direct Desktop access to Kernel/EventLog internals.

## 6. Proposed post-Stable UI milestones

These are sequenced after D5. U0/U1 began on `dev/0.21-ui` after the 0.20 Stable freeze; General HMR remains outside this line.

| UI milestone | Scope | Exit condition |
| --- | --- | --- |
| U0 — Presentation contract | **Done in 0.21.0-dev.1:** `apps/desktop/src/presentation.ts` normalizes existing ACP updates into text/tool/mode/unknown presentation events | No new Kernel fork; contract tests exist |
| U1 — Layout shell | **Done in 0.21.0-dev.1:** workspace/sidebar + conversation + collapsible Trajectory/Artifact details shell | Renderer remains behind the ACP/Host boundary |
| U2 — Typed tool/output cards | **Done in 0.21.0-dev.2:** terminal/read/search/mutation/web/code/JSON plus generic fallback; assistant/reasoning presentation intents are registered without pulling U5 incremental Markdown forward | Same underlying ACP event renders consistently in chat and details; mutation UI does not invent diff evidence |
| U3 — Trajectory inspector | **Done in 0.21.0-dev.3:** turn/tool/mode plus live permission/elicitation lifecycle rows, bounded cached search/filter index, Conversation ↔ Trajectory tool navigation; replayed turns are explicitly labeled `history` when end-state metadata is absent | No direct EventLog access; long-session focused tests pass |
| U4 — File changes/deliverables | **Done in 0.21.0-alpha.1:** successful file reads/mutations are correlated to `toolCallId`, projected through standard ACP locations/diffs, replayed from durable EventLog evidence, grouped in Artifact UI, and only proven creates are labeled produced files; safe current-file open/preview remains Host-mediated | Every file fact is evidence-backed by an authorized event |
| U5 — Streaming/performance/accessibility | **Done in 0.21.0-beta.1:** incremental HTML-safe Markdown with bounded mutable streaming tail, 120-entry Conversation / 160-row Trajectory mounted windows, bounded/deferred large-output views, keyboard/focus/ARIA and reduced-motion hardening | 17/17 focused presentation/performance tests pass; mounted long-history/streaming work stays inside explicit budgets |

## 7. What not to copy

- DeepSeek branding or visual identity.
- Its framework/plugin/HMR runtime as a shortcut to UI modularity.
- DeepSeek-specific message/tool schemas where ACP/FreeSeek already owns the semantic contract.
- Components whose primary value is implementation convenience rather than interaction semantics.

## 8. Timing decision

The 0.20 Desktop Stable boundary remains frozen. **Desktop UI Experience Convergence U0–U5 is complete on `dev/0.21-ui` at 0.21.0-beta.1.** This does not automatically start General HMR: runtime modularity remains a separate line and requires an explicit user transition. U5 bounds mounted Renderer work, but it does not fabricate ACP server-side paging/index metadata; that protocol-level gap remains explicit.
