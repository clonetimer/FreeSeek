# Eval / Bench — 部署与使用说明

> 完整细节见 [../evals.md](../evals.md) 与 [../benchmarks.md](../benchmarks.md)。Eval/Bench 复用 Headless 运行链，不是独立 Agent。

## 部署

**环境要求**：Node >= 18；npm cache 可写；Provider 凭据（真实模型评测需要）。

**源码构建**：

```bash
git clone <source> && cd freeseek
npm ci
npm run compile            # 产出 dist/freeseek-eval.js 与 dist/freeseek-bench.js
```

## 使用说明

**Eval**（真实内核回归，指标从 durable EventLog 投影）：

```bash
freeseek eval --manifest suite.json --base-url ... --model ...
# 兼容独立入口：freeseek-eval
```

manifest 支持 checks：`file_exists` / `file_contains` / `file_not_contains` / `tool_called` /
`event_count` / `turn_reason` / argv-only `command`（需显式 `--allow-check-command`）。

**Bench v1**（公开回归集，20 个离线任务）：

```bash
freeseek bench list
freeseek bench validate --gold          # 自检题库可解性
freeseek bench context-retrieval        # 不花 token 的 Planner Hit@K/MRR
freeseek bench run --base-url ... --api-key ... --model ...
freeseek bench ab-context --baseline-planner v1.1 --candidate-planner v1.2 ...
```

**Bench v2**（private holdout + 固定真实仓库）：

```bash
freeseek bench init-holdout --out <仓库外目录>
freeseek bench list --real
freeseek bench validate --real --gold   # 固定完整 commit SHA；--offline-sources 防漂移
```

## 边界

- 主指标 = 加权 resolved rate；token/steps/tool calls/duration 单独报告，不混合成可刷综合分。
- 公开 `benchmarks/v1` 不宣称防训练污染；private pack 必须位于公开仓库外，report 默认脱敏。
- command checks argv-only 且显式 opt-in；host verifier 位于 Agent workspace 外。