# FreeSeek 现代化改造路线图（2026 Q4）

> 状态：P0 基线建设进行中  
> 目标：在保留现有 Agent Kernel、ToolRuntime 和多宿主能力的基础上，把 FreeSeek 从功能堆叠型 Coding Agent 收敛为可维护、协议兼容、安全可控、易于使用的本地优先 AI 开发平台。  
> 原则：先建立可重复验证的基线，再升级协议和 Provider；不以大规模重写代替架构治理，不为追逐版本号而牺牲兼容性。

## 1. 当前基线审计

审计对象：`main`，基线提交 `0b0443c19fb807445c5403359326d9ef4d155d43`，版本 `0.26.0`。

### 已有资产（保留并继续复用）

- 宿主无关 Agent Kernel；VS Code、CLI/Headless、ACP、Web Console、Desktop 共用执行内核。
- 统一 `ToolRegistry → ToolRuntime → EventLog`，权限、审批、取消、超时和工具执行边界集中管理。
- Provider 配置与模型切换、MCP、Skills、插件、子 Agent、会话恢复、Checkpoint。
- 本地与远程命令执行适配、Eval/Bench、Context Planner、桌面端 ACP 客户端架构。
- 86 个测试文件、既有 `npm run check` / `npm test` / `npm run smoke` 门禁。

### 已确认的现代化缺口

| 领域 | 当前基线 | 改造判断 |
| --- | --- | --- |
| CI | 仓库未发现 `.github/workflows` | 建立跨平台、跨 Node LTS 的自动化门禁 |
| Node.js | `engines.node >=18` | Node 18 已 EOL；验证 Node 22/24/26 后更新运行时支持声明 |
| MCP | `src/mcp.ts` 固定使用 `2024-11-05` 初始化握手 | 支持新旧协议协商，不能只改版本字符串 |
| ACP | 当前实现 ACP v1 stdio host | 以稳定 v1 为兼容基线，评估官方 SDK 与新能力；v2 只做实验性并行实现 |
| Provider | OpenAI Chat Completions、Anthropic Messages、Gemini generateContent | 增加 OpenAI Responses API 适配，保留旧接口与 OpenAI-compatible 服务 |
| 文档 | 多处产品版本和能力说明不一致 | 以代码、测试和发布证据为准，重建单一能力矩阵 |
| 产品定位 | Quickstart 仍把免费 DeepSeek 网页逆向服务作为默认主路径 | 调整为多 Provider / 本地模型优先；逆向服务保留为可选兼容路径 |
| 架构维护 | `extension.ts` 约 2,759 行，Webview 模板与主入口较大 | 按领域边界渐进拆分，不做机械拆文件 |
| 桌面端 | Desktop 仍有 RC / 原生安装包证据门槛 | 单独建立 Windows/macOS/Linux 发布验收，不将开发态等同 Stable |

### 文档与源码不一致项

- `src/hosts/acp/server.ts` 已实现 `session/load`，并声明 `loadSession: true`；`docs/acp.md` 仍描述为不支持。
- 源码已处理 `additionalDirectories`；ACP 文档仍把多根目录能力描述为不支持。
- 产品面文档仍把 Desktop 标成 0.20 development，而 README/CHANGELOG 已经推进到 0.26.0。
- Quickstart 的免费逆向服务流程与当前多 Provider 产品定位不一致。

以上先作为文档与能力核对项，不在未完成协议测试前直接改变用户行为。

## 2. 目标架构与产品边界

继续坚持一个 Kernel、多宿主：

```text
VS Code ─┐
CLI/TUI ─┤
ACP ─────┤
Web ─────┼── Host Adapters ── Agent Kernel ── ToolRegistry / ToolRuntime
Desktop ─┘                                      │
                                                ├── EventLog / Session / Checkpoint
                                                ├── Permission / Policy / Sandbox
                                                ├── MCP / Skills / Plugins / Subagents
                                                └── Provider Adapters
```

- Kernel 只负责 Agent 编排、工具契约、上下文、事件和安全边界，不绑定具体 UI 或单一模型厂商。
- Host 只负责交互、能力声明和宿主原生能力，不复制 Agent 执行逻辑。
- Provider 负责协议差异、流解析、工具调用映射、模型能力和用量信息。
- MCP / ACP 是外部互操作协议，版本协商与兼容策略独立于内部 Kernel 版本。
- 插件扩展不得绕过 ToolRuntime 的权限、审计和沙箱边界。

## 3. 分阶段改造

### P0 — 可验证基线（当前批次）

1. 新增 GitHub Actions CI。
2. 验证 Linux / Windows / macOS 与 Node 22 / 24 / 26。
3. 每个矩阵执行 `npm ci`、`npm run check`、`npm test`、`npm run smoke`。
4. 固定本次主干提交与 CI 结果，失败项先分类，不以跳过测试制造绿色结果。

**验收：** 9 组环境结果可追溯；平台能力缺失导致的 skip 必须有明确原因；任何新增失败都形成可复现记录。

### P1 — MCP 协议现代化

当前 MCP 客户端仍按 `2024-11-05` 初始化流程工作。2026-07-28 规范对 HTTP 无状态化、初始化握手、能力发现、MRTR 和订阅机制均有重大调整。

实施顺序：

1. 将 MCP 协议实现从连接生命周期中抽离，建立版本化协议适配层。
2. 新增 2026-07-28 版本发现与协商能力（`server/discover`、请求元数据、`resultType`）。
3. 支持 MRTR 的输入请求/响应往返；处理新旧协议返回值差异。
4. 按新规范处理 Streamable HTTP 订阅；旧版 Streamable HTTP / SSE 保持兼容。
5. 保留 2025-11-25 及 2024-11-05 旧服务连接能力，不能因升级导致现有 stdio MCP 服务失效。
6. 增加协议 fixture、模拟 server 和独立 MCP Inspector / SDK 互操作测试。
7. 更新 MCP 管理界面：显示协商版本、传输、能力、连接状态、工具与资源缓存状态。

**验收：** 新旧 MCP 服务均可连接；工具、资源、提示词、取消、超时、错误与权限审批均有测试；旧服务失败不会拖垮内置工具。

### P2 — ACP 互操作升级

1. 以 ACP 稳定 v1 为默认协议基线，补齐当前稳定 v1 的方法、能力声明和 schema 兼容测试。
2. 评估接入官方 `@agentclientprotocol/sdk` 的收益；优先用于类型/schema/conformance，避免为了使用 SDK 重写已经稳定的执行内核。
3. 对照官方 v1 schema 修正文档和 capability matrix。
4. 建立独立客户端互操作测试，覆盖初始化、会话创建/恢复/加载/关闭、模式切换、取消、权限请求、MCP 和历史回放。
5. ACP v2 目前处于 Draft：建立隔离的实验适配层与 feature flag；不默认启用、不替换 v1，也不把 draft 能力宣传为 Stable。
6. 将 ACP 协议版本、FreeSeek 产品版本和 Desktop 版本分开管理，避免混用。

**验收：** 稳定 v1 与独立客户端互操作通过；v2 实验不影响 v1；能力声明与实际实现、文档、测试一致。

### P3 — Provider 与模型能力现代化

1. 新增 OpenAI Responses API adapter，支持 typed output items、function call / function_call_output、SSE 事件流、reasoning 与 usage 映射。
2. 保留 Chat Completions、Anthropic Messages、Gemini API 和 OpenAI-compatible 自定义端点。
3. 引入显式 Provider/Model capability descriptor，区分工具调用、视觉、结构化输出、推理、上下文窗口、缓存和多模态输入；不再只依赖模型名称正则猜测。
4. 统一请求超时、流空闲超时、取消、重试、限流、错误分类和 usage 记录。
5. 明确 Responses API 的服务端状态存储策略；默认遵循 FreeSeek 本地优先原则，是否启用远端存储必须由用户显式选择。
6. 用 mock server 建立协议契约测试；真实模型只用于代表性 A/B，不把某一厂商的行为写死进 Kernel。

**验收：** 新旧 Provider 回归通过；工具调用与流式中断恢复正确；模型能力信息可解释；本地模型与兼容网关不受影响。

### P4 — Agent Kernel 与安全边界治理

1. 保持 ToolRuntime 为唯一执行入口；所有内置工具、MCP、插件、子 Agent 均不得旁路权限与审计。
2. 统一工具 effect、approval、capability、timeout、concurrency 和 sandbox 元数据。
3. 继续完善路径穿越、符号链接、命令注入、SSRF、提示注入、MCP 恶意工具、插件越权和凭据泄露测试。
4. 明确 Windows/macOS/Linux 沙箱能力差异；不把进程级降级描述为 OS 级隔离。
5. 统一 EventLog schema version、session migration、checkpoint 与恢复语义。
6. Context Planner 和其他优化保持实验开关；只有 Public + Private Holdout + Pinned Real Repo 的模型级评估证明正确性不退化，才允许推广默认值。

**验收：** 安全测试可重复；宿主之间权限语义一致；事件可回放；恢复不丢失或伪造状态；优化效果有真实任务证据。

### P5 — 产品体验与发行体系

1. 重做首次启动向导：选择本地模型 / 云 Provider → 连接测试 → 模型能力检测 → 工作区授权 → 首个任务。
2. 模型配置按常用项与高级项分层；显示上下文窗口、工具调用、视觉能力和连接状态。
3. CLI/TUI、VS Code、Web Console、Desktop 共享操作语义，但保留各宿主的原生优势。
4. Quickstart 从“免费网页逆向 API”调整为“本地模型或任意兼容 Provider”；旧逆向服务作为可选、明确标注风险的 legacy adapter。
5. 统一会话、任务、工具调用、审批、Diff、恢复和导出体验。
6. Desktop 单独完成 Windows/macOS/Linux 的安装、升级、回滚、签名、卸载和数据保留验收。
7. 建立版本迁移、安装包校验、Release Notes、SBOM / 依赖安全检查和可回滚发布流程。

**验收：** 新用户可在不编辑 JSON 配置的情况下完成首次连接和任务；升级不丢会话、密钥或用户设置；平台安装包均有可复核证据。

### P6 — 架构收敛与跨项目集成

1. 按职责拆分超大模块，优先处理宿主装配、Webview 渲染、Provider 流解析和 MCP 协议实现。
2. 每次拆分保持行为不变，并用现有测试与 golden fixture 证明。
3. 清理重复文档、过期实验、未使用代码和过时依赖；保留有审计价值的实验记录。
4. 定义 FreeSeek 与 AnyHarness 的集成边界：FreeSeek 负责执行，项目 Harness 负责项目不变量、风险规则、审查策略和演化记录。最终以 AnyHarness 实际源码为准，不在其仓库不可访问时预设接口。
5. 提供统一插件/Skill/命令分发规范，避免两个项目重复实现 Agent Kernel。

**验收：** 模块边界有自动化约束；功能迁移不改变既有行为；两个项目通过公开、稳定的插件或协议接口协作，不形成循环依赖。

## 4. 全局验收标准

- **正确性：** 核心任务成功率不低于冻结基线；任何下降都必须阻断发布。
- **兼容性：** 旧 Provider、MCP Server、ACP v1 客户端、历史会话与现有配置可迁移。
- **安全性：** 默认最小权限、审批可见、沙箱能力真实、密钥不进入普通日志或命令行参数。
- **可维护性：** CI 覆盖受支持平台；模块边界与协议契约自动验证；文档与代码一致。
- **体验：** 常用路径向导化；高级配置按需展开；失败提示给出原因、影响和可执行恢复入口。
- **性能：** 使用代表性真实仓库对任务成功率、工具调用数、token、延迟和成本进行 A/B；不以单一 token 降低宣称优化成功。
- **发布：** 版本、变更记录、安装包、哈希、升级/回滚证据齐全。

## 5. 外部规范与运行时基线

- [Node.js Release Schedule](https://github.com/nodejs/Release)：Node 22 / 24 / 26 支持矩阵。
- [Node.js EOL](https://nodejs.org/en/about/eol)：停止维护的运行时不得继续作为正式支持基线。
- [MCP 2026-07-28 Changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx)：无状态化、能力发现、MRTR 与订阅机制。
- [ACP v2 Draft Announcement](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/announcements/acp-v2-draft.mdx)：v2 继续处于 Draft，需与 v1 并行、按协商和 feature flag 启用。
- [Official ACP TypeScript SDK](https://www.npmjs.com/package/@agentclientprotocol/sdk)：默认入口对应稳定 ACP v1，实验入口单独区分。
- [OpenAI Responses API Migration Guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)：Responses 是新项目推荐接口；Chat Completions 保持兼容，需分别处理 typed output 与流式事件。

---

**实施纪律：** 每个阶段单独分支、独立测试、形成证据，再合并并打 tag。先完成 P0 基线，再进入 P1/P2 协议升级；不把“代码已写”当作“功能已验收”。
