# ACP Agent Server — 部署与使用说明

> 完整细节见 [../acp.md](../acp.md)。ACP 是标准 ACP v1 stdio 协议宿主；Desktop 与 Web Console 都经它复用同一 Kernel。

## 部署

**环境要求**：Node >= 18；可写 npm cache；Provider 凭据走环境变量（避免出现在进程 argv）。

**源码构建**：

```bash
git clone <source> && cd freeseek
npm ci
npm run compile            # 产出 dist/freeseek-acp.js
```

**启动**（stdout 只输出 NDJSON JSON-RPC，诊断写 stderr）：

```bash
export FREESEEK_BASE_URL=https://api.deepseek.com
export FREESEEK_API_KEY=...
export FREESEEK_MODEL=deepseek-v4-flash
freeseek acp
# 等价独立 bin：freeseek-acp
```

本地无认证服务可显式关闭鉴权：

```bash
freeseek-acp --base-url http://127.0.0.1:1234/v1 --model local-model --auth-type none
```

**安全默认**：shell 关闭（`--allow-shell`）；审批 fail-closed（`--yes` 自动批准）；网络开（`--no-network` 关）；
MCP 会话不持久化 command/env/secret（resume 须客户端重新提供）；stdout 纯净（协议独占）。

## 使用说明（ACP v1 方法）

Agent 侧：`initialize`（loadSession）、`session/new`、`session/prompt`、`session/cancel`、`session/list`、
`session/resume`、`session/load`、`session/close`、`session/set_mode`（coder/craft/plan/ask）。

客户端回调：`session/update`（流式消息/工具事件）、`session/request_permission`（工具审批）、`elicitation/create`（协商后）。

Host flags：`--session-dir`（默认 ~/.freesek/acp）、`--yes`、`--enable-multi-agent`、`--no-skills`、
`--skills-dir`、`--extension-dir`、`--extension-sandbox-policy`、`--context-planner`、`--verbose`。

**互操作**：`npm run acp:conformance`（协议一致性）、`npm run acp:interop:gate`（两个独立客户端证据门禁）。

## 能力边界（显式未支持项）

session/load 早期为 false（现支持）；image/audio prompt 内容不支持；远程 HTTP/WebSocket 传输不支持
（因此浏览器形态由 Web Console 宿主提供，而非 ACP 直连）；第三方客户端互操作认证需走 interop 门禁。