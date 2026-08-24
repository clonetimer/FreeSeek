# FreeSeek Desktop 部署与使用

Desktop 的架构固定为：

`Electron Renderer → preload IPC → Electron main → ACP sidecar → shared Agent/Kernel`

Renderer 不持有 Node、filesystem、ToolRuntime 或 ExtensionRuntime 权限。

## 源码启动

```bash
npm ci
npm --prefix apps/desktop ci
npm run desktop:build
npm --prefix apps/desktop start
```

生产/发行环境还应执行仓库中的 Electron runtime verify、packaged smoke、secureStorage、recovery、installer/upgrade/rollback 与签名证据脚本。

## UI

0.22 包含 U0-U5：三栏会话工作区、typed tool cards、Trajectory Inspector、证据化 file diff/deliverable、长会话窗口化、增量 Markdown 与可访问性改进。

## General HMR

Desktop 设置中可以填写 Extension trust roots 与 sandbox policy 文件。生命周期实际由 ACP sidecar 的共享 Extension Host 管理，Desktop 只显示状态并发起 H3 管理请求。
