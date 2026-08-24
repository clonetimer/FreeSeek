# FreeSeek 0.20.0 产品与适用场景

## FreeSeek Core / Kernel
共享 Agent 执行、ToolRuntime、EventLog、Context、Safety/Permission 等能力。各 Host 复用该 Kernel。

## VS Code Extension
适合编辑器原生工作：代码阅读、修改、项目上下文、编辑器交互。优势是 IDE 上下文；不适合脱离 VS Code 的独立桌面使用。

## CLI
适合服务器、终端、CI/脚本、无 GUI 环境和可组合自动化。

## ACP Host
适合让第三方 ACP Client 调用 FreeSeek Agent。已验证 Official ACP TypeScript SDK 与 OpenClaw acpx 两个独立 Client。

## Desktop
适合希望获得独立 Agent 应用体验、但仍复用 FreeSeek Kernel 的用户。Desktop 不是第二套 Agent，实现重点是 Host、会话 UX、设置、安全存储、恢复与可视化。

## Eval / Bench
适合研发阶段做功能回归、Context Planner 对比、公开/私有基准与持续质量检查。

## 0.20 Stable 的边界

当前 Stable 聚焦功能和本地/内部交付。Windows Authenticode、macOS notarization 和公共更新签名属于公开发布供应链层，暂不作为当前研发主线阻塞项。
