# 升级指南：0.22 Source Stable → 0.23

0.23 在 0.22 冻结基线之上仅做验证与跨平台加固，**功能面（Kernel / CLI / ACP / VS Code / Desktop / HMR H0-H4）不变**，无配置格式变更。

## 变更影响面

- `src/hookify.ts`：热加载缓存键并入 size、toggle 写入后抬高 mtime——行为兼容（仅修复同毫秒快速切换的陈旧状态），无需迁移配置。
- `scripts/test.mjs`：esbuild 路径会向 `tests/src/` 预置 CLI 入口 bundle——仅影响测试基建。
- 测试：4 个测试文件改为跨布局鲁棒解析；3 个 H4/沙箱用例在非 Linux 平台改为 skip。均为测试层改动。

## 配置原则（沿用 0.22）

- 原有 Provider、session、skills、MCP 配置继续使用各 Host 既有入口。
- General HMR 默认不会扫描工作区；需要显式配置 Extension root。
- 未配置 H4 policy 时，untrusted Tool 的 filesystem/network capability fail-closed。
- Windows/macOS 上 H4 untrusted sandbox fail-closed；trusted HMR H0-H3 不因此关闭。

## 回滚

生产环境应保留上一 Stable 的源码/制品和 session 数据备份。Extension package reload 有 generation-level LKG rollback，但它不等价于整个 FreeSeek 产品安装回滚。
