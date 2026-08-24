# FreeSeek Desktop UI 0.21.0-beta.1 — U5 Validation

Date: 2026-08-22

Branch: `dev/0.21-ui`
Milestone: **U5 — Large-session performance, accessibility and interaction polish**

## Scope closed in this checkpoint

- Replace per-chunk assistant transcript rewriting with an incremental, HTML-safe Markdown pipeline. Stable Markdown fragments render once; only an 8,000-character mutable tail is replaced while streaming.
- Preserve fenced-code presentation when a very long code block crosses forced stream-fragment boundaries by carrying minimal fence/language render context separately from the exact source text.
- Batch reasoning chunks per animation frame and append text nodes, avoiding `textContent +=` accumulation.
- Window mounted Conversation DOM to **120 projected entries** and mounted Trajectory DOM to **160 matching rows**. Older projected entries remain navigable and can be remounted around a requested target.
- Bound Trajectory search detail to **4,000 chars/row**, Trajectory detail preview to **12,000 chars**, tool presentation preview to **12,000 chars**, and artifact diff preview to **16,000 chars**.
- Avoid eager `JSON.stringify` / JSON parsing of arbitrarily large structured tool values. Bounded previews walk only enough structure to satisfy the UI budget; full serialization is deferred until explicit user expansion.
- Keep large tool output and historical artifact evidence inspectable through explicit expand controls rather than mounting the entire value by default.
- Add keyboard/focus semantics: roving Trajectory row navigation, left/right Details tabs, modal Escape + Tab/Shift+Tab focus containment, focus restoration, collapsed-details focus recovery, visible `:focus-visible`, ARIA log/listbox/dialog/tabpanel semantics, and reduced-motion CSS.
- Preserve U0–U4 contracts and the Desktop → ACP → shared Kernel boundary. U5 changes Renderer presentation/performance behavior only; it does not add a second Agent/event/runtime model.

## Explicit performance budgets

| Surface | U5 mounted/mutable budget |
| --- | ---: |
| Conversation mounted entries | 120 |
| Trajectory mounted matching rows | 160 |
| Mutable assistant Markdown tail | 8,000 chars |
| Trajectory search detail | 4,000 chars/row |
| Trajectory detail preview | 12,000 chars |
| Tool block preview | 12,000 chars |
| Artifact diff preview | 16,000 chars |

These are **Renderer work budgets**, not protocol claims. The current ACP projection does not expose server-side long-history paging/index metadata, so U5 keeps the full loaded projection model in Renderer memory while bounding mounted DOM/rendering work. It does not crawl EventLog or pretend server paging exists.

## Markdown/rendering boundary

The U5 Desktop renderer intentionally uses an HTML-safe local Markdown subset for streamed assistant content: headings, paragraphs, emphasis/strong, inline code, fenced code, blockquotes, ordered/unordered lists and horizontal rules. Raw HTML is emitted as text. This closes the incremental-rendering/per-chunk cost problem without adding Renderer privileges or relying on an unvalidated runtime plugin path. Broader Markdown enrichment can be considered later without reopening U5's performance contract.

## Validation performed in this container

| Validation | Result | Notes |
| --- | --- | --- |
| Desktop U2–U5 focused presentation/performance suite | **PASS 17/17** | Includes all prior U2–U4 presentation/evidence regressions plus U5 window, streaming, large-structure and fenced-code tests |
| 12,000-chunk assistant stream stress | **PASS** | Exact source characters preserved; mutable tail stays within 8K; focused run completes well below the intentionally generous 2s CI budget in this container |
| Long fenced-code stream stress | **PASS** | 128-char test tail forces many cuts; exact source reassembles and code-language context is retained across forced fragments |
| Window math stress | **PASS** | 50,000 Conversation / 100,000 Trajectory cardinalities never exceed mounted-window sizes and requested anchors remain visible |
| Huge structured detail stress | **PASS** | 25,000-row object preview stops at the configured cap instead of eagerly serializing the whole payload |
| Large structured tool input | **PASS** | 100K payload receives a bounded preview while retaining the original structured source only for explicit expansion |
| U3 5,000-row trajectory search regression | **PASS** | Bounded cached search index remains under the existing per-row cap and finds the target row |
| Renderer strict TypeScript | **PASS** | Global TypeScript 5.8.3; validates Renderer and its reachable presentation/performance modules without external ambient types |
| Renderer reachable privileged-import boundary | **PASS** | Renderer graph does not import filesystem, child process, EventLog, ToolRuntime or secure-store modules |
| `git diff --check` / Desktop build-script syntax | **PASS** | No whitespace errors; build orchestration script remains syntactically valid |
| Frozen Stable refs | **PASS** | `v0.20.0^{}` and `origin/stable/0.20` remain `67bbe2fe0b97a347e1bb6fa26fb196b553326df7` |
| npm dependency restore | **BLOCKED BY ENVIRONMENT** | Registry access remains unavailable in this container; pinned local dependency tree is incomplete |
| Full `npm run check` source/test type stages | **BLOCKED BY ENVIRONMENT** | Repository runner expects local `node_modules/typescript/bin/tsc`, which is absent; non-type architecture/state stages are executed separately |
| Full `npm test` | **BLOCKED BY ENVIRONMENT** | Same incomplete pinned dependency tree prevents the repository test runner from starting normally |
| Fresh Desktop bundle | **BLOCKED BY ENVIRONMENT** | Local pinned TypeScript/esbuild executables are absent; U2 browser-IIFE build contract itself is unchanged |

## U5 exit decision

U5 is closed at the source/contract level when the repository non-type gates remain green after the final metadata bump. Desktop UI Experience Convergence U0–U5 is therefore complete on `dev/0.21-ui` at `0.21.0-beta.1` without reopening 0.20 Stable or moving Agent/Kernel behavior into Desktop.

**General HMR is not started by this checkpoint.** It is a separate development transition and must wait for explicit user direction.
