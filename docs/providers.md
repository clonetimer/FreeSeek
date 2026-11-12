# 多协议 Provider 接入

FreeSeek 通过 Provider 抽象层接入各种 AI 服务，支持 OpenAI Chat Completions、OpenAI Responses API、Anthropic Messages 和 Gemini generateContent。协议格式由 Provider 明确指定；现有 `openai` 配置继续表示 Chat Completions，不会自动迁移到 Responses。

## 支持的协议格式

| format | endpoint | 认证头 | 典型服务 |
| --- | --- | --- | --- |
| `openai` | `/chat/completions` | `Authorization: Bearer <key>` | DeepSeek / OpenRouter / 硅基流动 / Kimi / 通义 / 智谱 / 腾讯混元 / OpenAI Chat Completions / Ollama / LM Studio |
| `responses` | `/responses` | `Authorization: Bearer <key>` | OpenAI Responses API |
| `claude` | `/v1/messages` | `x-api-key: <key>` + `anthropic-version` | Anthropic Claude |
| `gemini` | `/v1beta/models/:model:generateContent` | `x-goog-api-key: <key>` | Google Gemini |

OpenAI 的 GPT-6.1 Sol 等推理模型应使用 `responses` 格式获得原生 function calling；其 Chat Completions 接口不提供同等的原生工具调用能力。若模型声明 `capabilities.tools:false`，FreeSeek 不会发送原生工具定义，而会切换到 ReAct 文本协议。

每个 Provider 项还支持：

- **`headers`**：自定义请求头（含 `${env:VAR}` 插值）。
- **`extraBody`**：额外请求体透传。
- **`authType`**：认证方式（`bearer` 等）。
- **`autoDiscoverModels`**：自动拉取 `/v1/models` 的全部已加载模型（LM Studio / Ollama 本地服务推荐开启，切换模型时实时刷新）。
- **`toolMode`**：`native`（原生 function calling）或 `react`（ReAct 文本协议）。模型显式声明 `capabilities.tools:false` 时自动降为 ReAct。
- **`capabilities`**：Provider 级默认能力声明，模型条目可用自己的 `capabilities` 覆盖。支持 `tools`、`vision`、`reasoning`、`structuredOutput`、`promptCaching`、`contextWindow`、`maxOutputTokens`、`inputModalities`、`outputModalities`。未声明表示 unknown，不会根据模型名称推断。
- **`storeResponses`**：仅对 `responses` 格式有效，默认 `false`。设为 `true` 才允许 OpenAI 服务端存储 Response 对象。

## Responses API 的本地优先策略

Responses adapter 使用 typed input/output items 和语义化 SSE 事件。FreeSeek 将工具调用映射为 `function_call` / `function_call_output`，实际执行仍由共享 ToolRuntime 负责。

- 默认发送 `store:false`，不使用远端 `conversation` 或 `previous_response_id`；本地 EventLog 是会话历史的唯一来源。
- 请求 `reasoning.encrypted_content`，并将需要续接的原始 output items 本地持久化，以支持无服务端状态存储的多轮推理。
- 只有显式设置 `storeResponses:true` 才允许服务端存储 Response 对象。
- `max_tokens` 会兼容映射为 Responses API 的 `max_output_tokens`；不透传 Chat Completions 的 `messages` 和 `stream_options` 字段。

示例：

```json
{
  "id": "openai-responses",
  "name": "OpenAI Responses",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "${env:OPENAI_API_KEY}",
  "format": "responses",
  "toolMode": "native",
  "storeResponses": false,
  "capabilities": {
    "tools": true,
    "vision": true,
    "reasoning": true,
    "structuredOutput": true,
    "contextWindow": 1050000,
    "maxOutputTokens": 128000,
    "inputModalities": ["text", "image"],
    "outputModalities": ["text"]
  },
  "models": [
    {
      "id": "gpt-6.1-sol"
    }
  ]
}
```

## 预设服务商

「添加提供商」向导（命令 `FreeSeek: 添加提供商`）提供常见预设，自动填充
Base URL / 协议格式 / 认证方式 / 模型：

DeepSeek / OpenRouter / 硅基流动 / Kimi / 通义 / 智谱 / 腾讯混元 /
OpenAI Responses / OpenAI Chat Completions / Ollama / LM Studio。仅「自定义」需要手动填写。

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
