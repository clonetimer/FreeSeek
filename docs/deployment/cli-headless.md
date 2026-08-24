# CLI / Headless — 部署与使用说明

> 完整细节见 [../cli.md](../cli.md)。CLI/Headless 是与 VS Code 并列的一等宿主，复用同一 `runAgent → ToolRegistry → ToolRuntime → EventLog`。

## 部署

**环境要求**：Node >= 18；可写 npm cache；Provider 凭据走环境变量。

**源码构建**：

```bash
git clone <source> && cd freeseek
npm ci
npm run compile            # 产出 dist/freeseek-headless.js（freeseek bin）
```

**npm 全局安装（可选）**：`npm install -g ./freeseek-copilot-<ver>.tgz` 后即可直接 `freeseek ...`。

**安全默认**：

- shell/代码执行默认关闭，需 `--allow-shell`，且继续经 Runtime/ExecPolicy/sandbox。
- 需要审批的写入与高风险能力默认 fail-closed；`--yes` 自动批准。
- 网络默认开启；`--no-network` 关闭。
- Context Planner 默认 `off`；`--context-planner v1.2` 显式开启。
- durable session 默认写入 `~/.freesek/headless`。

## 使用说明

统一命令入口 `freeseek`（0.17.x `freeseek --prompt ...` 仍等价 `freeseek run ...`）：

```bash
freeseek run --workspace ./my-project --prompt "修复测试失败并运行验证"
freeseek run --workspace . --prompt "检查并修复" --allow-shell --yes
freeseek doctor                     # 本地环境检查（不打印 key）
freeseek sessions                   # 列出 durable sessions
freeseek replay <session-id>        # 回放 EventLog
freeseek run --resume <id> --prompt "继续"          # 恢复完整会话
freeseek run --fork <id> --at <seq> --prompt "换个实现"  # 历史分叉（需 checkpoint）
freeseek web ...                    # 启动 Web Console（0.24+）
freeseek acp ...                    # 启动 ACP Server
freeseek eval / freeseek bench ...  # 评测 / 基准
```

长任务可从 stdin 读：`printf %s "…" | freeseek run --workspace . --prompt -`。

Headless flags：`--interactive`（交互式审批）、`--enable-multi-agent`、`--skills-dir`、
`--extension-dir`、`--extension-manage`、`--extension-sandbox-policy`、`--mcp-config`、
`--context-planner`、`--auth-type none|bearer|...`、`--format openai|claude|gemini`、`--tool-mode native|react`。