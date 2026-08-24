# FreeSeek Core 部署与使用

Core 不是单独的第二套产品进程，而是所有 Host 共用的 Agent/Kernel。核心不变量是 `ToolRegistry → ToolRuntime → EventLog`，Host 不应绕过 ToolRuntime 直接执行 raw tool body。

## 二次开发

```bash
git clone <source>
cd freeseek
npm ci
npm run check
npm test
npm run compile
```

建议先运行：

```bash
npm run project:status
```

## 嵌入原则

- Agent run 在开始时获取 Extension generation lease；运行中不热改 ToolRegistry。
- 文件/网络/shell 权限继续由 ToolRuntime 和 Host policy 控制。
- durable session 使用 EventLog；不要由 UI 自建第二套事实来源。
- Desktop 必须继续经 ACP 使用共享 Kernel。
