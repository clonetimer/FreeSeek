# FreeSeek Web Console

FreeSeek Web Console 是 0.24.0 引入的第五个正式宿主：**本地回环 HTTP 服务 + 浏览器端**。它与 Desktop 同构——是 ACP 控制面的浏览器前端，不是第二个 Agent 实现：

```text
Browser ── HTTP/SSE ──▶ WebConsoleServer ── ACP client ──▶ freeseek-acp sidecar ──▶ 共享 Kernel
```

Agent 执行、工具、权限、MCP、Skills、EventLog 全部由 `freeseek-acp` 持有；Web Console 只做协议转换与投影。

## 启动

```bash
# 构建
npm ci && npm run compile

# 方式一：统一 CLI
freeseek web \
  --base-url https://api.deepseek.com \
  --model deepseek-v4-flash \
  --api-key "$DEEPSEEK_API_KEY" \
  --workspace /path/to/repo \
  --yes

# 方式二：独立 bin
freeseek-web --base-url http://127.0.0.1:1234/v1 --model local-model --auth-type none
```

启动成功后终端打印带令牌的访问地址：

```text
FreeSeek Web Console 已启动：http://127.0.0.1:3080/?token=<随机令牌>
```

在浏览器打开该地址即可使用。令牌即完整控制权（等同于本地 Agent），请勿泄露；服务默认仅监听 `127.0.0.1`。

## 常用参数

```text
--port <n>              监听端口（默认 3080）
--host <h>              监听地址（默认 127.0.0.1）
--workspace <dir>       Agent 工作区（默认当前目录）
--session-dir <dir>     durable session 目录（默认 ~/.freesek/web）
--yes                   自动批准工具权限（默认：浏览器端审批弹窗/ask_user 表单，0.25.0 起）
--allow-shell           开启 shell / code execution
--no-network            禁止网络工具
--enable-multi-agent    开放子代理工具
--skills-dir <dir>      追加技能目录（可重复）
--extension-dir <dir>   显式信任 General HMR extension 目录（可重复）
--context-planner <m>   off|v1|v1.1|v1.2（默认 off）
--agent-entry <file>    显式指定 freeseek-acp 入口（默认自动探测）
```

Provider 凭据也可走环境变量 `FREESEEK_BASE_URL` / `FREESEEK_API_KEY` / `FREESEEK_MODEL`，避免出现在进程参数里。

## HTTP API（令牌鉴权）

所有 `/api/*` 需要 `Authorization: Bearer <token>`（或 URL `?token=`），并做同源校验（拒绝跨源浏览器请求）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 浏览器 UI（需 token） |
| GET | `/api/health` | `{ ok, version, workspace }` |
| GET | `/api/sessions` | 当前工作区的会话列表 |
| POST | `/api/session/new` | `{ cwd? }` → `{ sessionId }` |
| POST | `/api/session/prompt` | `{ sessionId, text }` → `{ stopReason }`（阻塞到回合结束） |
| POST | `/api/session/cancel` | 取消进行中的回合 |
| POST | `/api/session/set_mode` | `{ sessionId, modeId }`（coder/craft/plan/ask） |
| POST | `/api/session/history` | `{ sessionId, cwd? }` → `{ updates, modeId }`（ACP session/load 历史回放） |
| GET | `/api/session/events?sessionId=` | SSE 实时事件流（`session/update` 投影） |
| POST | `/api/session/respond` | `{ sessionId, requestId, decision, form? }` → 浏览器端审批/ask_user 回传（0.25.0） |

## 能力边界

- 交互审批（工具权限弹窗、ask_user 表单）在浏览器端**已支持**（0.25.0 起）：回合运行时，`permission_request` / `elicitation_request` 通过 SSE 实时推送到浏览器；用户在界面点击「允许/拒绝」或填写表单后，结果经 `POST /api/session/respond` 回传并恢复回合。仍可用 `--yes` 跳过人工审批（全部自动批准）。
- 不支持编辑器原生能力（diff review、LSP、图片输入）；会话与工具证据仍完整保存在 ACP EventLog。
- 远程访问（非回环绑定）不在支持范围；需要远程使用时请在可信机器上运行并经你自己的反向代理/隧道接入。
- 会话持久化、MCP、Skills、HMR、Context Planner 等能力继承 ACP Host（见 `docs/acp.md`）。

## 与 dev:webview 的区别

`npm run dev:webview`（`scripts/webview-dev.mjs`）只是 VS Code Webview 前端的**调试预览器**（渲染界面 + 回放历史事件），不跑 Agent；Web Console 是完整的产品宿主（真实 Agent 回合）。两者不要混淆。
