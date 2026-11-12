# 多协议 Provider 接入

FreeSeek 通过 Provider 抽象层接入各种 AI 服务，支持 `openai` / `claude` /
`gemini` 三种协议格式。每种格式会自动构造对应端点、认证头与流式解析。

## 支持的协议格式

| format | 认证头 | 典型服务 |
| --- | --- | --- |
| `openai` | `Authorization: Bearer <key>` | DeepSeek / OpenRouter / 硅基流动 / Kimi / 通义 / 智谱 / 腾讯混元 / OpenAI / Ollama / LM Studio |
| `claude` | `x-api-key: <key>` + `anthropic-version` | Anthropic Claude |
| `gemini` | `x-goog-api-key: <key>` | Google Gemini |

每个 Provider 项还支持：

- **`headers`**：自定义请求头（含 `${env:VAR}` 插值）。
- **`extraBody`**：额外请求体透传。
- **`authType`**：认证方式（`bearer` 等）。
- **`autoDiscoverModels`**：自动拉取 `/v1/models` 的全部已加载模型（LM Studio / Ollama 本地服务推荐开启，切换模型时实时刷新）。
- **`toolMode`**：`native`（原生 function calling）或 `react`（ReAct 文本协议）。

## 预设服务商

「添加提供商」向导（命令 `FreeSeek: 添加提供商`）提供 10 个常见预设，自动填充
Base URL / 协议格式 / 认证方式 / 模型：

DeepSeek / OpenRouter / 硅基流动 / Kimi / 通义 / 智谱 / 腾讯混元 / OpenAI /
Ollama / LM Studio。仅「自定义」需要手动填写。

- 选预设后，API Key 输入框自动填入对应的 `${env:}` 环境变量引用。
- 保存后自动调用 `/models` 探测服务可达性与鉴权有效性并反馈结果。
- 腾讯云混元预设（`tencent-hunyuan`）为 OpenAI 兼容格式，含
  `hunyuan-turbo` / `hunyuan-pro` / `hunyuan-standard` 模型。

## 手动配置

完整的 `freesek.providers` 手动配置示例见 [configuration.md](configuration.md)，
设置项速查见 [settings.md](settings.md)。

## 连接器插件（Connectors）

连接器插件机制（`src/connectors.ts`）允许第三方注册外部服务工具：

- 注册入口：`registerConnector` / `dispatchConnectorTool`。
- 工具命名约定：`conn__<id>__<tool>`。
- 内置通用 HTTP 请求连接器。

### PaperSeek 学术检索

内置 `conn__paper_seek__search` 连接器：用自然语言检索论文
（OpenAlex / arXiv / Semantic Scholar / PubMed 等），返回
标题 / 作者 / 年份 / 引用数 / 摘要；同时支持 MCP 方式接入。

## MCP 服务

FreeSeek 使用官方 `@modelcontextprotocol/client` v2.4.0 接入外部 MCP server。MCP 连接由 SDK 管理，FreeSeek 保留现有 `McpManager` 与 Agent 工具路由契约。

支持的连接方式：

- **stdio**：由 SDK 启动本地 MCP 子进程；仅继承 FreeSeek 的系统环境变量白名单及该 server 显式配置的 `env`。
- **Streamable HTTP**：优先使用现代 HTTP transport，自动协商 MCP 2026-07-28 与旧版协议。
- **Legacy SSE**：对 Streamable HTTP 明确返回 404 / 405 / 406 / 415 的端点，才尝试旧 SSE transport；401 / 403、5xx、超时和网络错误不会触发降级。

SDK 负责 JSON-RPC、分页、协议协商、请求取消、资源与 Prompt 调用及 list-changed 通知。连接后自动发现工具、resources、prompts，并注入 `mcp__<name>__<tool>` 工具。若 MCP server 暴露检索类工具（名称匹配
`search|query|retriev|kb|knowledge|find|lookup|semantic|vector|rag`），会自动暴露
统一检索入口 `mcp_list_kb` + `mcp_kb_search`。

MCP 配置仍使用 `freesek.mcpServers`，现有 stdio / http 配置结构保持兼容（[settings.md](settings.md)）。本版最低运行环境为 Node.js 22 和 VS Code 1.101。

## 切换模型

对话中通过顶栏模型 chip（内置下拉，多提供商分组 + 当前项勾选 + 添加/编辑
提供商入口）即时切换。点击时向后端请求最新模型选项（含自动发现的模型）再打开菜单。
