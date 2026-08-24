# 0.26.0 — Plugin Ecosystem: 插件加装（npm / git / file）+ 套件皮肤 Themes — 2026-08-24

在 0.25.0 的 5 项缺口之上，补齐"插件加装"这一产品形态（对标 `dsh plugin --profile web add <spec>`），并使套件具备可注入的 UI 皮肤：

- **插件管理 CLI**：新增 `src/plugin.ts` 与 `src/plugin-cli.ts`，`freeseek plugin add <spec> [--root <dir>]` / `remove <name>` / `list [--json]`。spec 支持三种来源：`npm:`（裸 `@scope/pkg@ver` 默认按 npm registry）经 `npm pack` → 专用缓存目录 tar 解包（用完即删）；`git:`（含 `github:user/repo` 短路径）经 `git clone --depth 1`；`file:` / 绝对路径本地目录直取。`remove` 依据 `.agent/kits.json` 注册表逆操作。
- **套件定位与落地**：下载包内按 `plugin.json` 或 `package.json` 的 `freesek.plugin` 声明定位套件根（对齐 dsh.bundle 语义）；落地复用 `installKit` / `uninstallKit`（`src/kits.ts`），把 skills / commands / agents / themes 安装到项目 `.agent/` 并登记注册表，卸载可逆。
- **套件皮肤（Themes）**：`KitManifest` 新增 `themes?: { name; file? }[]`，安装后写入 `.agent/themes/<name>.css`；`listInstalledThemes`（`src/plugin.ts`）扫描该目录供宿主下发。Web Console 与 VS Code 设置面板主题下拉动态包含已安装皮肤，`registerPluginThemes` + `applyTheme`（`body[data-theme]`）注入，纯 CSS 变量覆盖，不影响其余渲染逻辑。
- **文档**：`docs/cli.md` 增补 `plugin` 命令与 spec 语法；套件 themes 类型与皮肤注入见 `src/kits.ts` 与 `src/plugin.ts`。

# 0.25.0 — Gap Closure: TUI / ExecPolicy DSL / Remote Sandbox / Web Approval / SDK — 2026-08-24

补齐相对 codex / deepseek-harness 的 5 项可见缺口（详见 `FreeSeek-vs-codex-vs-deepseek-harness` 架构对比）：

- **缺口1 · 交互式终端（TUI）**：新增 `src/tui.ts` 全交互会话视图，对标 codex 的 TUI——实时流式渲染助手文本（按词边界 flush 防撕裂）、工具调用进度卡、状态指示器，以及键盘审批（`y`/Enter 批准、`N` 拒绝）。非 TTY（管道/CI）自动降级为朴素流式。`freeseek --tui`（仅本地命令运行用 `node dist/freeseek-headless.js --tui`）。
- **缺口2 · 声明式命令策略语言**：`src/sandbox.ts` 新增 `ExecPolicyDocument` DSL（`compileExecPolicy` / `loadExecPolicyDocument` / `applyPolicyDecision`），对标 codex execpolicy——`default` 档 + 规则集，匹配维度覆盖 cmd 字面量 / 正则 / effect 类别 / OS / 网络意图，结果档位 allow / deny / ask / sandbox / readonly。经 `--exec-policy policy.json` 注入 `run_command` 执行前评估，优先于原有正则 allow/deny。
- **缺口3 · 远程/云沙箱 provider 实装**：`src/remote-sandbox.ts` 新增三种可落地 transport（`createLocalDockerRemoteSandboxTransport` docker exec / `createSshRemoteSandboxTransport` SSH / `createE2BRemoteSandboxTransport` E2B API），取代原仅协议定义。经 `--sandbox remote:docker@<container>` / `remote:ssh@<host>` / `remote:e2b@<id>`（环境变量 `E2B_API_KEY`）通过 `seam.setCommandRunner` 注入，工具执行链路零改动。
- **缺口4 · 浏览器端交互审批与 ask_user 表单**：Web Console 的 `requestPermission` / `requestElicitation` 由 fail-closed stub 改为「经 SSE 推送到浏览器 + 等待回传」；新增 `/api/session/respond` 端点；`ui.ts` 渲染审批卡（按钮回传 decision）与按 `requestedSchema` 生成的结构化表单（字段收集回传）。`freeseek web --experimental` 即可在浏览器中完成审批与 ask_user。
- **缺口5 · 官方 TS SDK**：新增 `src/sdk.ts`（稳定再导出 `runAgent` / `ToolRegistry` / `ToolRuntime` / `builtinToolDefinitions` / 远程沙箱 provider / 策略 DSL / ACP server+client），`package.json` 增加 `exports[: "." | "./sdk" | "./acp"]` 与 `freeseek-sdk` bin；新增 `src/sdk-cli.ts` 提供 `freeseek-sdk run|acp|version` 子命令。第三方 `require("freeseek")` / `import "freeseek"` 即可调用内核。
- **修复（SDK CLI 与 headless 衔接）**：headless 原生支持 `--mode coder|plan|ask`（含 `FREESEEK_MODE` 环境变量；`plan`/`ask` 触发只读拦截，`coder` 保持 0.24 行为不变），`--tool-mode`/`--auth-type` 校验对齐；`sdk-cli.ts` 修复 `runHeadless` argv 前缀（去除 `node`/`freeseek-sdk`）与 `--cwd → --workspace` 映射，使 `freeseek-sdk run` 首次可用；`docs/sdk.md`、`docs/cli.md`、`docs/web-console.md`、`docs/remote-sandbox.md` 同步落地文档。

# 0.24.0 — Web Console Host — 2026-08-24

- **新增产品形态：Web Console**（本地回环 HTTP 服务 + 浏览器端，对标可编译后浏览器访问的本地服务形态）：
  架构与 Desktop 同构——`Browser → HTTP/SSE → WebConsoleServer → ACP client → freeseek-acp sidecar → 共享 Kernel`，
  只做协议/控制面，不复制任何 ToolRuntime/权限逻辑。入口 `freeseek web` / `freeseek-web`（默认 `127.0.0.1:3080`）。
- 浏览器端单页控制台：会话列表/新建/恢复、流式消息（SSE）、工具调用卡片、模式切换（coder/craft/plan/ask）、停止；
  所有模型与工具文本经 HTML 转义渲染，零依赖（原生 fetch + EventSource）。
- 安全默认：仅监听回环地址；随机访问令牌（`/?token=`）授权全部 `/api/*`；同源校验拒绝跨源浏览器请求（防 CSRF / DNS 重绑定）；
  未显式 `--yes` 时工具权限请求按取消处理（fail-closed）。
- `HostKind` 契约新增 `web`；宿主能力矩阵登记 Web Console（交互输入/权限审批/持久会话/富展示；无编辑器原生能力）。
- 新增 `tests/web-console.test.ts`（UI 鉴权、跨源拒绝、HTTP+SSE 真实回合、能力声明），全套通过；`npm run check` 8/8 保持。
- 文档：新增 `docs/web-console.md` 与 `docs/deployment/` 全形态部署/使用说明（CLI、ACP、VS Code、Desktop、Web Console、Eval/Bench、Core 嵌入）。

# 0.23.0 — Verification & Cross-platform Hardening — 2026-08-23

- Freeze the 0.22.0 source-stable baseline plus a verification/hardening pass into one new source baseline.
- **Fix hookify hot-reload cache race**: `loadHookifyRules` cache key now includes file size, and `toggleHookifyRule` explicitly bumps mtime after writing, so a same-size rapid toggle (`enabled:false → true`) is always observed instead of returning a stale cached rule.
- **Fix test-infrastructure layout defects (P1)**: `acp-cli-stdio`, `desktop-runtime-e2e` and `extension-management-host-wiring` now resolve compiled entries / source roots robustly across the esbuild bundle layout, the tsc-fallback mirror layout, ts-node direct runs and the production `dist/` build; `scripts/test.mjs` pre-stages the `acp-server`/`cli` CLI bundles (without the auto-run entry define) so the esbuild path is self-contained; `ChildRpc` requests now fail fast on child-process exit and time out instead of hanging forever.
- **Add missing platform gates (P3)**: ACP/Headless H4 untrusted-sandbox E2E tests and the sandbox-policy symlink-rejection test now skip (instead of failing) on platforms without Linux namespaces / symlink privilege, matching the existing `extension-sandbox` suite.
- **Fix Windows ESM import (P4)**: `desktop-portable-install` tests load `scripts/lib/desktop-portable-install.mjs` via `require` of the absolute path (tsc CJS emit rewrites dynamic `import()` to `require(file://…)`, which is invalid on Windows).
- Keep the 0.22.0 functional surface (Kernel / CLI / ACP / VS Code / Desktop / HMR H0-H4) unchanged; this release is source verification and cross-platform hardening only.

# 0.22.0-dev.4 — General HMR H4 — 2026-08-22

- Add Linux-first out-of-process execution for `trust=untrusted` Extension tools; `ExtensionRuntime` requires sandbox execution attestation and never falls back to Host-process `require()` for untrusted packages.
- Isolate workers with unprivileged user/mount/PID/IPC/UTS/network namespaces, chroot, a cleared environment and Node Permission Model; package bytes are copied to a bounded immutable snapshot and package symlinks/non-regular files fail closed.
- Add startup-only Host sandbox policy grants for filesystem roots and exact HTTP(S) origins. Untrusted code accesses them only through bounded call-bound IPC brokers, and network broker use additionally requires that exact tool's Runtime metadata declares `requiresNetwork=true`.
- Keep shell/process spawn closed in H4 v1; direct host filesystem reads, child process creation and direct network access are contained by executable isolation rather than capability metadata alone.
- Preserve generation semantics across process boundaries: watcher V1→V2 reload leaves leased V1 workers alive, failed candidates retain the old worker as LKG, and retired workers dispose after the final generation lease releases.
- Add timeout/kill, protocol-corruption and oversized-result containment plus durable sandbox lifecycle/status audit through H3 management; ACP and Headless accept the same startup-only policy, Desktop/VS Code forward explicit policy configuration without giving Renderer/plugin UI Runtime ownership.
- H4 v1 is deliberately Linux-only and Tool-only for untrusted packages; unsupported platforms, shell, and untrusted Connector/Skill/Hook/MCP/UI contributions fail closed. This is not claimed as a VM/hypervisor boundary against Node/Linux kernel vulnerabilities.
- Keep the frozen 0.21.0-rc.1 release candidate unchanged and do not create `v0.21.0`.

# 0.22.0-dev.3 — General HMR H3 — 2026-08-22

- Add a host-neutral Extension management plane with explicit `list/status/reload/remove/reconcile/config/audit` semantics; remove/disable retires runtime state and persists operator intent but never deletes package bytes or expands trust roots.
- Add durable process-level HMR audit (`runtime`/`watcher`/`management`) with bounded in-memory projection and 8 MiB file rotation, while keeping per-session generation lease/release provenance in the existing EventLog.
- Add managed health projection for `ok`, last-known-good `degraded`, `pending`, `error`, `disabled`, `conflict` and `absent`; corrupt operator intent fails closed so disabled trusted code cannot silently reactivate.
- Add FreeSeek-namespaced ACP JSON-RPC management, provider-free Headless one-shot management, Desktop operator UX through preload/main/ACP, and VS Code explicit-root management using global host state.
- Preserve H0-H2 generation leases, atomic reload/LKG rollback and explicit trust roots; H3 does not add workspace auto-scan, Renderer plugin APIs, package-byte deletion or capability widening.
- Keep H4 untrusted/model-generated out-of-process sandbox deferred and keep the frozen 0.21.0-rc.1 release candidate unchanged without creating `v0.21.0`.

# 0.22.0-dev.2 — General HMR H2 — 2026-08-22

- Add generation-snapshotted Skill roots/assets with read-only run-local SkillManager overlays, package containment/symlink checks and bounded candidate bytes; old leases keep old Skill content across reload.
- Add generation-pinned Policy and pre/post Hook contributions inside ToolRuntime with monotonic semantics: extensions may block/warn or append post-tool notes but cannot grant permission or bypass built-in deny/approval/sandbox gates.
- Add generation-owned MCP tool contribution adapters and declarative package `mcpServers`; stdio requires explicit `shell=true`, HTTP requires `network=true`, and retired connections stay alive until old generation leases release.
- Preserve H0/H1 atomic generation semantics and trusted explicit `--extension-dir` roots; package contribution failures keep last-known-good.
- Keep H2 MCP scope to tools only; cross-host management/durable operator UX remains H3 and untrusted/model-generated out-of-process sandbox remains H4.
- Keep the frozen 0.21.0-rc.1 release candidate unchanged; no `v0.21.0` Stable tag is created by the HMR line.

# 0.22.0-dev.1 — General HMR H0/H1 — 2026-08-22

- Start `dev/0.22-hmr` from the exact frozen `0.21.0-rc.1` candidate without modifying the pending 0.21 release candidate.
- Add a host-neutral Extension Runtime with generation staging, immutable Agent-run leases, retained child leases, reversible effects, dependency `PENDING`, last-known-good rollback and audit callbacks.
- Bind extension tool definitions to generation-specific executors inside `ToolRegistry`; unknown extension schemas fail closed instead of falling back to the raw tool-body dispatcher.
- Add trusted CommonJS package loading plus bounded dependency-free filesystem polling HMR, with duplicate-ID rejection, package-entry containment checks, syntax/activation rollback and lease-safe removal.
- Add explicit `--extension-dir` trust roots for ACP/Headless and one process-shared HMR runtime across ACP sessions; Desktop ACP launch options can forward the same contract.
- Keep v1 intentionally trusted-only: no automatic workspace plugin execution, host UI plugin API, untrusted/model-generated in-process execution, or 0.21 Stable promotion.

# 0.21.0-rc.1 candidate — 2026-08-22

- Freeze Desktop UI Experience Convergence U0–U5 for local/internal Stable validation.
- Typed ACP presentation cards, Trajectory Inspector, evidence-backed file diffs/deliverables, bounded long-session rendering, incremental safe Markdown and accessibility hardening are all included.
- Fix RC metadata promotion so the documented alpha/beta prerelease line can legally enter same-base `rc.1` without allowing prerelease-to-Stable shortcuts.
- Candidate source/contract validation passes 22 focused UI/release tests plus Renderer strict TypeScript; exact Windows x64 Electron/package/recovery/interop validation remains required before 0.21.0 local Stable is frozen.
- General HMR remains outside this release line.

# 0.21.0-beta.1 — Desktop UI Experience Convergence U5

- Add incremental, HTML-safe assistant Markdown rendering: stable blocks are committed once, mutable streaming tail is capped at 8K characters, and forced splits preserve fenced-code context instead of dropping code semantics.
- Batch reasoning updates per animation frame and append text nodes instead of rewriting the accumulated reasoning transcript on every chunk.
- Bound mounted long-session work with 120-entry Conversation and 160-row Trajectory windows while preserving projected models and bidirectional navigation to older entries.
- Bound trajectory search/detail, structured tool blocks and artifact diffs; full large values are serialized or mounted only after explicit expansion.
- Add keyboard/focus/ARIA hardening for tabs, trajectory rows, collapsible details and permission/elicitation dialogs, plus reduced-motion handling.
- Add U5 stress budgets for 12,000 streamed chunks, 100,000-row window math, long fenced code, huge structured values and the existing 5,000-row trajectory search regression.
- Keep Desktop UI as an ACP/Host projection: no Renderer filesystem/EventLog/ToolRuntime access, no server-side paging fiction, and no General HMR transition.

# 0.21.0-alpha.1 — Desktop UI Experience Convergence U4

- Project successful file reads and mutations as evidence-backed ACP v1 tool-call fields instead of parsing tool-result prose or crawling the workspace.
- Correlate `onFileRead` / `onFileDiff` callbacks to the executing provider `toolCallId` inside ToolRuntime, preserving correctness for parallel-safe file reads and preventing body-supplied IDs from overriding provenance.
- Persist file evidence in the existing durable EventLog and restore it during ACP `session/load`; legacy sessions without evidence remain explicitly evidence-empty.
- Add standard ACP `locations` plus structured `diff` content for create/write/edit and namespaced FreeSeek provenance for operation kind, path, line-change counts and produced-file status; empty-file creates are preserved as real deliverables.
- Keep delete evidence honest: current `delete_file` does not retain a complete arbitrary pre-delete snapshot, so Desktop shows a confirmed deletion without inventing a diff.
- Add the U4 Artifact experience: produced-file chips, per-path read/mutation grouping, structured Before/After inspection, tool navigation, and evidence links shared by Conversation and Trajectory cards.
- Keep current-file Preview/Open behind the existing Electron-main authorized-root boundary; Renderer still has no filesystem/EventLog/ToolRuntime access.
- Keep incremental Markdown, virtualization, broader large-output/performance/accessibility work in U5 and keep General HMR deferred.

# 0.21.0-dev.3 — Desktop UI Experience Convergence U3

- Add a renderer-safe Trajectory Inspector model for turn, message/reasoning, tool, mode, permission, elicitation and unknown ACP/Host lifecycle rows.
- Add semantic category filters plus tokenized search backed by a bounded cached index so long sessions remain inspectable without reading EventLog/session files from Renderer.
- Add bidirectional tool navigation: Conversation tool cards can open their Trajectory row, and Trajectory details can jump back to the projected conversation/tool target.
- Keep lifecycle evidence honest: live turns use `session/prompt` stop state; replayed history turns are labeled `history` because ACP does not expose persisted turn-end/stop metadata. Historical permission/elicitation decisions are not inferred when Host does not replay them.
- Do not introduce timestamps/durations, structured diffs/deliverables, incremental Markdown, virtualization or General HMR ahead of their protocol/milestone boundaries.
- Keep `0.20.0 Stable` frozen and preserve the Desktop → ACP → shared Kernel boundary.

# 0.21.0-dev.2 — Desktop UI Experience Convergence U2

- Add a renderer-safe Presentation Registry for terminal/execute, read, search, mutation, web/fetch, code/JSON and generic tool/output cards.
- Reuse one ACP-derived presentation model in both Conversation cards and Trajectory details so tool lifecycle semantics do not drift between panes.
- Keep mutation cards evidence-honest: U2 shows the projected request/result only; structured diffs and deliverables remain U4.
- Reserve assistant Markdown/reasoning presentation intents while leaving incremental Markdown, virtualization and accessibility/performance hardening to U5.
- Harden the Desktop development build by bundling the sandboxed renderer as an esbuild browser IIFE; General HMR remains absent.
- Keep `0.20.0 Stable` frozen; no Agent/Kernel fork, RC/Stable rerun, publishing/signing work or General HMR was introduced.

# 0.21.0-dev.1 — Desktop UI Experience Convergence U0/U1

- Freeze 0.20.0 Stable separately, then open `dev/0.21-ui`; General HMR remains deferred.
- Add a renderer-safe ACP presentation projector for assistant/reasoning/tool/mode/unknown session updates.
- Introduce a three-pane Desktop shell: Workspace/History, Conversation, and collapsible Trajectory/Artifact details.
- Reuse the same ACP projection for typed tool cards and trajectory rows; Renderer still has no direct EventLog, ToolRuntime or filesystem access.
- Add focused UI presentation contract tests and browser-bundle validation.

# 0.20.0 — 2026-08-21

- Standalone Desktop Host promoted to local/internal Stable.
- Windows x64 exact Electron 43.3.0, DPAPI, packaged E2E and forced-kill recovery validated.
- Candidate-bound ACP interoperability validated with two independent ACP clients.
- Public distribution signing intentionally deferred; no General HMR in this release.

# FreeSeek 变更日志

## 0.20.0-dev.3 — Desktop session/resume UX foundation

- Add Desktop ACP connect/list/resume lifecycle so durable sessions can be discovered by workspace and resumed without reading EventLog files directly.
- Extend the real DesktopRuntime child-process E2E to close, list, resume and continue the same session.
- Add sidebar session history/Resume controls.
- Replace browser-native `window.confirm/window.prompt` with first-class ACP permission/elicitation dialogs driven by server-provided options/schema.
- Keep real Electron BrowserWindow execution as the unchanged `alpha.1` gate.

## 0.20.0-dev.2 — Desktop runtime E2E checkpoint

- Extract `DesktopRuntimeController` so ACP child/session lifecycle is host-tested independently from Electron presentation code.
- Add a real Desktop Runtime → `freeseek-acp` child-process E2E covering initialize/new/prompt streaming/mode/list/EventLog/close.
- Fix compiled Desktop repo-root discovery and the stale `electron dist/main.js` start path.
- Add an opt-in real Electron BrowserWindow smoke runner that drives the public contextBridge API and ACP sidecar when Electron 43.3.0 is available.
- D1-A is closed; D1-B (real BrowserWindow execution) remains the `0.20.0-alpha.1` gate.

## 0.20.0-dev.1 — Standalone Desktop development baseline

- Open `dev/0.20` from the frozen 0.19.0 Cross-host Stable baseline.
- Add the first standalone Desktop Host: Electron shell, sandboxed renderer/preload boundary and ACP child-process client.
- Add a hard architecture gate preventing Desktop code from importing Agent/ToolRuntime/Tools directly.
- Add Desktop ACP protocol tests, desktop build contract and 0.20 project ledger/roadmap.
- General HMR remains deferred until Desktop Stable.


## v0.19.0 Stable（Cross-host Platform）

- **FreeSeek 正式成为多宿主 Agent 平台**：VS Code Extension、CLI/Headless、ACP v1 stdio Agent Server 共用同一 Kernel、ToolRegistry/ToolRuntime、EventLog 与安全边界。
- **ACP Stable**：生命周期、resume/cancel/mode、permission、elicitation、additionalDirectories、MCP、Skills/Multi-Agent policy 均完成跨宿主硬化。
- **独立互操作闭环**：官方 TypeScript SDK 1.3.0 + OpenClaw acpx 0.13.0 两个独立 ACP Client 已实跑通过；官方 SDK 额外覆盖 additionalDirectories 与 resume。
- **跨平台/发行闭环**：Windows checkpoint/autocrlf、symlink 权限、Node builtin bundling、stable-contract smoke、VSIX/TGZ packaging 均闭环。
- **后续顺序冻结**：0.19 Stable 后先开发 Standalone Desktop UI，再考虑 General HMR Extension Runtime。

## v0.19.0-rc.1（Cross-host RC：External ACP Interop Closed）

- **M4 闭环**：Windows beta.7 现场验证已实际跑通官方 `agentclientprotocol/typescript-sdk 1.3.0` 与 OpenClaw `acpx 0.13.0` 两个独立 ACP Client；官方 SDK 额外覆盖 `additionalDirectories` 与 `resume`。
- **发行形态已验证**：beta.7 Windows 现场的 stable-contract smoke 通过，VSIX 与 npm/CLI TGZ 均成功生成。
- **Gate 参数解析修复**：`--min-clients 2` 的 `2` 不再被误当成第三个 report path，并新增 CLI 回归测试。
- **范围冻结**：RC.1 不修改 `src/` 或 `esbuild.js`；Agent Kernel、VS Code、CLI/Headless、ACP v1 Runtime 与 beta.7 完全一致。

## v0.19.0-beta.7 candidate（Release Smoke Contract + Validation Resume Hotfix）

- **Smoke 去除私有符号耦合**：不再要求生产压缩 bundle 保留 `encodeBuffer` 等内部函数名；改为检查 package `main/bin` 映射、Node Host shebang/语法、稳定 command/view/message contract。
- **Windows beta.6 现场证据**：repository gates 8/8；production build 已成功生成 VS Code / CLI / ACP / Eval / Bench / Webview / Mermaid 全部 bundle；失败仅发生在过时 smoke 私有标记断言。
- **验证产物不再污染 Git**：`.gitignore` 固定忽略本地 validation evidence 目录/证书，续跑脚本只对白名单生成物放行，其他未提交内容仍 fail-closed。
- **Candidate restore 兼容**：恢复脚本使用 `dev/0.19` 分支直接 clone，并用 `git tag --points-at HEAD` 检查可选 tag；未打 tag 的 candidate 不再被当作错误。
- **内部复验**：`npm run check` 8/8、`npm test` 351/351、ACP conformance 15/15。等待 Windows 从现有 beta.6 工作树 fast-forward 后直接续跑 artifact smoke/package + 2-client interop。

## v0.19.0-beta.6 candidate（Production Bundle Node Builtin Hotfix）

- **Node builtin bundle 修复**：Headless 的 `readline/promises` 改为显式 `node:readline/promises`，避免 esbuild 在 Windows 生产 bundle 中把 Node 内置子路径误当第三方包解析。
- **Node Host external 策略**：Extension / CLI / ACP / Eval / Bench 的 esbuild 配置统一 externalize `node:*`，后续新增 `node:fs/promises` 等内置子路径也保持宿主运行时解析。
- **构建回归锁定**：新增 release-pipeline 测试，禁止重新引入裸 `readline/promises` 或丢失 `node:*` external。
- **Windows beta.5 现场证据**：repository gates 8/8；full regression 349 total / 0 fail（4 个平台 gated skip）；ACP conformance 15/15。唯一产品失败点为生产 build 的 `readline/promises` resolve。
- **beta.6 内部门禁**：`npm run check` 8/8、`npm test` 350/350、ACP conformance 15/15。等待同一 commit 的 Windows production build / package / 2-client interop 继续验证后再决定 tag/RC。

## v0.19.0-beta.5 candidate（Windows Cross-platform Checkpoint Hotfix）

- **Shadow checkpoint Git 配置隔离**：独立 shadow repo 显式 `core.autocrlf=false`，不再继承用户全局 Git 行尾策略，避免 Windows `rewind/materialize` 把 LF 快照改写为 CRLF。
- **Windows 回归固化**：checkpoint 测试主动模拟全局 `core.autocrlf=true`，以后 Linux CI 也能复现并阻止该类 Windows 行尾回归。
- **Symlink 权限语义**：Remote Sandbox realpath containment 在可创建 symlink/junction 的平台继续强制验证；环境返回 EPERM/EACCES/ENOTSUP 时明确 skip，而不是把系统权限限制记作产品失败。
- **现场证据**：beta.4 Windows 验证已确认 repository gates 8/8 通过；349 项回归中的 3 个失败均定位到上述跨平台问题。
- **候选门禁**：本地 `npm run check` 8/8、`npm test` 349/349、ACP conformance 15/15。等待 Windows beta.5 candidate 重跑后再创建正式 tag。

## v0.19.0-beta.4（M4/M5：Cross-host Release Hardening）

- **三宿主能力审计**：新增 `HOST_CAPABILITY_MATRIX.md` 与回归测试，锁定 VS Code、CLI、ACP、Eval 的默认/可选宿主能力，禁止静默降级。
- **ACP 生产产物门禁**：`smoke.mjs` 现在强制检查 `dist/freeseek-acp.js` 存在、尺寸与 shebang 完整性。
- **发布流程重构**：`release.mjs` 不再自行修改单一版本源；只允许对已提交、版本一致的工作树打包。
- **RC/Stable 不可绕过**：发布流水线强制全量测试、ACP conformance，并在 RC/Stable 要求两份独立 ACP Client evidence report。
- **双发行形态**：生产发布同时生成 VSIX 与 npm/CLI TGZ，并生成 SHA256SUMS。
- **当前边界**：源码门禁全绿，但本 Linux 环境只有 Windows esbuild 原生包，生产 bundle 需在匹配平台 `npm ci` 后验证；独立 ACP Client 仍 0/2，因此保持 Beta。
- **验证**：版本晋升前 `npm run check` 8/8、`npm test` 349/349；beta.4 tag 前重新执行 check/test/conformance。

## v0.19.0-beta.3（M4：独立 ACP Client 证据门禁与 Cross-host 收口）

- **独立实现硬门禁**：新增 `npm run acp:interop:gate`；RC 必须提供两个不同 `implementationOwner/implementationId` 的外部 Client 报告，且每份都证明 initialize/new/prompt/sessionUpdate。
- **高级能力证据**：两份外部证据中至少一份必须覆盖 resume / additionalDirectories / permission / elicitation / mode 等非基线能力，禁止用两个只做握手的客户端凑数。
- **外部 Client 适配器**：预置官方 `@agentclientprotocol/sdk` 与 `acpx` adapter-only driver；协议实现来自外部依赖，FreeSeek 不再自写“第二客户端”冒充互操作。
- **环境探针**：新增 `npm run acp:interop:probe`，只把真实可执行的外部客户端计入 RC；当前环境仍为 0/2，因此保持 Beta。
- **Cross-host 一致性**：系统提示词明确 VS Code、CLI/Headless、ACP Agent Server 三宿主；产品路线固定为 `0.19 Stable → Standalone Desktop UI → General HMR Runtime`。
- **验证**：`npm run check` 8/8；`npm test` 345/345；raw ACP conformance 15/15。

## v0.19.0-beta.2（M4：ACP 互操作硬化与证据框架）

- **JSON-RPC 边界硬化**：显式拒绝非法 request/response id，并覆盖 parse error、invalid request 与 EOF final-frame。
- **进程级 ACP Conformance**：新增 `npm run acp:conformance`，真实启动 FreeSeek ACP stdio Host 并验证 initialize/new/prompt/list/mode/close/resume/stdout purity 等 15 项。
- **独立客户端证据门禁**：新增 `ACP_INTEROP_MATRIX.md` 与 `npm run acp:interop` evidence wrapper；FreeSeek 自有 raw driver 明确不计入 RC 的 2-client 门禁。
- **可移植验证构建**：esbuild 原生二进制不可用时，ACP conformance 自动回退到 tsc verification build。
- **当前边界**：本环境尚无可执行的独立 ACP Client 依赖，互操作计数仍为 0/2，因此本版本保持 Beta，不晋升 RC。
- **验证**：`npm run check` 8/8；`npm test` 342/342；raw ACP conformance 15/15。

## v0.19.0-beta.1（Cross-host M3：ACP Host Parity）

- **ACP ask-user / Elicitation**：仅在 Client 协商 `elicitation.form` 后暴露 `ask_user`，并映射为 `elicitation/create` form；未协商时工具不暴露且 fail-closed。
- **多 Workspace Roots**：`additionalDirectories` 进入统一路径安全层；文件读写/删除、Glob/Search/Grep、命令/Python/Code cwd、Checkpoint 与 Hooks 都按实际授权 root 解析。
- **Resume 权限不漂移**：additional roots 规范化、去重并持久化；resume 必须重新声明相同授权集合，禁止静默扩大或替换 session 文件系统范围。
- **Session Modes**：新增 `coder/craft/plan/ask` 模式状态与 `session/set_mode`，模式持久化并在 resume 时恢复。
- **Skills / Multi-Agent Policy**：ACP Skills 可显式关闭；关闭时不仅隐藏 `load_skill`，也移除 ToolContext SkillManager 与子 Agent 技能继承。Multi-Agent 继续默认关闭、显式开启。
- **结构治理**：ACP Server 拆分 session config/parser 模块，保持单文件 600 行 hygiene 硬门禁，不增加豁免。
- **验证**：功能树在晋升前已达到 `npm run check` 8/8、`npm test` 340/340；版本晋升后重新执行完整门禁并记录于 beta.1 validation ledger。

## v0.19.0-alpha.2（Cross-host M2：ACP v1 stdio Agent Server）

- **第三正式 Host**：新增 ACP v1 stdio Agent Server，入口为 `freeseek acp` 与独立 `freeseek-acp`；stdout 严格保留给 NDJSON JSON-RPC，诊断写 stderr。
- **ACP 生命周期**：实现 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/list`、`session/resume`、`session/close`，并复用 FreeSeek durable EventLog。
- **双向交互**：Agent 流式状态通过 `session/update` 返回；高风险工具/MCP 审批通过 `session/request_permission` 交给 ACP Client 展示，最终准入仍由 ToolRuntime 决定。
- **会话级 MCP**：CLI/ACP 可各自持有独立 `McpManager`；ACP 支持 stdio MCP，允许 PATH-resolved command；多 ACP session 不再共享一个全局 MCP 生命周期。
- **敏感配置最小持久化**：ACP metadata 只保存 MCP server 名称，不落盘 command/env/secret；resume 必须由客户端重新提供并校验 server 名集合。
- **协议硬化**：标准化 unknown/busy/cursor JSON-RPC error semantics，显式 `loadSession:false`，清理 generic `$/cancel_request` 与重复 error write。
- **验证**：`npm run check` 8/8；`npm test` 336/336；独立 `freeseek-acp` 与统一 `freeseek acp` 均通过真实子进程 NDJSON/stdout-purity + Agent turn E2E。

## v0.19.0-alpha.1（Cross-host M1：CLI/Headless 能力契约与服务对齐）

- **Host Capability Contract**：Kernel 只依赖宿主能力契约，VS Code/CLI/ACP/Eval profile 位于各自 `src/hosts/*`，并加入 Kernel→Host 反向依赖门禁。
- **CLI 真实交互宿主**：新增 `--interactive` 的 ask-user 与 Runtime approval；默认非交互/CI 继续 fail-closed，`--yes` 为显式自动批准。
- **Headless MCP / Skills**：CLI 可从 `--mcp-config` 装配 stdio/http MCP 动态工具，并加载项目级、用户级与额外 skill roots。
- **Headless Multi-Agent**：新增显式 `--enable-multi-agent`；子 Agent 使用父 Agent 的动态 ToolRegistry schema snapshot，不丢失 MCP/Connector 能力。
- **MCP 路由修复**：修正 `mcp__` 前缀解析 off-by-one。
- **验证**：`npm run check` 通过；`npm test` 331/331；新增 Multi-Agent 与 MCP Headless E2E。

## v0.18.0（多宿主稳定版：Trace/Eval + Indexed Event Store + CLI/Headless）

- **DeepSeek V4 迁移**：官方 Provider 默认切换到 `https://api.deepseek.com`、`deepseek-v4-flash` / `deepseek-v4-pro`，并更新当前价格估算。
- **DeepSeek thinking tool-call 兼容**：`reasoning_content` 进入 ChatMessage、OpenAI 请求回传与 durable EventLog，避免 V4 默认思考模式在工具调用后的下一轮丢失 reasoning 上下文。
- **真实 Context A/B 安全入口**：新增 `npm run bench:deepseek-context`，默认 `v1.1 -> v1.2`、Public context、repeat=3；API key 仅从环境变量读取。
- **Content-addressed persistence**：图片/附件按 SHA-256 去重保存，EventLog 只持久化引用并校验完整性；会话删除会 GC 无引用 blob。
- **Durable lifecycle**：补齐 `turn/start|end`、`step/start|end`，异常路径也成对闭合；canonical snapshot/message 可在 session JSON 缺失时完整恢复。
- **Workspace timeline**：turn baseline、pre-edit safety checkpoint、post-mutation timeline checkpoint 与 event seq 绑定；新增历史 checkpoint 物化。
- **True fork**：EventLog fork 返回 checkpoint anchor；Headless 将历史代码物化到独立 workspace，拒绝“旧对话 + 当前代码”的不一致 fork。
- **Headless kernel**：`freeseek` CLI 复用同一 Agent/ToolRegistry/ToolRuntime/EventLog；核心路径移除加载时 VS Code runtime 依赖。
- **统一 CLI 正式化**：`freeseek run/eval/bench/doctor/sessions/replay` 形成单一终端入口；保留 0.17.x 直接 flags 与 `freeseek-eval` / `freeseek-bench` 兼容入口。
- **CLI 可观测性**：`doctor` 只报告凭据是否存在、不输出 key；`sessions/replay` 直接消费 durable byte-offset EventLog index。
- **跨平台测试**：esbuild 原生二进制不可用时测试 runner 自动 fallback 到 `tsc + node:test`。
- **Provider bugfix**：修复 OpenAI streaming tool-call 首个 `function.name` 分片重复拼接并污染 replay 的问题。
- **Indexed Event Store**：新增可重建 byte-offset sidecar，按 actor/type/seq seek；JSONL 仍是唯一 source of truth。
- **Durable trace telemetry**：模型 request/result 记录 attempt、token、latency/error；tool result 记录 duration，供离线 trace 投影。
- **Eval Harness**：新增 `freeseek-eval`，复制隔离 workspace 后复用真实 Headless Kernel，支持声明式 checks、稳定 JSON report 与 baseline delta。
- **OpenAI usage bugfix**：支持 include_usage 常见 `choices: []` 终局分片，不再丢失真实 token。
- **Remote Sandbox seam**：新增显式 remote workspace mapping + HTTP transport provider；不把本地 cwd 错当成远端路径。
- **FreeSeek Bench v1**：新增 `freeseek-bench` 与 20 个版本化公开离线编码任务（core/multifile/context/security），支持 suite fingerprint、重复运行、类别/标签过滤、加权 resolved rate、预算诊断与 baseline comparison。
- **Benchmark self-validation**：每个 pristine fixture 必须失败、public gold overlay 必须通过 verifier，防止“空题/坏题”混入持续回归；外部 suite 的 command verifier 仍需显式 opt-in。
- **Bench v2 source model**：新增 manifest-relative local source 与 immutable Git source（完整 SHA、bare cache、offline replay），禁止 branch/tag 漂移。
- **Private holdout**：新增 `init-holdout`、`visibility=private`、稳定匿名 case id、落盘 report 脱敏与默认 trace 清理；private pack 加入源码/VSIX 工程泄漏门禁。
- **Pinned real-repo v1**：新增 3 个历史真实合并 PR 任务，运行时从 base SHA 物化、gold SHA 仅用于自检，第三方源码不随 FreeSeek 重分发。
- **Host-side verifier**：新增可信 `host_node` 后置验证器，verifier 强制位于 Agent workspace 外；外部 suite 必须 `--trust-suite` 才可执行。
- **Context Planner v1/v1.1**：新增有界 Repo Map + 轻量 Symbol/Dependency 检索；v1.1 用 retrieval experiment 修正 negative-intent/ranking，默认仍为 `off`。
- **Context Presentation v1.2**：保持 v1.1 retrieval 排序不变，改为结构化 evidence + tool-discipline 呈现；新增 post-plan search/read/mutation trace，用于真实模型 v1.1→v1.2 A/B，未自动推广默认值。

## v0.17.18（聊天回复排版规范化：对齐 CodeBuddy / Claude Code）

- **段落分明**：markdown 段落间距 1px → 9px、列表项 3px、标题上下留白 16px/7px，回复不再是糊成一团的「紧凑模式」。
- **严格 GFM 分段**：关闭 `marked` 的 `breaks`（换行即 `<br>`），只有空行才分段、段内单换行折叠为空格——避免 agent 输出渲染成一串碎行；显式 `<br>` 仍保留。
- **行高与容器**：助手正文 line-height 1.5 → 1.65、气泡 padding 7/11 → 9/14；`pre-wrap` 从气泡容器收窄到流式 `.stream`（纯文本阶段），渲染后的 markdown 不再因 HTML 节点换行符产生额外空行；列表/表格/引用间距与内边距同步放开。
- **标题层级**：h1-h6 字号梯度 18/16/14.5/13.5/13/12.5px + 加粗，长回复有清晰结构锚点。
- **工具卡片间距**：工具/任务清单/通知卡与正文间距 1-2px → 6-8px。

## v0.17.17（可逆套件安装 · 技能工具声明 · 从 Cordis 论文汲取可组合性）

> 依据《A Programming Paradigm for Spatiotemporal Composability》（DeepSeek-AI × 北大，deepseek-harness 底层 Cordis v4 设计论文）做内容层扩展机制改进，不碰内核。

- **可逆效应 → 套件安装-卸载闭环**：`installKit` 返回实际落位文件清单并登记 `.agent/kits.json` 注册表；新增 `uninstallKit` 逆操作，依据注册表删除套件安装的文件。路径逃逸防护：仅删 `.agent/` 内文件，杜绝越界删用户自建文件。新增命令「管理已装套件」（侧边栏 + 顶部工具下拉入口），可查看文件清单/卸载。
- **反应式共效应 → 依赖声明与能力校验**：套件 `plugin.json` 支持 `requires`，安装时校验缺失依赖（告警不阻塞）并报告同名覆盖；技能 frontmatter 支持 `tools` 声明，`load_skill` 加载时校验工具可用性（缺失提示不阻塞，加载时审查），技能索引展示所需工具。
- **内置技能（agency-agents 衍生）+3 工具声明**：backend-architect / data-engineer / appsec-engineer 声明所需工具，走能力校验。
- **测试**：新增 kits 可逆安装/注册表/路径逃逸/依赖告警 5 例 + skills tools 声明 2 例，共 228 例全绿。
- **项目管理**：project-template AGENTS.md 同步套件可逆安装与 tools 声明说明。

## v0.17.16（任务分解修复：提示词硬约束 + todo 分解 nudge）

- **提示词硬约束**：`WORKFLOW_GUIDANCE` / `CODER_MODE_GUIDANCE` 明确多步骤/多文件任务必须先调用 `todo_write` 分解为 ≥2 个可执行的具体步骤，**禁止把整条用户需求作为单一任务项**（解决任务面板一直显示整条需求的问题）。
- **todo 分解 nudge 兜底**：`agent.ts` 检测到任务面板仍只有单条「进行中」种子任务（模型未主动分解）且已执行 ≥2 步工具调用时，注入推动消息让模型调用 `todo_write` 补充分解，限次 1 次（对标 la

## v0.17.15（修复：用户新消息后右侧对话跳转导航不刷新）

- **修复**：`send()` 与定时注入（`user_injected`）渲染用户消息后缺少 `renderNavRail()` 调用，导致新输入/注入的消息在右侧对话跳转栏不出现跳转圆点。两处路径补齐刷新调用。

## v0.17.14（修复：分级压缩破坏工具配对导致 400 · 过早压缩）

- **修复 400**：`tieredCompact` 按年龄切段可能把 `assistant(tool_calls)` 摘要掉、留下孤立 `tool` 消息（无前置 tool_calls），服务端报 "role 'tool' must be a response to a preceding message with 'tool_calls'"。新增 `context.saniti

## v0.17.13（命令执行 seam · 冗余清理与结构规范）

- **能力 seam 落地**（对标 deepseek-harness capability seam）：新增 `src/seam.ts`——`CommandRunner` 接口 + `LocalCommandRunner`（默认本地多层沙箱执行）+ 可替换注册表（getCommandRunner / setCommandRunner / resetCommandRunner）；`run_command` / `run_code` 经 seam 消费，未来可无感切换远程/容器执行、dry-run、审计包装器。
- **冗余清理**：根目录发布产物 vsix 归拢 `releases/`，`_tmp_*` 临时残留清除。
- **逻辑优化**：`exec_code.ts` 两处输出截断收敛到 `agent-utils.truncatePreview`；`activate.ts` 定时任务类型复用 `scheduler.ScheduleSpec`（消除手写重复联合类型）。
- **结构规范**：AGENTS.md 仓库概览登记能力 seam 与共享基础模块（frontmatter / similarity / agent-utils / builtin-skills）。

## v0.17.12（借鉴 QwenWork 四项能力 · 执行策略与权限收敛 · 内置角色扩充）

- **Hooks 外部命令**（对标 QwenWork hooks）：hookify 新增 `action: command`，命中规则时执行外部命令（stdin 传事件 JSON），退出码 0=成功/2=阻塞/其他=警告；由 `freesek.allowCommandHooks`（默认关）门控。
- **专家套件**（对标 QwenWork 专家套件）：新增 `src/kits.ts`（plugin.json 清单 + installKit 落位 .agent/skills|commands|agents）+ 命令「安装专家套件」。
- **定时任务**（对标 QwenWork 定时任务）：新增 `src/scheduler.ts`（interval / daily 计划 + Scheduler 管理 API）+ 命令「添加/管理定时任务」，到点触发完整 Agent 会话。
- **记忆生命周期治理**（对标 QwenWork 意识）：记忆条目结构化解析、相似去重、按条数淘汰、单文件治理与备份。
- **执行策略单一真相源**：ExecPolicy 接入 run_command / run_code / 会话沙箱；权限规则改为随 ToolContext 传递（子代理继承），消除散落的 settings 直读与 planSandbox 组合。
- **内置子代理角色 +5**：code_reviewer / minimal_change_engineer / codebase_onboarding / git_workflow_master / prompt_engineer（对齐 agency-agents），并附批量导入脚本 `scripts/import-agency-agents.mjs`。
- **结构规范**：frontmatter 解析收敛到 `src/frontmatter.ts`、相似度收敛到 `src/similarity.ts`；内置技能拆分 `builtin-skills.ts`。

## v0.17.11（采纳对比报告 P0 建议：执行策略层 + 缓存友好 + 技能清单 schema）

> 依据 `AI编码工程对比与FreeSeek借鉴差距.md` 的 P0 低成本高收益项落地（P1/P2 重架构项本次不做，理由见说明）。

### 1. P0-② 执行策略层（对标 Codex core/execpolicy）
- `src/sandbox.ts` 新增 `ExecPolicy` 聚合类型 + `resolveExecPolicy(cfg)`：把原本散落在扩展各处的执行相关开关（sandboxMode / sandboxFailIfUnavailable / network / allowShell / allowDenyRules / scanFileContent）收敛为单一结构化、可审计、已填默认值的策略对象。命令执行前统一消费这份策略（单一真相源），而非各处再读 VS Code settings。sandbox.ts 保持零 vscode 依赖，函数接收「已取出的配置片段」。
- 配套单测：`tests/sandbox.test.ts` 加 `resolveExecPolicy` 2 例（最小输入填默认、部分覆盖生效）。

### 2. P0-③ 上下文缓存友好约束（对标 Codex core/context 增量构建避免 cache miss）
- `src/promptFragments.ts` 文件头与组装器注释补「缓存友好纪律」：核心片段（core/time/rules/tools）顺序必须稳定且在最前作为前缀，动态片段（memory/skills/mcp/goal）置后；禁止为每次调用动态重排核心片段；时间片段只做轻量替换；被截断/丢弃仅影响尾部可变区，不改变前缀稳定性。保证 prompt 前缀可命中 provider 的 prompt-cache。

### 3. P0-① 技能清单 schema（对标 claude-code .claude-plugin/marketplace.json）
- `src/skills.ts` 的 `SkillEntry` 新增发布清单元数据字段（version/author/category/source）；`BUILTIN_SKILLS` 6 个内置技能补全 marketplace 元数据（author=freeseek、source=builtin、version=1.0.0、category 按 workflow/review/refactor/explore 归类）；`SkillManager` 构造器合并这些字段。当前仅作轻量登记，不引入完整安装机制（跨项目安装留作后续）。
- 配套单测：`tests/skills.test.ts` 加「内置技能带 marketplace 清单元数据」断言。

### 未采纳项（说明）
- P1（fs/shell/sandbox 的 provider seam 重构、三域事件 + 会话日志运行时不变式）：属重架构，易引入回归，与 FreeSeek 单包窄边界定位不符，按 AGENTS.md「禁止整文件盲改」分期推进。
- P2（codex 式 host/runtime 边界分离、跨端）：与当前单包 VS Code 扩展定位冲突，可缓。

## v0.17.10（对话等待队列 + 冗余代码去重统一）

### 1. 新增：对话执行时输入加入等待队列（对齐 CodeBuddy「等待序列」）
- 用户反馈希望像 CodeBuddy 那样：Agent 正在回复/执行工具时，可继续在输入框打字，新输入不丢、不干扰当前轮，本轮结束自动作为下一条消息发送。
- 后端（`src/extension.ts`）：`ChatViewProvider` 新增 `pendingUserQueue` 与 `running` 标志；`case "user"` 区分状态——运行中则入队并下发 `queue_state`，空闲则立即处理；`handleUser` 的 `finally` 在每个回合出口（done/stopped/error）统一消费队首并递归驱动，串联成连续对话；`newChat`/切会话时清空队列防跨会话串台。
- 前端（`src/webview/main.ts` + `src/webview/html.ts`）：运行时不再 `disabled` 输入框，改为切换占位符提示「回复进行中，可继续输入以加入等待队列…」；`send()` 在 `streaming` 时入队而非 `return`；新增 `queue_state` 消息处理与 `renderQueueBadge()` 角标（`等待队列 ×N`，蓝底徽章），后端权威长度校正前端预览。对齐 CodeBuddy 的 runtime-drop 体验。

### 2. 冗余代码去重与统一（参照 deepseek-harness / codex / claude-code 模块化）
- `escapeRegExp` 去重：`src/skills.ts` 删除私有副本，复用 `src/tools/fs_utils.ts` 的导出（单一出处）。
- 工具输出截断统一收口：`src/agent-utils.ts` 新增常量 `TOOL_OUTPUT_PREVIEW_CAP = 8000`，供 `exec_code.ts` / `web.ts` 的「单次执行输出封顶」与事件日志引用，消除散落裸数字；原 200K 的 `truncateToolResult` 仍作为回灌上下文层兜底，二者层级（执行层 / 回灌层）不冲突。
- 补齐 mcp 工具路径的统一截断：内置工具结果在 `agent.ts` 出口经 `truncateToolResult`，但此前 mcp 内联路径绕过了该兜底；现 mcp 结果同样经 `truncateToolResult`，所有工具输出收敛到同一截断策略。
- 配套单测：`tests/agent-utils.test.ts` 加 `TOOL_OUTPUT_PREVIEW_CAP` 断言。

## v0.17.9（对齐成熟项目补齐两处性能/可靠性护栏）

- 在对照 Codex CLI（`output-truncation` 模块 / `withTimeout` 注入 `truncation_policy`）与 Claude Code（`maxResultSizeChars`、`CLAUDE_STREAM_IDLE_TIMEOUT_MS`）成熟实现后，补齐此前遗漏的两项工程层护栏：
  - **统一工具结果截断层（对齐 Codex output-truncation / Claude Code maxResultSizeChars）**：`agent-utils.ts` 新增 `truncateToolResult`（硬上限 200K 字符，超长保留首尾并标注省略量），串在 `agent.ts` 调用 `maybeOffload` 之后作为与 offload 解耦的兜底。即便未配置 offloadDir，超长工具输出也不会直接撑爆上下文预算（性能/可靠性）。
  - **流空闲看门狗（对齐 Claude Code CLAUDE_STREAM_IDLE_TIMEOUT_MS）**：`provider.ts` 新增 `streamChatWithIdleTimeout`（默认 90s），模型开始流式响应后若超过阈值仍未吐出任何增量 token（服务假死/网络挂起/推理卡死），主动 abort 本次请求并抛 `StreamIdleTimeoutError`，交由主循环重试逻辑兜底，避免整轮对话永久 hang。每次文本/思维链增量都会重置计时器，只关心"是否还在输出"。
  - 配套单测：`tests/agent-utils.test.ts` 新增 `truncateToolResult` 4 例（原样/临界/折叠中间/自定义阈值）；`tests/provider.test.ts` 新增 idle 看门狗 3 例（正常放行/假死中断抛错/外部 abort 不误报）。`npm test` 全绿，`npm run check` 三道门禁通过。

## v0.17.8（工程层 anti-early-stop：对齐 Claude Code 主循环纪律）

- 查证 Claude Code 与 Codex CLI 成熟实现后补齐工程层机制（v0.17.7 仅加了提示词/技能软约束）：
  - **lazy-nudge（对齐 Claude Code `needsFollowUp` 决策树）**：`agent.ts` 主循环在「模型无 tool_use 退出」分支，若回复几乎完全由 checkbox/待办清单构成、缺乏结论（即截图场景"只返回任务清单"），则注入推动消息再跑一轮，迫使模型基于已读文件直接输出结构化总结；限次 1 次，硬上限 maxSteps / 墙钟仍兜底，避免被异常模型拖入死循环。
  - 新增 `looksLikeTaskListOnly` 判定（≥3 行且 ≥80% 为列表项、且无「总结/技术栈/入口」等总结性标记才命中），并配套 3 个单测验证命中/不误伤/边界。

## v0.17.7（修复"了解文件夹"回答不完整：新增 explore-project 技能）

- **修复"了解当前文件夹功能"回答不完整**：用户反馈模型只读了一个文件就返回任务清单、没有给出项目总结。
  - 在 `SYSTEM_PROMPT` 新增强制约束：探索/总结类任务必须读完 README、package.json、核心入口后输出「功能定位、技术栈、主要模块、入口与使用方式」的结构化总结，**绝不能只返回任务清单**。
  - 在 `WORKFLOW_GUIDANCE` 强调：`todo_write` 只是计划清单，不是最终答案；所有步骤完成后必须给出结构化结论，禁止仅以任务清单结束对话。
  - 新增内置技能 `explore-project`（`src/skills.ts`），触发词覆盖"了解文件夹"、"项目功能"、"介绍一下这个项目"等。SOP 明确列出必做步骤与输出格式，防止模型偷懒。
  - 新增 `tests/skills.test.ts` 3 个回归用例，验证技能存在、SOP 关键要求、以及 prompt 约束。

## v0.17.6（抗攻击加固：路径逃逸 / 命令注入 / 巨文件 OOM / 死循环）

- **修复符号链接路径逃逸（安全/高危）**：`resolveSafe`（`src/tools/fs_utils.ts`）原仅做字符串级 `..` 越界检查，模型可借软链接把工作区内的链接指向工作区外（如 `ln -s ~/.ssh id_rsa_link` 后 `read_file id_rsa_link`）读凭据。现追加 `realpathSync` 真实路径校验，软链解析后仍须位于工作区内，否则拒绝。
- **修复 `run_code` Windows 命令注入（安全/高危）**：`exec_code.ts` 原把用户代码拼入 `powershell -Command "..."` 仅转义双引号，模型代码中的反引号 `` ` `` 与子表达式 `$(...)` 可逃逸引号边界执行任意命令。现改为把代码写入临时 `.ps1` 再用 `powershell -File` 执行，代码体不再进入命令行解析。
- **加固重复工具死循环检测（可靠性）**：`agent.ts` 原用「参数 JSON 完全相等」判定重复，模型微调空白/注释/字段顺序即可绕过空转到步数/墙钟上限。现引入 `normalizeArgsKey`（递归排序 key + 去空白/注释归一化），并对「同工具连续 3 次且结果无变化」也判定卡死，强制换思路。
- **加固 grep 单文件上限（性能/可靠性）**：`grepWalk` 原 `readFileSync` 整读每个文件，GB 级日志/二进制会 OOM 或卡死主线程。现超过 8MB 的文件跳过并标注，提示用 `read_file` 指定范围。
- **加固 read_file 巨文件 OOM（性能/可靠性）**：`read_file` 原 `readFileSync` 整读进内存，超大文件撑爆内存。现超过 16MB 直接拒绝整读，引导用 `offset/limit` 分块或专用工具。
- 新增 `tests/attack.test.ts`（8 个攻击用例）覆盖上述路径逃逸、grep/read 上限、参数归一化，作为回归护栏；`npm test` 133 例全绿，`npm run check` 三道门禁通过。

## v0.17.5（系统提示词防泄露）

- **新增系统提示词保密规则**：追加 `SYSTEM_PROMPT_PROTECTION`，强制模型在用户要求"给出/复述/翻译/解释/总结"系统提示词时只回答「抱歉，我无法分享系统提示词」，然后继续帮助用户处理原本任务。覆盖完整模式与闲聊模式，防御 System Prompt Extraction / 提示注入套取内部指令。

## v0.17.4（模型添加兜底 · DeepSeek 测试连接修复）

- **模型添加兜底**：「添加模型」弹窗在「获取模型 / 测试连接」失败时不再卡死，改为显示「手动填写模型名」输入框（如 NUAA 等只暴露 `/v1/chat/completions`、不暴露 `/v1/models` 的网关），保存时优先使用手填模型名，让此类服务可正常添加。
- **DeepSeek 官方「测试连接」修复**：前端「添加提供商」DeepSeek 预设 baseUrl 由 `https://api.deepseek.com` 改为 `https://api.deepseek.com/v1`；`probeModelList` 的 test 模式放宽重试——401 仍立即定论（路径对、Key 错），其余非 2xx 一律尝试下一个候选路径，避免被提前截断漏掉正确的 `/v1/models`。
- **`release.mjs` 修复**：`vsce package` 补 `--baseContentUrl`，发布流程不再因 README 相对链接校验报错而中断。
- 新增 `tests/probe.test.ts`（4 个单测）覆盖路径拼接与重试行为。

## v0.17.3（修复 DeepSeek 官方「测试连接」联不通）

- **修复前端 DeepSeek 预设 baseUrl**：「添加提供商」弹窗的 DeepSeek 预设 baseUrl 由 `https://api.deepseek.com` 改为 `https://api.deepseek.com/v1`，与后端 `addProvider` 向导一致（原漏 `/v1` 导致拼接候选路径错误）。
- **放宽测试连接重试逻辑**：`probeModelList` 的 `test` 模式下，401 仍立即定论（路径对、Key 错），但其余非 2xx 一律尝试下一个候选路径（不再仅限 404），避免首个候选返回 405/400 等被提前截断而漏掉正确的 `/v1/models`。
- 新增 `tests/probe.test.ts`（4 个单测）覆盖上述路径拼接与重试行为。

## v0.17.2（UI 优化 · 浏览器 Dev Harness）

- **浏览器 Dev Harness**：新增 `src/webview/bridge.ts`（HostBridge + createBridge，隔离 `acquireVsCodeApi`）与 `scripts/webview-dev.mjs`（`npm run dev:webview`，:5173 提供空面板与 `?scenario=events-*.jsonl` 回放），可在浏览器中直接查看/调试 webview UI，无需启动 VS Code。
- **欢迎页重构**：卡片式欢迎界面，渐变背景 + 主题建议标签 + 快捷键提示；空状态 `showWelcome` 现在会在 `#welcome` 为空时正确填充。
- **对话消息去重**：连续同角色消息合并渲染，多段内容以空行连接，减少碎片。
- **工具调用卡片**：默认折叠 `<details>`，降低长输出时的视觉噪声。
- **图片消息占位**：空文本（仅图片）消息显示「（图片消息）」占位。

## v0.17.0（工程化：门禁 · 单测 · 发布 · 模块拆分）

- **工程门禁 `npm run check`**（对齐 deepseek-harness typecheck/lint/hygiene 多门禁）：① typecheck（src 树 0 错误）② hygiene 行数上限（默认 600，超限文件头 `// check:max-lines N` 登记技术债并限期拆分）③ 导出 JSDoc 覆盖检查。
- **单测基础设施 `npm test`**（对齐 deepseek-harness 五层测试、codex 快照测试）：esbuild bundle `tests/*.test.ts` → `node:test` 执行，零新依赖。纯逻辑模块（goal/jobs/eventlog/context 等）首批单测落地。
- **一键发布 `npm run release`**（对齐 codex 发布脚本化）：门禁 → 版本 bump → 生产构建 → vsce 打包 → vsix 归拢 `releases/` → 自动追加 `CHANGELOG.md`。
- **模块拆分**：`extension.ts` 拆出 `freeserver.ts`（免费服务管理）与 `storage.ts`（路径/索引/会话持久化），主文件体量下降（3587 → 3310 行）。
- **UI 设计 token**：webview `:root` 建立语义色 token（`--fs-accent/ok/warn/err/fg-muted/border/bg-*`，映射 VS Code 主题变量），统一替换散落硬编码色（对齐 codex styles.md 语义色规范）；前端动态渲染改用 `var(--fs-ok)/var(--fs-err)`。
- **任务 / 文件列表面板实装**（此前为"样子货"，始终空白）：任务清单自动从用户消息派生「进行中」任务并实时推送，回合结束自动收尾为「已完成」（模型调用 `todo_write` 时以其规划为准）；文件列表新增读取（`read_file`）与删除（`delete_file`）痕迹跟踪，按 `+N/-N`、`已读 N 次`、`-N 行` 区分展示。
- **「当前目标」常驻面板**：接入此前只发不收的 `goal` 消息，新增 `renderGoalPanel` 与 goal 侧栏面板，阶段徽章（进行中/已暂停/受阻/已完成）全部使用 `--fs-*` 语义色；webview 初始化与新会话时主动下发持久化目标。
- **eventlog 会话标题投影**：`projectSessionTitle()` 从首条用户消息派生标题写入 `session_title` 事件（每会话仅投影一次，审计轨迹稳定），回放/排查可直接读"会话在做什么"。
- **继续模块拆分**：`getHtml`（约 700 行 HTML 模板）机械拆分到 `src/webview/html.ts`，`extension.ts` 从 3310 行降至约 2726 行，`// check:max-lines` 豁免随之下降（3400 → 2800）。
- **发布管线实测**：`npm run release` 全流程跑通（门禁→构建→vsce 打包→归拢 `releases/`），并修复两处发布卫生问题——`spawnSync(shell:true)` 的 Node DEP0190 弃用告警（改引号化单命令）、VSIX 混入 `_tmp_*`/`_verify_*`/`tests/` 等调试产物（补 `.vscodeignore` 规则）；`CHANGELOG.md` 新条目插入位置修复（不再顶到 `#` 标题上方）。
- **工程规范落地**：新增 `.gitignore`（vsix/dist/releases/tests 产物归拢）、AGENTS.md 新增「工程门禁」章节、JSDoc 强制、模块拆分契约（豁免即债务，拆分后必须收敛）。
- **README 新增「安装方式」章节**：Marketplace / VSIX / 源码三种安装路径。

## v0.16.4（目标状态机 goal · 后台任务管理 jobs）

- **目标状态机 goal**（吸收 deepseek-harness `goal` 子包，零依赖）：新增 `goal` 工具支持 create/edit/pause/resume/complete/block/clear 七种操作，`goal_view` 随时查看。与 `todo_write` 互补：todo 记「怎么做」（步骤清单），goal 记「为什么做」（当前目标 + 状态机）。
  - **轮次预算防绕圈**：`max_rounds` 设上限，active 目标每工具轮自动推进轮次计数，超预算在 `goal_view`/系统提示词中给出收敛提醒。
  - **跨压缩锚定主线**：上下文压缩的 `preCompactHook` 优先锚定 goal objective（较"最近一条 user 消息"启发式更稳）。
  - **跨会话续行**：目标持久化到 `.agent/.goal.json`，恢复历史会话时系统自动注入「当前目标」，模型续行而非重新问用户。
- **后台任务管理 jobs**（吸收 deepseek-harness `jobs` 子包）：`run_in_background` 启动的子智能体自动登记到统一注册表，新增 `job_list`（状态/标签/起止时间）、`job_output`（读取已收集输出）、`job_kill`（终止并抑制完成通知）三个工具，告别"只能等通知"的被动局面。
- 主循环每工具轮向 webview 回传目标视图（`type: "goal"`），前端可据此展示当前目标。

## v0.16.3（子代理 Description 自动路由 · skills 自动加载 · .codebuddy 兼容 · 恢复会话命令）

- **子代理 Description 自动路由**（对齐 CodeBuddy Subagents）：`RolePreset` 新增 `description` 字段，内置 explore/plan/verify/general 均补描述；主系统提示词注入「可用子代理清单（名字+描述+只读/可执行）」，让主 Agent 主动判断何时派发哪个子代理。
- **skills 自动加载**（对齐 CodeBuddy 子代理 `skills` 字段）：角色文件 / 角色预设可声明 `skills: [...]`，子代理启动时自动把对应技能全文拼进 system body，开箱即掌握 SOP。优先级 agent frontmatter > role 预设。
- **兼容 `.codebuddy/agents/`**：子代理角色文件既可从 FreeSeek 原生 `.agent/agents/` 读取，也可从 CodeBuddy 约定的 `.codebuddy/agents/` 读取（后者优先）。
- **`spawn_agent`/`spawn_agents` 的 role 放开为自由字符串**：不再写死内置四角色 enum，用户自定义角色也能通过合法参数路由派发。
- **恢复历史会话命令**：新增 `FreeSeek: 恢复历史会话`（`freesek.resumeSession`），列出全部非归档会话供选择恢复（对齐 Codex/Claude Code 的会话恢复语义）。
- 代码质量：提取共享 `EXEC_TOOLS` 常量、合并重复 import、`resumeSession` 改为有限轮询等。

## v0.16.2（checkpoint/rewind 升级为可回溯时间线）

- **checkpoint 支持命名**：`checkpoint({ name })` 以 `freesek-cp:<name>` 标识创建检查点，不填自动生成。
- **rewind 可回滚到任意历史点**：`rewind({ name })` 恢复指定命名检查点并截断其后所有更晚检查点（时间线截断）；不填则回滚到最近一次。告别原"只能 git stash pop 最近一次"的单层限制。
- **新增 `list_checkpoints`**：列出工作区全部 freesek 检查点时间线（自动检查点 + 命名检查点），供 rewind 选择目标点。
- 对标 Claude Code 的 Checkpoint/rewind 能力，全部基于原生 git stash，零新增依赖。

## v0.16.1（A2A 互通信 · MCP 知识库检索 · run_python · 文件编码探测/冲突检测 · 对话跳转）

- **A2A 子智能体互通信**：子智能体之间现在可以互相发消息（不再只有主→子单向）。`send_message` 支持子→子寻址续跑，`busyAgents` 集防止递归自触发。内置 4 个角色（explore/plan/verify/general）与默认子智能体白名单均已开放 `send_message`，多智能体协作编排更灵活。
- **MCP 接外部知识库**：FreeSeek 仅做工具接线、不内置知识库。连接 MCP server 后，若其暴露检索类工具（名称匹配 `search|query|retriev|kb|knowledge|find|lookup|semantic|vector|rag`），自动暴露统一检索入口 `mcp_list_kb`（列出可检索来源）+ `mcp_kb_search`（按 query 检索，多键名参数 `query/limit/max/top_k/q` 兼容），系统提示词注入知识库来源清单。
- **run_python 工具**：专用 Python 执行器，运行前自动注入 `matplotlib` Agg 后端（无界面也能出图）；自动选用 `python3`/`python`；带超时与 32MB 输出上限、stdout 截断 8000 字符。脚本生成的 PNG 自动收集并以 base64 回传，在聊天中直接渲染为图表（对标数据分析场景）。需在设置开启 `freesek.allowShell` 才可用。
- **文件工具缺口补齐**：
  - **编码探测**：`read_file` / `write_file` / `edit_file` 自动探测编码（BOM 优先 → 严格 UTF-8 → iconv-lite 回退 `gb18030`/`big5`/`shift_jis`/`euc-kr`），写回时按原编码保留，避免 GBK/UTF-16/BOM 文件被误转。
  - **外部修改冲突检测**：引入文件指纹（mtime+si

## v0.16.0（修复会话重命名/删除 + 归档功能）

- **修复重命名/删除不生效**：webview 沙箱禁用 `window.prompt`/`window.confirm` 导致弹窗弹不出、操作失效。改为自定义输入框/确认框（`promptInput`/`confirmAction`）。
- **新增归档功能**：侧边栏「🗄 归档」可查看已归档会话，支持恢复/删除；归档会话从主列表/最近 Tab/历史搜索中隐藏。
- 归档状态持久化（`SessionMeta.archived`）。
- **修复换模型下拉被遮挡**：`#topbar` 的 `overflow-x:auto` 会裁剪向下弹出的模型下拉，移除后下拉正常显示（窄屏滚动由会话 Tab 自身承接）。
- **修复技能删除确认框**：`window.confirm` 在 webview 沙箱禁用导致失效，改用自定义 `confirmAction`。
- **模型下拉主动拉取**：点击 modelChip 时向后端请求最新模型选项（含自动发现的模型）再打开菜单。
- **指令审核（执行前确认）**：Agent 调用 `slash_command` 执行自定义 .md 命令前，弹窗让用户审核确认后再执行（命令可能含危险操作）。
- **添加提供商改为弹窗表单**：对齐 CodeBuddy，在 webview 内弹单个表单 modal（预设服务商下拉 + Base URL + API Key + 模型 + 工具模式 + 保存），一个弹窗填完并提交，替代一步步输入。

## v0.15.9（参照 CodeBuddy 完善添加模型向导）

- **预设服务商一键选择**：「添加提供商」向导第一步可选 10 个常见服务商预设（DeepSeek / OpenRouter / 硅基流动 / Kimi / 通义 / 智谱 / 腾讯混元 / OpenAI / Ollama / LM Studio），自动填充 Base URL / 协议格式 / 认证方式 / 模型；仅「自定义」才手动填写。Ollama/LM Studio 预设自动启用模型发现。
- **API Key 预填 `${env:}` 引用**：选预设后 Key 输入框自动填入对应的环境变量引用。
- **保存后连通性测试**：参照 CodeBuddy「保存，测试连通」，添加后自动调用 `/models` 探测服务可达性与鉴权有效性并反馈结果。

## v0.15.8（腾讯云接入 + 窄屏适配 + LM Studio 自动发现）

- **腾讯云混元接入**：内置 `tencent-hunyuan` 预设（OpenAI 兼容，`https://api.hunyuan.cloud.tencent.com/v1`），含 `hunyuan-turbo`/`hunyuan-pro`/`hunyuan-standard` 模型。
- **LM Studio / Ollama 自动发现模型**：`autoDiscoverModels: true` 时自动拉取 `/v1/models` 全部模型，切换模型时实时刷新。
- **窄侧边栏适配**：顶栏宽度过窄时自动切紧凑模式（按钮只留图标）+ 横向滚动兜底，按键不再被遮挡。

## v0.15.7（五维质量修复 + 测试场景手册）

- **可靠**：修复 abort 竞态（新建/切换会话后旧请求不再误判 error）。
- **性能**：`unifiedDiff` LCS 阈值降至 1M 行（大文件 diff 防主线程卡顿）；会话落盘改为异步串行写队列（index/session/transcript 不再同步阻塞）。
- **安全**：`verify`/`delete_file` 纳入统一 Plan/只读守卫；`web_fetch`/HTTP 连接器加内网地址拦截（防 SSRF）；MCP resources/prompts 走用户审批；子代理继承 MCP 审批回调。
- **文档**：新增 `TEST_SCENARIOS.md`（五维测试场景与回归基线）。
- **功能**：LM Studio / Ollama 本地服务支持 **自动发现模型**（`autoDiscoverModels: true`），自动拉取 `/v1/models` 的全部已加载模型，切换模型时实时刷新——不再只能手动写死一个 7b 模型。

## v0.15.6（MCP 资源/提示词 + Agent 并行 + 会话 Tab）

- **MCP resources / prompts 支持**（对齐 Claude Code / CodeBuddy MCP 扩展）：连接时发现并展示 resources/prompts，新增 `mcp_read_resource` / `mcp_get_prompt` 工具，系统提示词注入可用资源/提示词清单。
- **Agent 并行协调**：新增 `spawn_agents` 工具，用 `Promise.all` 并行运行多个独立子智能体（可配合 worktree 隔离并行改不同模块），合并返回各子任务结论。已有 `spawn_agent` 保持不变。
- **会话 Tab 快速切换**：顶栏新增最近会话 Tab 栏，点击即可在多个会话间快速切换（复用现有会话存储）。

## v0.15.5（产物预览：Mermaid 图表渲染）

- **Mermaid 图表渲染**（对齐 CodeBuddy 4.9.12）：代码块 ```` ```mermaid ```` 懒加载 `dist/mermaid.js` 并渲染为 SVG 图表（不进主 bundle，首屏不受影响）。支持流程图/时序图/甘特图等。

## v0.15.4（产物预览：CSV/TSV 表格）

- **CSV/TSV 表格预览**（对齐 CodeBuddy 4.6.4）：代码块 ```` ```csv ```` / ```` ```tsv ```` 自动解析并渲染为可读的 HTML 表格（支持引号包裹字段），保留复制原始数据按钮。

## v0.15.3（借鉴 CodeBuddy：Slash 增强 + MCP 审批 + 自定义 Agent）

- **Slash 指令增强**：新增 `/summari

## v0.15.2（联网检索 + PaperSeek 学术检索）

- **联网检索工具**：新增 `web_search`（搜索引擎返回标题/链接/摘要）与 `web_fetch`（抓取网页转文本），解决"查文档/查 API 用法/查报错含义"的联网刚需。
- **PaperSeek 学术检索连接器**：内置 `conn__paper_seek__search`，用自然语言检索论文（OpenAlex/arXiv/Semantic Scholar/PubMed 等），返回标题/作者/年份/引用数/摘要；支持 MCP 方式接入。
- 更新记录新增联网与学术检索能力。

## v0.15.1（连接器插件 + 内置技能模板 + MCP 管理）

- **连接器插件机制**：新增 `src/connectors.ts` 抽象（registerConnector / dispatchConnectorTool），第三方可注册外部服务工具（`conn__<id>__<tool>`），内置通用 HTTP 请求连接器。
- **内置技能模板库**：随扩展内置 `commit-push-pr` / `code-review` / `refactor-to-composable` 三个开箱即用的 SOP 技能（只读，可复制定制）。
- **技能系统强化**：内置模板在技能管理面板标"内置模板（只读）"；技能管理对内置模板做只读保护（不可改状态/删除，不参与去重）。
- **MCP 管理面板**：设置面板新增"🔌 MCP 服务管理"（server 连接状态/传输/工具清单 + 重新连接），新增命令 `FreeSeek: 管理 MCP 服务`。
- **run_command 交互支持**：新增 `input` 参数注入 stdin（应对交互式确认）。

## v0.15.0（多协议 AI 接入 + 质量门禁 + 技能进化闭环）

- **各种 AI 接入**：Provider 抽象层支持 `openai` / `claude` / `gemini` 三种协议格式，自动构造对应端点、认证头（Bearer / x-api-key / x-goog-api-key）与流式解析；支持自定义请求头（`headers`，含 `${env:}` 插值）与额外请求体透传（`extraBody`）。「添加提供商」向导新增协议格式选择。
- **质量门禁（verify）**：新增 `verify` 工具自动运行 typecheck/lint/test 并按「文件:行」定位失败；`freesek.autoVerify`（默认开）驱动「写→跑→修」闭环。
- **计划审批状态机**：Plan Mode 升级为「计划 → 结构化审批 → 执行」；`ask_user` 支持结构化多选项（对齐 Interactive Questions）。
- **技能进化闭环**：会话后自动沉淀可复用技能（pending 待审核）→ 设置面板技能管理（激活/停用/删除/去重合并）→ `promote_skill` 经 `verify` 验证后自动激活。
- **上下文增强**：`@` 提及文件直接注入内容（对标 Claude Code @file）；支持多模态图片输入（支持视觉的模型）。
- **可观测性**：会话审计展示输入/输出 token 与工具调用次数。

## v0.14.0（界面重构 + 对话内 diff 控制）

- **UI 全面重构**：Webview 拆分为组件模块（state/markdown/components），整体视觉对齐 Claude Code / Codex。
- **富文本 markdown**：改用 marked + DOMPurify 渲染（标题 / 列表 / 表格 / 链接 / 引用 / 公式代码块），修复 XSS 风险，链接点击后用系统浏览器打开。
- **代码块增强**：每个代码块带语言标签 + 一键复制按钮；思考过程（reasoning）改为可折叠的「💭 思考过程」块。
- **模型下拉菜单**：顶栏模型 chip 改为内置下拉（多提供商分组 + 当前项勾选 + 添加/编辑提供商入口），不再依赖原生 QuickPick。
- **对话内 diff 应用/回滚**（对标 Codex）：每次 write_file / edit_file 产生的修改卡片带「✓ 接受 / ↩ 回滚」按钮；回滚仅当文件未被后续修改覆盖时执行，恢复为修改前内容（新建文件则删除），并自动刷新已打开的编辑器。
- **会话树分组**：侧栏历史会话按「今天 / 昨天 / 近 7 天 / 月份」分组展示。
- **停止不再报错**：点击「停止」后以友好状态提示，不再弹出错误气泡。
- **CSP 加固**：webview 增加 Content-Security-Policy（nonce 脚本 + 资源白名单）。
- 欢迎页新增快捷任务建议（解释项目 / 找 bug / 补测试 / 代码审查）。


## Context Planner v1.1 (experiment-driven)

- Added deterministic `freeseek-bench context-retrieval` probes and Hit@K/MRR failure attribution before model-level A/B.
- Added experimental `contextPlanner=v1.1`, retaining the v1 index while correcting negative-intent/test/docs/example ranking.
- Generalized `ab-context` with `--baseline-planner` / `--candidate-planner` so v1 → v1.1 can be evaluated on Public/Private/Real suites.
- Default remains `off`; v1.1 promotion requires real-model non-regression evidence.

## 0.22.0-rc.1 — Source release freeze (2026-08-22)

- Freeze General HMR H0-H4 together with the completed Desktop UI convergence baseline for unified 0.22 release consolidation.
- RC source line contains the shared Kernel plus CLI/Headless, ACP, VS Code and Desktop hosts; HMR remains one platform runtime, not a host-specific fork.
- Full dependency-backed build/test and native artifact certification remain required before an immutable public `v0.22.0` release tag.

## 0.22.0 — Local/Internal Source Stable (2026-08-22)

- Freeze unified FreeSeek Core + CLI/Headless + ACP + VS Code + Desktop source with General HMR H0-H4.
- HMR remains a platform Extension Runtime shared by all hosts; Desktop continues to use ACP rather than a second Agent implementation.
- Add stable source deployment/use/security/support-matrix documentation under `docs/stable/0.22.0/`.
- Public/native artifact certification and immutable `v0.22.0` tag remain pending the repository release contract; this source freeze does not fabricate those results.
