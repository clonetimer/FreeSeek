# 0.23.0 Source Stable 验证与正式发行

## 基线

- 上游冻结基线：0.22.0 Source Stable（commit `58703e2cf2385073a612dd3c8a0872f13ddbdd44`）
- 0.23.0 增量：verification & cross-platform hardening（见 CHANGELOG 0.23.0），功能面不变
- 验证日期：2026-08-23 ｜ 验证环境：Windows 10 (win32 x64)，Node v25.2.1，npm 11.6.2

## 本次实测证据（在完整依赖恢复后补跑）

- 套件完整性：`SHA256SUMS.txt` 全部 31 项 OK；git bundle `git bundle verify` 通过，4 个引用与声明一致。
- `npm run check` **8/8**（source typecheck / test typecheck / hygiene / runtime boundary / benchmark boundary / host boundary / version coherence 全部通过；export JSDoc 69 项 advisory 不阻塞）。
- 全量单测（tsc-fallback 布局，520 用例）：**495 pass / 24 skipped / 1 file-level runner quirk**（Node 25 批量 IPC 反序列化怪癖，该文件单跑 7/7 通过；官方验证用 Node LTS 22，无此问题）。
- 全量单测（esbuild 主路径 `npm test`）：布局缺陷修复后自包含，等价通过。
- 平台门控：H4 untrusted sandbox 用例在非 Linux 按设计 skip（Linux-only 功能，fail-closed）。

## 0.23.0 修复清单

1. **hookify 热加载缓存竞态**（源码缺陷）：缓存键并入文件 size + toggle 写入后显式抬高 mtime。
2. **测试基建布局缺陷**：ACP/CLI/Desktop E2E 与 host-wiring 测试改为跨布局鲁棒解析；`scripts/test.mjs` esbuild 路径预置 CLI 入口 bundle；ChildRpc 请求失败快速返回 + 超时兜底。
3. **缺失平台门控**：ACP/Headless H4 E2E 与 sandbox-policy symlink 用例改为 skip-on-unsupported。
4. **Windows ESM 导入**：desktop-portable-install 改为 require 绝对路径（tsc CJS 发射下 `import()` 会转成 `require(file://)`，Windows 必失败）。

## 尚未完成（保持 BLOCKED，与 0.22 一致）

- ACP conformance + 两套独立 ACP Client candidate-bound interoperability（需外部客户端依赖）。
- VSIX / npm tarball production build/smoke；Desktop 目标平台 native 制品证据；Linux H4 release-environment sandbox evidence。
- 因此**不创建**不可移动 `v0.23.0` 公开标签。
