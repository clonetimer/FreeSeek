# FreeSeek 0.19 Roadmap — Beyond VS Code

## 产品目标

让 FreeSeek 的产品定义从“VS Code 扩展 + 附带 CLI”变为：

> **FreeSeek Kernel + VS Code Host + CLI Host + ACP Host**

## 实施顺序

1. **M0 Governance — Done**：版本、分支、台账、架构边界和门禁。
2. **M1 Host Contract — Done (alpha.1)**：显式 capability，消灭隐式 host degradation；CLI/Headless 已对齐 MCP、Skills、显式 Multi-Agent。
3. **M2 ACP stdio — Done (alpha.2)**：第三 Host 已实现 stable ACP v1 stdio、durable session、permission、MCP 与 cancel。
4. **M3 Host Parity — Done (beta.1)**：完成 capability-negotiated ask-user/form elicitation、受控 additionalDirectories、多 workspace root 安全模型、skills/multi-agent policy 与 session mode 持久化。
5. **M4 Interop — Done (rc.1)**：协议 conformance、两个独立 ACP Client、发行 artifact smoke/package 与 gate parser 均已闭环。
6. **M5 Stable — Done**：0.19.0 Cross-host Stable。

## 明确不做

- 0.19 不开发一个 FreeSeek 自有 IDE；
- 0.19 不把 Draft ACP HTTP/WebSocket transport 当成稳定协议依赖；
- 0.19 不为了目录美观一次性移动所有核心文件；
- 0.19 不让 ACP Host 直接执行 raw tool body。

## 0.19 之后的优先顺序

1. **Standalone Desktop UI**：仅在 `0.19.0` Cross-host Stable 完成后启动，复用同一 Kernel / Agent Server，不复制 Agent 逻辑。
2. **General HMR Extension Runtime**：放在独立桌面 UI 之后，再推进版本化插件、可逆 lifecycle/effects、turn-boundary atomic hot swap、依赖/PENDING、last-known-good rollback 与跨 Host 插件管理。

当前 0.19 发布线禁止混入 Desktop UI 或 HMR Runtime 功能。
