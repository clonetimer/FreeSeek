# Trace / Eval Harness

FreeSeek 的 eval 不另写 Agent。每个 case 复制一个隔离 workspace，然后调用与 CLI/VS Code 相同的：

```text
runAgent → ToolRegistry → ToolRuntime → EventLog
```

因此评测记录的工具权限、取消、checkpoint、模型请求与正常产品行为一致。

## Manifest

```json
{
  "name": "repo-smoke",
  "cases": [
    {
      "id": "add-healthcheck",
      "workspace": "./fixtures/service",
      "prompt": "增加 /health 路由并补测试",
      "allowShell": true,
      "checks": [
        { "type": "file_contains", "path": "src/server.ts", "text": "/health" },
        { "type": "tool_called", "name": "write_file", "min": 1 },
        { "type": "turn_reason", "reason": "completed" },
        { "type": "command", "argv": ["npm", "test"], "exitCode": 0 }
      ]
    }
  ]
}
```

支持的 checks：`file_exists`、`file_contains`、`file_not_contains`、`tool_called`、
`event_count`、`turn_reason` 与 argv-only `command`。命令检查默认禁用，必须显式
`--allow-check-command`；它不经过 shell，并使用最小环境变量集合。

## 运行

构建后：

```bash
freeseek-eval \
  --manifest evals/smoke.json \
  --base-url https://api.deepseek.com \
  --api-key "$DEEPSEEK_API_KEY" \
  --model deepseek-v4-flash \
  --allow-check-command
```

默认输出到 `~/.freesek/evals/`。报告不保存 API Key；每个 case 的 durable sessions/trace 会保留，
复制的 workspace 默认在报告生成后删除，可用 `--keep-workspaces` 保留。

## 指标

Trace 从 indexed EventLog 投影，不依赖 UI 回调：

- case pass/fail / pass rate；
- turn / step / model request 数；
- prompt/completion/total token；
- 模型累计延迟与错误数；
- tool call、blocked、timeout、每工具耗时；
- approval 请求/允许/拒绝；
- checkpoint / compact / fork 次数；
- turn 最终 reason/error。

用 `--compare <baseline-report.json>` 可产生本轮相对 baseline 的 pass-rate、token、steps、
tool calls、latency 等 delta。这里的目标是防止“Prompt 看起来更聪明，但真实成功率下降”的回归。

## 固定题库：FreeSeek Bench

当一次性 eval manifest 需要升级成版本化、可重复对比的长期回归集时，使用 `freeseek-bench`。它复用本页的 Eval Harness，但额外固定 suite fingerprint、case metadata、重复运行、类别/标签过滤、加权 correctness 与 Markdown/JSON 报告。参见 [benchmarks.md](benchmarks.md)。
