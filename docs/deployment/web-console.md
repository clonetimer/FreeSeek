# Web Console — 部署与使用说明

> 完整细节见 [../web-console.md](../web-console.md)。本册给出部署/使用的操作口径。

## 部署

**环境要求**：Node >= 18；可写 npm cache；一个 OpenAI 兼容 Provider（官方/本地/自托管均可）。

**源码构建**：

```bash
git clone <source> && cd freeseek
npm ci
npm run compile            # 产出 dist/freeseek-web.js 与 dist/freeseek-acp.js
```

**启动服务**（监听回环地址，默认端口 3080）：

```bash
freeseek web \
  --base-url https://api.deepseek.com \
  --model deepseek-v4-flash \
  --api-key "$DEEPSEEK_API_KEY" \
  --workspace /path/to/repo \
  --yes                    # 本地自用建议显式自动批准
```

或使用独立 bin：`freeseek-web --base-url ... --model ...`。

启动后终端打印：`http://127.0.0.1:3080/?token=<令牌>`。**令牌即完整控制权**，勿外泄。

**安全默认**：仅监听 127.0.0.1；所有 `/api/*` 需令牌；跨源浏览器请求被拒；不带 `--yes` 时权限请求按取消处理（fail-closed）。

## 使用说明

1. 浏览器打开带令牌的地址。
2. 左侧「+ 新会话」或直接输入（首次发送自动创建会话）。
3. 顶栏切换模式（Coder / Craft / Plan / Ask），「停止」可中断进行中的回合。
4. 左侧「刷新」拉取会话列表；点击历史会话即恢复并回放历史。
5. 会话与工具证据完整保存在 `--session-dir`（默认 `~/.freesek/web`）的 EventLog 中，可用 `freeseek replay` 离线查看。

**已知边界**：浏览器端暂无交互式权限弹窗 / ask_user 表单（未带 `--yes` 时相关工具会被取消）；无编辑器原生能力（diff/LSP/图片）。

## 配置参考（`freeseek web --help`）

`--port / --host / --workspace / --session-dir / --yes / --allow-shell / --no-network /
--enable-multi-agent / --no-skills / --skills-dir / --extension-dir /
--extension-sandbox-policy / --context-planner / --context-plan-budget / --agent-entry`