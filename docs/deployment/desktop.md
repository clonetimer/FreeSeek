# Desktop — 部署与使用说明

> 完整细节见 [../project/DESKTOP_ARCHITECTURE.md](../project/DESKTOP_ARCHITECTURE.md)。Desktop 是 Electron 壳，经 ACP sidecar 使用共享 Kernel；**Renderer 无 Node/文件系统/ToolRuntime 权限**。

## 部署

**环境要求**：Node >= 18；npm cache 可写；Electron 43.3.0（apps/desktop 声明）。

**源码构建**：

```bash
git clone <source> && cd freeseek
npm ci
npm --prefix apps/desktop ci
npm run desktop:build      # 或 desktop:build:prod（生产）
npm --prefix apps/desktop start
```

**架构（不可绕过）**：`Electron Renderer → preload IPC → Electron main → ACP sidecar → 共享 Kernel`。
`npm run check` 强制 Desktop 不得直接 import Agent/ToolRuntime/Tools。

## 使用说明

- Desktop UI（0.21 RC1 U0-U5）：三栏会话工作区、typed tool cards、Trajectory Inspector、
  证据化 file diff/deliverable、长会话窗口化、增量 Markdown、可访问性。
- 会话：侧栏历史 + resume；工作区/Provider 启动、流式 prompt、mode/cancel、permission/elicitation 桥。
- API Key 保存在 Electron main 的 secure storage（DPAPI 等）；不写 Renderer。

## 验证与证据（生产发布前）

- `npm run desktop:smoke`（Electron 冒烟）
- `npm run desktop:release:evidence`、`desktop:rc:evidence:gate`、`desktop:stable:evidence:gate`
- 目标平台签名证据：`desktop:signing:evidence:linux|windows|macos`
- 原生安装/升级/回滚证据：`desktop:installer:evidence:native`、`desktop:recovery:smoke`

**边界**：Desktop UI 0.21 RC1 已冻结；原生制品（installer/signing）认证在本机外完成；
Windows/macOS 上 H4 untrusted sandbox fail-closed（trusted HMR H0-H3 不受影响）。