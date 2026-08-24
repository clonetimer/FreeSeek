# ACP Agent Server 部署与使用

FreeSeek ACP 是 NDJSON JSON-RPC over stdio 的 ACP v1 Host，stdout 只输出协议，诊断写 stderr。

```bash
freeseek acp \
  --base-url http://127.0.0.1:8000/v1 \
  --model your-model \
  --auth-type none
```

或直接运行：

```bash
freeseek-acp --base-url <url> --model <id>
```

常用 Host 参数：`--session-dir`、`--yes`、`--enable-multi-agent`、`--skills-dir`、`--extension-dir`、`--extension-sandbox-policy`、`--allow-shell`、`--no-network`、`--context-planner`。

General HMR 管理操作使用 FreeSeek vendor namespace，不修改 ACP v1 标准 session 协议。一个 ACP 进程拥有一个共享 Extension Host/Watcher，但每个 Agent run 仍获取自己的 immutable generation lease。
