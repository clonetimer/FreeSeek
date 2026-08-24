# 0.22.0 Source Stable 验证与正式发行

## 已冻结的功能证据

来自 0.22.0-dev.4 exact checkpoint：

- H0-H4 combined：111/111 PASS
- H4 sandbox：16/16 PASS
- Host wiring：3/3 PASS
- Desktop security：26/26 PASS
- Desktop strict TypeScript（可用全局 TS 5.8.3）：PASS
- repository check 3-7/8：PASS

0.22 RC/Stable 源码只做版本/文档冻结，没有修改功能代码。

## 当前环境阻塞

当前容器无项目 pinned `node_modules` 且 npm registry 不可达。因此不能在此 exact source-stable commit 上重新执行：

- pinned source/test typecheck
- `npm test`
- production build
- VSIX/npm package smoke
- Desktop native packaging/smoke/secureStorage/install/upgrade/rollback

## 正式 `v0.22.0` 前必须补齐

1. `npm ci`、`npm run check`、`npm test`。
2. ACP conformance + 两套独立 ACP Client candidate-bound interoperability。
3. VSIX 与 npm tarball production build/smoke。
4. Desktop 目标平台 packaged/native evidence。
5. Linux H4 release-environment sandbox evidence。
6. 所有结果绑定同一 Stable candidate commit；随后才创建不可移动 `v0.22.0` tag。
