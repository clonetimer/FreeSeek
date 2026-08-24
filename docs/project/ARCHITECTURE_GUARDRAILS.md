# FreeSeek 多宿主架构边界

## 目标目录

```text
src/
├─ kernel/             # 宿主无关 contract / orchestration / shared services
├─ hosts/
│  ├─ vscode/          # VS Code adapter
│  ├─ cli/             # terminal/headless adapter
│  └─ acp/             # ACP protocol adapter
├─ webview/            # VS Code Webview UI（未来可抽共享 UI primitives，但不是 Kernel）
└─ <legacy flat modules>
```

0.19 不做一次性“大搬家”。旧模块在稳定门禁保护下 **on-touch migration**：被实质修改的宿主代码优先迁入 `src/hosts/*`，真正通用的新 contract 放 `src/kernel/*`。

## 硬边界

1. `src/kernel/**` **禁止 import `vscode`**。
2. `src/kernel/**` **禁止 import `src/hosts/**` 或 `src/webview/**`**。
3. 一个 Host 可以依赖 Kernel；Kernel 不知道 Host 的具体实现。
4. ACP/CLI/VS Code 都只能通过 `ToolRegistry → ToolRuntime` 执行工具。
5. Host 可以负责 UI：输入、权限弹窗、Diff 展示、终端展示；**Policy ownership 不在 Host**。
6. durable session/EventLog/checkpoint 是跨 Host 的平台能力，不属于某个 UI。
7. 如果一个功能只在某个 Host 可用，必须由 capability contract 明确说明原因，不允许静默降级。

这些规则由 `npm run check` 中的 `host-boundary` 门禁逐步执行。
