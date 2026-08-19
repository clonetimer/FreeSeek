# DeepSeek V4 × FreeSeek Context Planner A/B

本实验用于用 DeepSeek 官方 OpenAI-compatible API 对 `Context Planner v1.1 → v1.2` 做真实模型 A/B。

## 默认实验条件

- Base URL: `https://api.deepseek.com`
- Model: `deepseek-v4-flash`
- Public suite: `context` category（4 cases）
- Baseline: `v1.1`
- Candidate: `v1.2`
- Repeat: `3`
- Planner budget: `1500`

DeepSeek V4 当前支持 `deepseek-v4-flash` 与 `deepseek-v4-pro`。V4 的 thinking mode 默认启用；FreeSeek 会在 assistant tool-call 轮次保留并回传 `reasoning_content`，同时写入 durable EventLog，保证后续轮次协议完整。

## 安全运行

凭据只使用环境变量。`bench:deepseek-context` 故意不接受 `--api-key`，避免 key 出现在 shell history 或进程 argv。

macOS / Linux:

```bash
npm ci
export DEEPSEEK_API_KEY="<your-key>"
npm run bench:deepseek-context -- --dry-run
npm run bench:deepseek-context
```

PowerShell:

```powershell
npm ci
$env:DEEPSEEK_API_KEY = "<your-key>"
npm run bench:deepseek-context -- --dry-run
npm run bench:deepseek-context
```

## 扩展验证

完整 Public：

```bash
npm run bench:deepseek-context -- --all-public
```

Pinned Real Repo：

```bash
npm run bench:deepseek-context -- --real
```

V4 Pro 小确认集：

```bash
npm run bench:deepseek-context -- --model deepseek-v4-pro --repeat 1
```

## 决策门

只有 correctness 持平或提升时，再把效率作为推广依据：

1. weighted score / strict pass 不下降；
2. `contextExploratorySearchCalls` 下降；
3. `contextUnplannedReadCalls` / `contextUnplannedMutationCalls` 不增加；
4. tokens / steps / tool calls 至少一项有稳定改善；
5. Private Holdout 与 Real Repo 无新增回归。

否则继续保持 `contextPlanner=off` 默认，并根据 Trace 归因。
