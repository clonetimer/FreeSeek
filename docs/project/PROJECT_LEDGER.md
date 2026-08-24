
### Windows dev.3 native baseline evidence (2026-08-21)

Operator-returned Windows x64 evidence on `a9ffa1221211dc70524b14fba7087159659fc79e` passed exact Electron 43.3.0 official-archive verification, DPAPI secure storage, development and real packaged E2E, first-RC non-release baseline packaging, and forced-kill same-session recovery. Runtime regression reported 443 tests / 435 pass / 0 fail / 8 platform skips. A test-only TypeScript narrowing issue found in the same bundle was corrected before RC metadata promotion. The Windows machine had no usable CurrentUser Authenticode code-signing certificate, so final release signing remains an external blocker. See `VALIDATION_0_20_DEV3_WINDOWS_NATIVE_A9FFA12.md`.

# FreeSeek 项目台账

> 机器可读单一状态源：`docs/project/project-state.json`。本文件用于解释版本主线、里程碑、验证事实与风险。

## 1. 当前主线

- 最新稳定版：**0.19.0 Cross-host Stable**，tag `v0.19.0`，冻结。
- 当前开发线：**0.20.x — Standalone Desktop UI**。
- 历史可验证 prerelease 基线仍是 `v0.20.0-dev.3` / `f0428e6`；交接中缺失的 alpha/beta 历史未伪造。
- 恢复后的真实 Git 锚点已连续建立：`ac6ed1d`（beta.3 candidate + D4 recovery）、`1f499ea`（credential minimization）、`052d221`（productized portable）、`c5a6285`（release evidence）、`fb735a0`（provenance-bound signed update）、`edb69ab`（guarded rollback journal）、`97d5c36`（candidate-bound RC evidence gate）、`ce5d678`（portable install rollback preflight）、`886a724`（platform-specific signing evidence）、`0352db7`（signing evidence provenance binding）、`c67c7d2`（release signer identity policy binding）、`cc99623`（installed payload ↔ stage evidence binding）`693a7b6`（native signing collectors）以及当前 native portable installer adapter 收口批次。
- 当前开发状态收敛为 **Desktop Stable code-complete / native-evidence-pending**：P1–P6 所需的发布、回滚、候选/Stable metadata、native evidence 与 aggregate gate 代码均已实现；剩余工作是 exact Electron 43.3.0、Windows/macOS/Linux 原生执行、真实 signer/account 和最终候选 ACP 双客户端证据。证据未齐，因此仍不创建 RC tag。
- 集成分支：`dev/0.20`；`main` 只保留 Stable。
- General HMR Extension Runtime 明确继续后置到 Desktop Stable 之后。
- 用户提供的 DeepSeek-Harness UI 已作为 post-0.20 交互参考审计：后续优先吸收 typed output、trajectory、tool/file-change inspection 等信息架构，但不把其 Agent/HMR/runtime 复制进 Desktop；详见 `UI_REFERENCE_DEEPSEEK_HARNESS.md`。

## 2. 产品结构

| Surface | 状态 | 角色 |
| --- | --- | --- |
| VS Code Extension | Stable | 编辑器内旗舰客户端 |
| CLI / Headless | Stable | 终端、CI、自动化 |
| ACP Agent Server | Stable + 0.20 host extensions | 跨编辑器/跨客户端协议边界；复用同一 Kernel |
| Standalone Desktop | **Code complete / native evidence pending** | 独立 ACP 客户端/宿主，不包含第二套 Agent |
| Web Console | Planned | 后续远程控制面 |
| General HMR Runtime | Deferred | Desktop Stable 之后 |

## 3. 0.20 里程碑

### D0 — Desktop architecture / governance
状态：**Done — 0.20.0-dev.1**

- Desktop HostCapability 与依赖方向门禁已建立；
- Desktop 禁止直接依赖 Agent/ToolRuntime/Tools；
- 运行链固定为 `Renderer -> IPC -> DesktopRuntime -> ACP sidecar -> shared Kernel`。

### D1 — Electron shell + ACP bridge
状态：**Done（按交接恢复；当前环境待重跑 BrowserWindow 证据）**

- Electron main/preload/renderer、workspace/provider bootstrap、new/prompt/cancel/mode、permission/elicitation 已恢复；
- DesktopRuntime → real ACP child Agent-turn E2E 已纳入测试；
- BrowserWindow smoke 脚本仍保留真实 Electron 运行门禁，不用静态测试替代。

### D2 — Session UX
状态：**Done（按交接恢复）**

- `session/resume` 仅恢复上下文；`session/load` 恢复并经 ACP `session/update` 回放历史；
- history/list/search、close、structured reasoning/tool/result presentation 已恢复；
- Desktop 不直接读取 EventLog；
- fork 未为了 Desktop 私自实现，仍服从 ACP 能力成熟度。

### D3 — Desktop feature parity
状态：**Done（beta.1/beta.2/beta.3 candidate 能力已恢复）**

- settings/provider、MCP、Skills、additional roots、optional multi-agent controls；
- root-constrained artifact preview/open，`diffReview` 不作虚假能力声明；
- `safeStorage` provider secret、packaged ACP sidecar、manual crash recovery、signed-update verifier foundation。

### D4 — Packaging / security
状态：**Code complete / native evidence pending**

本轮已完成/加固：

- Provider API Key 从 ACP child argv 移除，沿已有 `FREESEEK_API_KEY` child env 合同注入；
- main process 不再长期保留含 Key 的 start request；
- privileged IPC 必须来自当前唯一 BrowserWindow 且 URL 精确等于 Desktop entry；
- CSP、navigation、preload 边界专项测试；
- update channel binding、唯一 platform/arch artifact、anti-rollback/equivocation、streaming SHA-256；
- dev build 与 production build 分离；Desktop production build只构建实际所需 ACP sidecar，不再依赖 VS Code Webview/Mermaid bundle；
- native esbuild CLI recovery path 可在 JS API 缺失时生成真实 production ACP bundle，watch/HMR 仍不走该 fallback；
- Electron portable staging 内嵌唯一 ACP sidecar、产品化可执行文件并生成关键文件 SHA-256 manifest；
- staging/smoke 默认强制 Electron runtime 与 Desktop pin 精确一致，mismatch 只能显式作为 compatibility preflight；
- Linux staged executable 已真实跑通 `app.isPackaged=true`，且没有 repo root / ACP entry override；
- signed update manifest schema v2 现在必须绑定 release provenance 的 HTTPS URL / SHA-256 / size；完整候选验证严格按 `signature -> provenance -> target -> artifact` 顺序完成，只有全部通过后才允许更新 high-water；
- `desktop:update:manifest` 从 clean release provenance 生成 v2 manifest，`desktop:update:sign` 仅用 Ed25519 对精确 manifest bytes 签名；生产私钥保管/轮换仍是发布流程责任，不存入仓库；
- 平台中立 update install journal 已实现 `staged -> installing -> awaiting-health -> confirmed` 与强制 `rollback-required -> rolled-back`，损坏 journal fail-closed；它不执行平台 installer，自动安装仍未开启；
- external ACP interop report 已绑定 FreeSeek version + exact Git commit；最终 RC 必须在同一候选 commit 上重跑两个独立 Client；
- RC evidence aggregate gate 以 release provenance 为中心锚点，统一检查 exact Electron、`app.isPackaged=true`、secureStorage、installer fresh/upgrade/rollback、签名/notarization、candidate-bound ACP interop 与 artifact/provenance 一致性；开发态 `--allow-non-rc` 只能做 preflight，永远输出 `rcEligible=false`；
- threat model：`docs/project/DESKTOP_THREAT_MODEL_0_20.md`；执行计划：`docs/project/DEVELOPMENT_PLAN_0_20_D4_TO_STABLE.md`；portable 验证记录：`docs/project/VALIDATION_0_20_D4_PORTABLE_COMPAT.md`。

当前验证：

- `npm run check`: **8/8 PASS**；
- `npm test`: **441/441 PASS**；
- fresh Desktop production build: **PASS**（锁定 native esbuild 0.21.5）；
- ACP raw conformance: **16/16 PASS**（`esbuild-production-bundle`）；
- Electron 43.2.0 dev BrowserWindow compatibility E2E: **PASS**（显式 mismatch waiver）；
- Electron 43.2.0 productized portable E2E: **PASS**, `app.isPackaged=true`（显式 mismatch waiver，非 RC）。
- Windows x64 / macOS arm64 portable productization layout: **static staging PASS**（非实机启动/签名证据）；
- Desktop release checksum/provenance gate: **implemented + tested**，默认要求 clean worktree、唯一 platform/arch、exact Electron pin stage manifest、非 symlink regular artifact；
- signed update manifest v2 + provenance verifier/publication scripts: **implemented + tested**；
- guarded update install/rollback journal: **implemented + tested**（平台 installer 尚未接入）；
- candidate-bound RC evidence aggregate gate: **implemented + tested**（当前 dev.3 仅允许 preflight，不具备 RC eligibility）。
- portable installer preflight: **implemented + tested**；会校验 exact-Electron stage/关键文件摘要并真实执行 fresh install → upgrade → rollback，但证据类型明确为 preflight，RC aggregate gate 不接受它替代最终平台 installer 证据；
- native portable distribution adapter: **implemented + tested**；0.20 固定 Linux=`.tar.gz`、Windows/macOS=`.zip`，由对应原生 OS 从 productized exact-Electron stage 打包。正式 `desktop:installer:evidence:native` 从最终 provenance-bound artifact 本身解包并执行 fresh install → uninstall → upgrade → rollback，重新测量 `installedStageManifestSha256` 与 `installedExecutableSha256`；不接受任意 installer shell command。RC gate 要求固定 `installerKind` + `nativePlatformVerified=true` + uninstall evidence，因此旧 preflight 不能冒充正式证据。Linux adapter 已在当前环境端到端执行；Windows/macOS 仍需原生 OS 实跑。
- portable uninstall primitive: **implemented + tested**；卸载前必须验证 install state 与 current/previous payload，采用同文件系统 rename 事务移走 slots/state；payload 被篡改时 fail-closed，不会删除状态掩盖损坏。
- platform-specific signing evidence contract: **implemented + tested**；RC gate 现在强制 Windows=`authenticode`、macOS=`apple-codesign`、Linux=`ed25519-update-manifest`。Linux verifier 会真实校验 Ed25519 signature → provenance bytes → exact artifact digest/size 链；RC aggregate gate 还强制 signing evidence 的 `provenanceSha256` 精确匹配当前审核的 release provenance，避免跨 provenance 拼接。`c67c7d2` 进一步要求 release provenance SHA-256 绑定一份显式 Desktop signing policy，并逐 target 校验 Linux Ed25519 公钥指纹、Windows Authenticode 证书指纹或 macOS Apple Team ID；合法但未授权的 signer 不能通过 RC gate。最终 RC artifact、生产 signer identity/policy 实值与 key custody 仍未执行。
- installed payload ↔ stage binding: **implemented + tested**；portable payload 内嵌与 root 完全一致的 stage manifest，fresh install / upgrade / rollback 后从真实安装目录重新测量；RC installer evidence 的 `installedStageManifestSha256` 必须等于 provenance 中对应 artifact 的 `stageManifestSha256`。
- Windows/macOS native signing collectors: **implemented + tested as collectors, native evidence pending**；Windows 仅允许原生 Windows 调 `Get-AuthenticodeSignature`，macOS 仅允许原生 macOS 调 `codesign` + `stapler` + `spctl`。collector 记录 `signedExecutableSha256`，RC gate 对 Windows/macOS 强制它与 installer 从真实安装结果测得的 `installedExecutableSha256` 一致。
- Desktop Stable promotion gate: **implemented + tested**；`desktop:stable:evidence:gate` 只接受已经 `rcEligible=true` 的直接 `0.20.0-rc.N` 审计摘要，再要求 Stable 候选在自身 exact commit 上重新通过 aggregate preflight、candidate-bound ACP interop，以及每个 target 从该已审计 RC 到 Stable 的 native fresh install + uninstall + upgrade + rollback。RC 后若 Electron pin、signing policy 或 release target 集合发生变化，Stable 晋级会 fail-closed，必须重新发布 RC。
- RC candidate metadata preparation: **implemented + tested, not executed**；`desktop:rc:prepare` 默认 dry-run，要求 clean committed worktree + active branch + 未占用 immutable tag，只允许 `dev.N -> rc.1` 或 `rc.N -> rc.N+1`，显式 `--apply` 才同步 root package/package-lock/Desktop package/project-state 版本，而且不会自动 commit/tag。旧 `scripts/release.mjs` 的 RC/Stable ACP interop 入口也已强制绑定 exact package version + HEAD commit。
- native validation workflow: **implemented + tested**；`desktop:native:preflight` 从官方 Electron archive + `SHASUMS256.txt` 开始，完成 production build、exact dev/package/secureStorage smoke；`desktop:native:package` 在签名身份预检后重新跑签名后的 packaged smoke 与 forced-kill recovery，再生成 final portable artifact；`desktop:native:evidence` 统一生成 canonical native evidence bundle，RC gate 可直接通过 `--native-target-bundle` 消费，减少跨候选/跨 target 手工拼接错误。
- first Desktop RC baseline workflow: **implemented + guarded**；`desktop:native:installer:baseline` 只允许 clean committed pre-RC/pre-Stable tree，必须绑定 official-Electron native preflight，并明确输出 `releaseEvidenceEligible=false`，仅作为第一次 RC upgrade/rollback 的 previous artifact。
- Stable metadata preparation: **implemented + tested, not executed**；`desktop:stable:prepare` 只允许 audited/tagged direct `rc.N -> same-base Stable`，要求 RC tag 精确指向当前 HEAD 且 rc-summary 为该 HEAD 的 `rcEligible=true` 证据；默认 dry-run，显式 `--apply` 才同步四个版本源，从不自动 commit/tag。
- native operator runbook + signing custody/rotation procedure: `DESKTOP_NATIVE_VALIDATION_RUNBOOK.md` / `DESKTOP_SIGNING_OPERATIONS.md`；本地验证不需要修改源码或手写 evidence JSON。

仍需 RC 证据：

- Electron 43.3.0 BrowserWindow + packaged portable `app.isPackaged=true` smoke（不允许 mismatch waiver）；
- Windows/macOS/Linux 对最终候选制品的真实打包与启动；
- Windows/macOS OS-protected secret success path，以及受支持 Linux secure backend 的真实 secureStorage 证据；
- 0.20 安装格式/adapter 已固定为 native portable archive（Linux `.tar.gz`、Windows/macOS `.zip`）；仍需在最终候选 artifact 上分别取得 Windows/macOS/Linux 原生 fresh-install / upgrade / forced-rollback 正式 evidence。
- Windows Authenticode 与 macOS codesign + notarization 的真实平台验证；native collector 已实现且禁止跨平台伪造，但仍必须在对应真实 OS 执行。Linux 已有 Ed25519 manifest/provenance/artifact 验证器，但最终 RC artifact 签名证据与生产 Ed25519 key 的保管/轮换流程仍需执行；
- final Desktop release evidence generator 已实现：最终制品 SHA256SUMS + Git commit/provenance + exact stage-manifest/Electron pin 绑定；最终 RC 制品尚待 43.3.0 与跨平台实物执行；
- 两个独立 ACP Client 必须在 exact final candidate commit/version 上重跑并通过 candidate-bound gate；
- 以上真实证据齐备后，aggregate gate 必须返回 `passed=true` 且 `rcEligible=true`。

### D5 — 0.20 Stable
状态：**Code complete / execution pending audited RC + native evidence**。

`desktop:stable:evidence:gate` 已实现并测试，但 D5 仍未开始：必须先存在一个真正通过 `rcEligible=true` 的已审计 `0.20.0-rc.N`。Stable 晋级要求同一 Electron pin / signing policy / target set，并在 Stable exact commit 上重新取得 aggregate preflight、ACP interop 和逐 target RC→Stable install/uninstall/upgrade/rollback 证据；不会用当前 dev/Linux 单元测试替代跨平台 Stable 证据。

## 4. 当前风险

| ID | 风险 | 当前控制 / 状态 |
| --- | --- | --- |
| D-R01 | Desktop 复制 Agent/Runtime | 8/8 host boundary 硬门禁；Desktop 只走 ACP |
| D-R02 | Renderer 提权/XSS 后滥用 IPC | sandbox + contextIsolation + no Node + exact entry navigation + exact IPC sender/URL |
| D-R03 | Provider 密钥泄漏 | safeStorage main-only；settings 脱敏；child argv 无 Key；Linux insecure backend fail-closed |
| D-R04 | 打包后依赖 system Node/错误 sidecar | packaged path 固定 `resources/freeseek/sidecar`，Electron-as-Node；portable stage 校验 critical manifest |
| D-R05 | 更新回滚/替换 | provenance-bound Ed25519 signed manifest v2 + HTTPS + channel + high-water + exact target/artifact digest；guarded rollback journal + candidate-bound RC aggregate gate；平台 installer/自动安装尚未开启 |
| D-R06 | 恢复逻辑绕过 EventLog/Kernel | minimal marker + manual `session/load`；Desktop 不读 EventLog |
| D-R07 | 提前引入 HMR 造成主线漂移 | 明确 deferred until Desktop Stable |
| D-R08 | 恢复历史被误写成真实 Git 历史 | 不伪造缺失 alpha/beta commit/tag；采用后续 recovery/catch-up commit |

## 5. 版本纪律

目标仍是 `dev -> alpha -> beta -> rc -> 0.20.0`。当前恢复工作不会伪造交接中缺失的历史 prerelease tag；
新的 Git 提交应明确标识为 recovery/catch-up。任何 RC/Stable tag 必须绑定当前真实代码树和可复现验证证据。
