# FreeSeek 现代化改造路线图（2026 Q4）

> 状态：P0、P1 已完成并合并；P2 ACP 官方 SDK 互操作升级进行中  
> 目标：在保留现有 Agent Kernel、ToolRuntime 和多宿主能力的基础上，把 FreeSeek 从功能堆叠型 Coding Agent 收敛为可维护、协议兼容、安全可控、易于使用的本地优先 AI 开发平台。  
> 原则：先建立可重复验证的基线，再升级协议和 Provider；不以大规模重写代替架构治理，不为追逐版本号而牺牲兼容性。

## 1. 当前基线审计

审计对象：P0 基线提交 `0b0443c19fb807445c5403359326d9ef4d155d43`，版本 `0.26.0`；P0 通过独立 PR #1 合并至 main，合并提交 `0355c6508fb78da71eefdf7ccadb7030eac4ac80`。

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
| Node.js | `engines.node >=22.0.0`（已更新） | Node 22 / 24 / 26 均通过跨平台 CI；Node 18 不再作为支持基线 |
| MCP | P1 分支已新增 `src/mcp-sdk.ts`，采用官方 `@modelcontextprotocol/client` v2.4.0 | 现代协议自动协商、legacy SSE 受控回退、stdio 环境隔离；等待跨平台 CI 验收 |
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

### P0 — 可验证基线（已完成）

1. 新增 GitHub Actions CI。
2. 验证 Linux / Windows / macOS 与 Node 22 / 24 / 26。
3. 每个矩阵执行 `npm ci`、`npm run check`、`npm test`、`npm run smoke`。
4. 固定本次主干提交与 CI 结果，失败项先分类，不以跳过测试制造绿色结果。

**验收结果：PASS。** PR #1 已合并至 main；冻结标签 `v0.26.0-p0-frozen` 指向合并提交 `0355c6508fb78da71eefdf7ccadb7030eac4ac80`。9/9 环境通过：Ubuntu / Windows / macOS × Node 22 / 24 / 26。Linux Node 24 共 538 项测试，522 PASS、16 SKIP、0 FAIL；macOS 的 Linux 专属沙箱能力按平台条件跳过。

本轮 CI 还修复了三类跨平台问题：
- Windows 符号链接测试改用真实存在的外部目录与 Junction，避免把 POSIX `/etc` 当成 Windows 路径。
- 路径安全检查先规范化真实路径，再判断授权根目录；修复 macOS `/var → /private/var` 别名导致的合法路径误拒绝。
- Web Console 关闭 SSE 心跳计时器，并在 ACP sidecar 关闭时先结束 stdin，让 POSIX 子进程完成 EOF 优雅退出；SIGTERM / SIGKILL 仅作为兜底。
- 测试运行器固定默认并发为 4，并为单项测试设置 120 秒上限，避免不同 CI runner 并行度差异造成耗时不可控。

### P1 — MCP 协议现代化（已完成；独立 PR #2 已合并）

P1 分支已将 MCP 连接执行层迁移至官方 `@modelcontextprotocol/client` v2.4.0。原 `McpManager`、工具命名与 Agent ToolRuntime 路由保持不变；新 adapter 使用 SDK 处理 JSON-RPC、stdio / Streamable HTTP / SSE、协议协商、分页、取消与 list-changed 通知。SDK v2 实现 MCP 2026-07-28 规范，并提供旧协议版本协商。

实施顺序：

1. **优先评估官方 `@modelcontextprotocol/client` v2**，不继续扩写自维护的 JSON-RPC / HTTP / SSE 协议栈。SDK v2 实现 2026-07-28 规范，并支持自动协商旧版 2024-10-07 至 2025-11-25 协议。
2. 在 FreeSeek 内保留现有 `McpManager` / 工具注册接口，将官方 SDK 封装在 transport adapter 内；保留环境变量白名单、凭据处理、超时、取消、日志和权限审批策略。
3. 覆盖 stdio、Streamable HTTP、旧 SSE 服务；HTTP 认证与 legacy fallback 必须区分 401/403 和真正的 transport 不兼容，不能错误降级。
4. 支持新协议的能力发现、请求元数据、`resultType`、MRTR 输入往返与订阅；保留旧协议服务兼容。
5. 以官方 SDK v2 server fixture、MCP Inspector 和独立客户端建立新旧协议互操作测试。
6. MCP SDK v2 要求 TypeScript 6.0 或更新版本；P1 已升级 TypeScript 6、Node 22 类型与 VS Code API 类型，并将类型检查切换为 Bundler resolution，以保留当前 ESM/CJS 混合构建。最低运行环境同步提升为 Node.js 22、VS Code 1.101。
7. 更新 MCP 管理界面：显示协商版本、传输、能力、连接状态、工具与资源缓存状态。

**当前实现：** 新增 `src/mcp-sdk.ts` 官方 SDK adapter，`McpManager` / ToolRuntime 路由契约保持不变；已接入 stdio、Streamable HTTP 自动协商与 legacy SSE 受控回退，包含工具/资源/Prompt、list-changed、请求超时与取消。Node 22+、TypeScript 6、VS Code 1.101+ 运行时基线已对齐。

**验收结果：PASS。** PR #2 已合并至 main，合并提交 `2b4e0146bd07f8e2ace3114fa73498b46a4d850b`。官方 SDK v2 adapter 与旧服务兼容层通过 Ubuntu / Windows / macOS × Node 22 / 24 / 26 的 9/9 PR CI。专项覆盖现代 Streamable HTTP、旧 stdio、旧 SSE-only、401/403 不降级、旧服务缺失 capability 声明的兼容处理、环境变量白名单、工具/资源/Prompt 调用与关闭清理。

**验收：** 新旧 MCP 服务均可连接；工具、资源、提示词、取消、超时、错误与权限审批均有测试；旧服务失败不会拖垮内置工具。

### P2 — ACP 互操作升级（已完成；独立 PR #3）

1. 以 ACP 稳定 v1 为默认协议基线，保持现有 FreeSeek ACP Host / Agent Kernel 边界。
2. 将官方 `@agentclientprotocol/sdk` 2.6.0 作为开发测试依赖；默认入口使用稳定 v1，不将实验 v2 SDK 引入生产宿主。
3. 以官方 SDK client 作为独立互操作端，直接连接真实 FreeSeek stdio ACP Host，验证初始化、能力声明、session/new、prompt、list、resume、load、close 和 additionalDirectories。
4. 对照官方 v1 schema 修正文档和 capability matrix，尤其核对 `loadSession`、`additionalDirectories`、elicitation 与 MCP 传输能力。
5. 保留现有自定义 ACP server transport，除非独立 SDK 互操作测试证明存在协议层缺陷；不为使用 SDK 而重写已经稳定的 Agent/Session 执行内核。
6. ACP v2 目前处于 Draft：保持隔离，不默认启用、不替换 v1，也不把 draft 能力宣传为 Stable。
7. 将 ACP 协议版本、FreeSeek 产品版本和 Desktop 版本分开管理，避免混用。

**验收结果：PASS。** PR #3 的官方 SDK 客户端互操作测试通过；PR CI [43159475763](https://github.com/clonetimer/FreeSeek/actions/runs/43159475763) 通过 Ubuntu / Windows / macOS × Node 22 / 24 / 26 全部 9/9 环境。代表性 Ubuntu / Node 22 测试结果为 544 项测试、528 PASS、16 SKIP、0 FAIL；独立 smoke 子套件 3 PASS、1 SKIP、0 FAIL。`docs/acp.md` 已按源码修正稳定 v1 能力声明。

**验收：** 稳定 v1 与官方独立客户端互操作通过；session/load 与 additionalDirectories 语义通过真实会话回归；v2 实验不影响 v1；能力声明与实际实现、文档、测试一致。

### P3 — Provider 与模型能力现代化（实施中；独立分支 `modernize/p3-responses-multi-provider`）

1. 新增独立 `responses` Provider 格式和 `/responses` endpoint；现有 `openai` 继续表示 Chat Completions，不改变旧配置语义。
2. Responses adapter 使用 typed input/output items，完成 ChatMessage ↔ Responses item 映射；工具调用使用 `function_call` 与 `function_call_output`，工具执行继续统一进入 ToolRuntime。
3. 实现 Responses SSE 事件处理：文本增量、reasoning summary、function-call arguments、response completed/incomplete/failed、usage 与取消；支持非流式摘要/记忆辅助调用。
4. **本地优先状态策略：** 默认发送 `store:false`，不依赖 `conversation` 或 `previous_response_id`；请求 `reasoning.encrypted_content`，将需要续接的原始 Responses output items 随本地 ChatMessage/EventLog 保存。只有显式设置 `storeResponses:true` 才允许服务端存储。
5. 增加显式模型能力描述：工具调用、视觉、推理、结构化输出、上下文窗口、最大输出 token、输入/输出模态；能力未知时保持 unknown，不用模型名称正则伪造支持结论。模型级声明覆盖 Provider 级默认值。
6. 保留 OpenAI Chat Completions、Anthropic Messages、Gemini generateContent、OpenAI-compatible 自定义端点及本地 Ollama/LM Studio；不因新增 Responses API 改变已有 Provider 的默认协议。
7. 统一模型能力摘要与模型切换展示；能力声明可在 `freesek.providers` 配置中编辑，明确区分协议能力与具体模型能力。
8. 统一请求错误分类、超时、idle timeout、取消、usage 统计；Responses 专属 body 不透传 Chat Completions 的 `messages`、`max_tokens` 或 `stream_options` 字段。
9. 使用本地 mock server 建立协议契约测试，覆盖请求/响应映射、SSE、工具往返、推理状态续接、store 默认值、错误/取消/usage；真实模型只用于代表性 A/B。

**当前审计结论：** 现有 Provider 主循环集中在 `src/provider.ts`，ChatMessage 和 EventLog 负责本地会话历史。Responses 实现将拆为独立 `src/provider-responses.ts`，通过既有 streamChat 契约接入，不复制 Agent/ToolRuntime。

**验收：** 新旧 Provider 回归通过；Responses function calling 完成真实 ToolRuntime 往返；流式中断/取消/重试语义正确；store 默认关闭且推理状态可从本地 EventLog 恢复；能力描述可解释；本地模型与兼容网关不受影响。

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
- [Official MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)：官方 v2 Client 支持新协议及旧版自动协商；FreeSeek 应优先封装官方 SDK，而不是继续维护自定义 JSON-RPC 协议栈。
- [ACP v2 Draft Announcement](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/announcements/acp-v2-draft.mdx)：v2 继续处于 Draft，需与 v1 并行、按协商和 feature flag 启用。
- [Official ACP TypeScript SDK](https://www.npmjs.com/package/@agentclientprotocol/sdk)：默认入口对应稳定 ACP v1，实验入口单独区分。
- [OpenAI Responses API Migration Guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)：Responses 是新项目推荐接口；Chat Completions 保持兼容，需分别处理 typed output 与流式事件。

---

**实施纪律：** 每个阶段单独分支、独立测试、形成证据，再合并并打 tag。先完成 P0 基线，再进入 P1/P2 协议升级；不把“代码已写”当作“功能已验收”。
