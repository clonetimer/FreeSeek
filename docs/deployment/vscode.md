# VS Code 扩展 — 部署与使用说明

> VS Code 是 FreeSeek 的**旗舰交互宿主**：编辑器原生 selection/diff/LSP/审批/会话 UI。

## 部署

**方式一：VSIX 安装**

```bash
npx --no-install vsce package --no-dependencies
code --install-extension freeseek-copilot-<version>.vsix
# 或扩展面板「从 VSIX 安装…」
```

**方式二：源码调试**

```bash
git clone <source> && cd freeseek
npm ci && npm run compile
# 用 VS Code 打开仓库，按 F5 启动 Extension Development Host
```

**方式三：Marketplace（发布后）**：扩展市场搜索 FreeSeek。

## 配置

- Provider：`freesek.providers` 数组（多提供商/多模型，`${env:VAR}` / `${setting:x}` 插值）；
  也可「FreeSeek: 添加提供商」向导一键选预设（DeepSeek/OpenRouter/硅基流动/Kimi/通义/智谱/腾讯混元/OpenAI/Ollama/LM Studio）。
- `freesek.allowShell`（默认 false）、`freesek.allowNetwork`（默认 true）。
- `freesek.mode`：coder / craft / plan / ask（对话内按钮实时切换）。
- `freesek.autoVerify`（默认 true）：「写→跑→修」闭环。
- `freesek.mcpServers`（stdio/http）、`freesek.extensionDirs`（HMR root）、`freesek.extensionSandboxPolicyFile`（H4 policy）。
- Security：`freesek.denyRules/allowRules`、`freesek.sandboxMode`（off/readonly/sandbox）、`freesek.confirmFileWrites`。

## 使用说明

- 命令面板（`Ctrl+Shift+P`）所有命令前缀 `FreeSeek:`：打开编程助手、新建/恢复/分叉/重命名/清空对话、
  切换模型、添加提供商、管理 MCP、启动免费服务、打开 Slash 命令、管理定时任务、管理 HMR 扩展、管理 Hookify、安装专家套件。
- 对话内 Slash：`/init` `/review` `/compact` `/memory` `/clear` `/summarize` `/skills` + 自定义 `.agent/commands/*.md`。
- 对话内 diff 卡片可「接受 / 回滚」；任务清单 / 文件列表 / 当前目标常驻面板。

## 安全默认

shell 关闭；写文件默认放行（`confirmFileWrites` 可弹确认，`denyRules` 优先）；MCP 工具首次调用独立审批；
webview CSP 加固 + DOMPurify 渲染；`delete_file` 走系统回收站。