# CLI / Headless 部署与使用

构建后统一命令为 `freeseek`。

```bash
freeseek help
freeseek doctor --workspace /path/to/workspace
freeseek run --workspace /path/to/workspace --prompt "检查并修复测试"
freeseek sessions
freeseek replay <session-id> --limit 100
```

Provider 可用参数或环境变量配置：`FREESEEK_BASE_URL`、`FREESEEK_MODEL`、`FREESEEK_API_KEY`。本地无认证 Provider 可使用 `--auth-type none`。

安全默认：shell 默认关闭；需要时显式 `--allow-shell`。General HMR trust root 必须显式提供：

```bash
freeseek run \
  --workspace /repo \
  --prompt "执行任务" \
  --extension-dir /opt/freeseek/extensions
```

H4 policy：

```bash
freeseek run \
  --extension-dir /opt/freeseek/extensions \
  --extension-sandbox-policy /etc/freeseek/sandbox-policy.json \
  --workspace /repo --prompt "执行任务"
```

Headless 还支持 session resume/fork、MCP、skills、context planner 与 H3 extension management；完整参数以 `freeseek run --help` 为准。
