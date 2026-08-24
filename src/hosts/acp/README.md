# ACP Host

FreeSeek 0.19 的第三正式宿主：**stable ACP v1 stdio Agent Server**。所有工具执行仍复用 FreeSeek Kernel / ToolRegistry / ToolRuntime / EventLog。

## 已实现

- `initialize`
- `session/new` / `session/prompt` / `session/cancel`
- `session/list` / `session/resume` / `session/close`
- `session/set_mode`
- `session/update`
- `session/request_permission`
- capability-gated `elicitation/create` form
- stdio MCP、additionalDirectories、durable EventLog/session metadata

## M4 验证入口

- `npm run acp:conformance`：FreeSeek 自有 raw NDJSON 进程级 conformance；**不计作独立客户端互操作**。
- `npm run acp:interop -- ...`：包装真正的外部 ACP Client driver 并记录结构化证据。
- 外部互操作台账：`docs/project/ACP_INTEROP_MATRIX.md`。

## 0.19 非目标

远程 HTTP/WebSocket transport 不作为 0.19 stable 的协议依赖；本阶段只稳定 stdio。
