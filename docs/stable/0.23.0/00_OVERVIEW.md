# FreeSeek 0.23.0 Stable Source — 总览

FreeSeek 是宿主无关的 Agent 平台。VS Code、CLI/Headless、ACP 与 Desktop 共享同一 `runAgent → ToolRegistry → ToolRuntime → EventLog`；General HMR 位于平台 Extension Runtime 层。

## 产品形态

| 形态 | 定位 | 主要入口 |
|---|---|---|
| Core | Agent/Kernel、工具运行时、事件日志、Extension Runtime | 源码嵌入 |
| CLI / Headless | 终端、CI、自动化、durable session | `freeseek` |
| ACP | 标准 ACP v1 stdio Agent Server | `freeseek acp` / `freeseek-acp` |
| VS Code | 编辑器原生宿主 | VSIX/源码调试 |
| Desktop | Electron UI，经 ACP sidecar 使用共享 Kernel | Desktop app |
| Eval / Bench | 评测、回归、上下文/真实仓库 benchmark | `freeseek eval` / `freeseek bench` |
| General HMR | 平台级扩展运行时 | `--extension-dir` / Host settings |

0.23.0 Source Stable 在 0.22.0 冻结基线（Desktop UI U0-U5 与 General HMR H0-H4）之上，新增一次**验证与跨平台加固**（verification & hardening pass）：修复 hookify 热加载缓存竞态、测试基建布局缺陷、缺失的平台门控与 Windows ESM 导入问题（详见 CHANGELOG 0.23.0 与 09_VALIDATION_AND_RELEASE）。它不是把 Desktop、CLI 或 Extension 做成互相独立的 Agent。

## 当前发行标识

本 Kit 是 **Local/Internal Source Stable**：源码、版本和文档冻结；正式不可移动 `v0.23.0` 标签等待完整依赖型构建/测试、独立 ACP 客户端证据与目标平台原生制品验证后创建。
