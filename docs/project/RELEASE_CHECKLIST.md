# FreeSeek Release Checklist

## Dev / Alpha

- [ ] `package.json` 与 project-state 版本一致
- [ ] `npm run check`
- [ ] `npm test`
- [ ] 新增/修改能力有对应测试
- [ ] 未绕过 ToolRuntime / EventLog
- [ ] 更新 `changes/unreleased/`
- [ ] 更新 PROJECT_LEDGER 风险与里程碑状态

## Beta

除以上项目外：

- [ ] 目标功能 freeze
- [ ] VS Code / CLI / ACP capability matrix 审计
- [ ] session resume/cancel/permission 回归
- [ ] Public + Private Holdout + Real Repo Bench 无阻塞退化

## RC

除以上项目外：

- [ ] 只接受 blocker 修复
- [ ] P4 必需平台输入已可获得；不要为了“先有 RC 号”在证据仍不可执行时提前改版本
- [ ] `npm run desktop:rc:prepare -- --version X.Y.Z-rc.N` dry-run 通过并人工审查；显式 `--apply` 后四个版本源同步，且候选 metadata commit 尚未打 tag
- [ ] 候选后任何 blocker 修复都视为新 commit，必须重新生成所有 commit-bound RC evidence
- [ ] 构建全部发行形态
- [ ] 安装/启动 smoke
- [ ] ACP 协议 conformance 进程测试通过
- [ ] 至少两个**独立实现**的 ACP Client 实际完成 initialize/new/prompt；FreeSeek 自有 raw driver 不计数
- [ ] 至少一个独立 Client 覆盖 resume/permission/elicitation/mode/additionalDirectories 中的一项
- [ ] `npm run acp:interop:gate -- <report-a> <report-b> --expected-version <version> --expected-commit <40-hex>` 通过（两种独立实现 + 至少一项高级能力，且绑定当前候选）
- [ ] 协议互操作证据写入 `docs/project/ACP_INTEROP_MATRIX.md`
- [ ] 安全边界回归
- [ ] Desktop 最终制品逐 target 绑定 exact Electron stage manifest（版本/pin/target 一致）
- [ ] 每个 target 先用 `desktop:native:preflight` 从官方 Electron archive + 官方 `SHASUMS256.txt` 验证/解压 exact pin；不得直接信任手工解压目录
- [ ] Electron dev + packaged smoke 使用 exact pin、无 mismatch waiver、无 `--no-sandbox` RC 豁免；packaged 证据为 `app.isPackaged=true` 且绑定当前候选 commit
- [ ] 每个 release target 实测 secureStorage；`basic_text` 不计为 RC 安全存储证据
- [ ] 生成并审计 Desktop signing policy：Linux=Ed25519 public-key SHA-256、Windows=Authenticode certificate SHA-256、macOS=Apple Team ID + notarization required；policy 文件不包含私钥
- [ ] `npm run desktop:release:evidence -- ... --signing-policy <policy.json>` 在 clean committed worktree 上生成 `SHA256SUMS.txt` + `freesek-desktop-provenance.json`，并绑定 signing-policy SHA-256/size/policyId
- [ ] `npm run desktop:update:manifest -- ...` 从上述 provenance 生成 schema v2 update manifest
- [ ] `npm run desktop:update:sign -- ...` 使用仓库外 Ed25519 key 签署 exact manifest bytes
- [ ] 每个 target 从 productized exact-Electron stage 在对应原生 OS 生成最终 native portable artifact：Linux `.tar.gz`、Windows/macOS `.zip`
- [ ] 每个 target 用 `desktop:installer:evidence:native` 从最终 artifact 实跑 fresh install → uninstall → upgrade → rollback，并留存 `nativePlatformVerified=true`、installed stage/executable digest
- [ ] 每个 target 留存平台指定的签名验证证据：Windows=`authenticode`、macOS=`apple-codesign`、Linux=`ed25519-update-manifest`；macOS 还必须有 notarization 证据（Windows/macOS native collectors implemented；仍需在对应 OS 实跑）
- [ ] Linux target 使用 `npm run desktop:signing:evidence:linux -- ... --signing-policy <policy.json>` 验证 exact Ed25519 manifest signature → provenance → artifact digest 链，并要求实际 public-key 指纹等于 release policy
- [ ] 每个 target 通过 `desktop:native:package` 留存签名后 packaged+secureStorage smoke 与真实 packaged 强杀/同 session recovery evidence
- [ ] 每个 target 通过 `desktop:native:evidence` 生成 canonical native evidence bundle，包含 signing + fresh install + uninstall + upgrade + rollback 证据
- [ ] `npm run desktop:rc:evidence:gate -- ...` 返回 `passed=true` 且 `rcEligible=true`
- [ ] 生成 SHA256SUMS

## Stable

- [ ] `npm run desktop:stable:prepare -- --version X.Y.Z --rc-summary <audited-rc.json>` dry-run 通过；只有显式 `--apply` 才同步 Stable metadata，且不自动 commit/tag
- [ ] 已存在直接前序、已审计的 `0.20.0-rc.N`，其 `desktop:rc:evidence:gate` 结果为 `passed=true`、`rcEligible=true`、`preflightOnly=false`
- [ ] Stable exact commit 上重新生成 aggregate preflight，并重新取得 candidate-bound 两独立 ACP Client evidence
- [ ] RC→Stable 之间 Electron pin、Desktop signing policy identity/SHA-256、release target 集合完全不变；若变化则返回 RC 流程
- [ ] 每个 target 使用正式 native installer evidence 证明 `fromVersion=<audited RC>` 且 fresh install → uninstall → upgrade → rollback 全部成功
- [ ] `npm run desktop:stable:evidence:gate -- --rc-summary <rc.json> --stable-preflight <stable-preflight.json> --installer-report <target.json>...` 返回 `passed=true` 且 `stableEligible=true`
- [ ] RC 阻塞项为 0
- [ ] 合并到 `main`
- [ ] 创建不可移动 tag `vX.Y.Z`
- [ ] 归档 `changes/unreleased` 到 CHANGELOG
- [ ] project-state 的 stableBaseline 更新为新版本
