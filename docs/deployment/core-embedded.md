# Core（嵌入）— 部署与使用说明

> Core 不是单独的第二套产品进程，而是所有宿主共用的 Agent/Kernel。核心不变量：
> `ToolRegistry → ToolRuntime → EventLog`；宿主**不得绕过 ToolRuntime 直接执行 raw tool body**（`npm run check` 硬性扫描）。

## 部署（二次开发 / 自建宿主）

```bash
git clone <source> && cd freeseek
npm ci
npm run check              # 工程门禁（改动后必跑）
npm test                   # 单测
npm run compile
```

建议先 `npm run project:status` 查看项目状态。

## 嵌入原则

- **Agent run 在开始时获取 Extension generation lease**；运行中不热改 ToolRegistry。
- 文件/网络/shell 权限继续由 ToolRuntime 与 Host policy 控制；新宿主不得自行放宽。
- durable session 用 EventLog；不要由 UI 自建第二套事实来源。
- Desktop/Web Console 等壳必须经 ACP 使用共享 Kernel，不得直接 import Agent/ToolRuntime。
- 新增内置工具必须同时登记 `src/tools/defs.ts`（模型 schema）与 `src/tool-runtime-spec.ts`
  （effect/approval/concurrency/capability/timeout）。

## 宿主能力契约

新宿主在 `src/hosts/<name>/capabilities.ts` 用 `defineHostCapabilities({...})` 显式声明能力
（见 `src/kernel/host-capabilities.ts` 的 `HostKind`）。Web Console 即按此契约登记（`kind: "web"`）。

## 测试与门禁

- `npm run check`：typecheck（src/tests）、hygiene 行数、Runtime/Registry boundary、benchmark boundary、host boundary、version coherence。
- `npm test`：`node:test` 零依赖；esbuild 主路径（含 CLI 入口预置）+ tsc-fallback 回退。
- 改动核心逻辑（context/trimUnfinishedTurn/工具回灌）后，建议用真实 provider 冒烟。