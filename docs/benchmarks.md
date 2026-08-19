# FreeSeek Coding Benchmark

`freeseek-eval` 是通用评测执行器；`freeseek-bench` 在其上增加稳定题库 schema、重复运行、类别/标签过滤、权重评分、预算观测、suite fingerprint 和 baseline comparison。

## 为什么单独有 Bench

通用 eval 可以临时写一个 manifest，但长期优化 Agent 需要固定、版本化的数据集。FreeSeek Bench v1 因此把以下三层分开：

```text
Benchmark Dataset
    ↓
Eval Harness
    ↓
Headless → Agent → ToolRegistry → ToolRuntime → EventLog
```

题库不实现另一套 Agent，验证结果仍来自真实 FreeSeek 内核。

## CLI

列任务：

```bash
freeseek-bench list
freeseek-bench list --category context
freeseek-bench list --tag path-traversal
```

验证内置题库与 gold：

```bash
freeseek-bench validate --gold
```

运行全部公开 v1：

```bash
freeseek-bench run \
  --base-url https://api.deepseek.com \
  --api-key "$DEEPSEEK_API_KEY" \
  --model deepseek-v4-flash
```

做三次稳定性采样：

```bash
freeseek-bench run --repeat 3 \
  --base-url "$FREESEEK_BASE_URL" \
  --api-key "$FREESEEK_API_KEY" \
  --model "$FREESEEK_MODEL"
```

只跑一个类别：

```bash
freeseek-bench run --category security ...
```

对比两个报告：

```bash
freeseek-bench compare \
  --baseline ~/.freesek/bench/bench-OLD.json \
  --candidate ~/.freesek/bench/bench-NEW.json
```


## Context Planner 实验层

Context Planner 的开发分成两个阶段，避免一上来就花模型 token：

1. **retrieval-only**：`freeseek-bench context-retrieval` 比较 v1/v1.1 的 Hit@K、MRR 与 `ranking_miss / dependency_miss / budget_overflow / retrieval_miss`；
2. **model-level A/B**：确认检索机制值得保留后，再用 `ab-context` 对完全相同的 suite/filter/repeat 比较真实 Agent correctness 与效率。

```bash
freeseek-bench context-retrieval --context-plan-budget 1500

freeseek-bench ab-context \
  --baseline-planner v1 \
  --candidate-planner v1.1 \
  --base-url "$FREESEEK_BASE_URL" \
  --api-key "$FREESEEK_API_KEY" \
  --model "$FREESEEK_MODEL" \
  --repeat 3
```

Retrieval-only 结果只用于决定“下一步改 ranking、index、dependency 还是 budget”；它不能单独决定默认开关。

## 安全边界

内置 `benchmarks/v1` 与 `benchmarks/real-v1` 是仓库随代码审查发布的可信 verifier。外部 suite 不会自动执行 command/host verifier；必须显式传 `--trust-suite`（旧 `--allow-check-command` 作为兼容别名保留）。

所有 case workspace 会先复制到临时目录，Agent 不直接修改 fixture。默认运行结束后删除复制工作区，但 durable session/trace/report 留在输出目录；调试时使用 `--keep-workspaces`。

## Fingerprint

报告包含 `suiteFingerprint`。它对 manifest 原文与所有 workspace 文件内容做 SHA-256，因此修改 prompt、测试、源码 fixture 都会改变 fingerprint。

对比报告会分别标记：

- `sameSuiteFingerprint`：题库内容是否完全相同；
- `sameSelection`：实际选择的 case 是否相同；
- `sameRepeat`：重复次数是否相同。

正确率比较应优先要求前两者为 true；效率差值按 attempt 归一化，因此 repeat 不同仍可观察，但正式实验最好保持参数一致。

## 指标纪律

主指标只有 `weightedScore` / resolved rate。效率和成本不混进 correctness 分数，而是作为独立 delta：

- average tokens per attempt；
- average steps per attempt；
- average tool calls per attempt；
- average duration per attempt。

每个 case 可声明 `budget`，目前预算只作为诊断护栏并报告 `budgetPassRate`，不会把“正确但稍贵”的任务直接判成错误。

## 三层开发方式

公开 micro-repo v1 继续保持小而快，用于每次 PR 的执行内核回归；它不等价于真实大型仓库泛化能力。

Bench v2 已补充两层：仓库外 `visibility=private` holdout，以及 `benchmarks/real-v1` 的 immutable Git source 历史任务。两者的 source/cache/redaction/trust 规则见 [bench-v2-holdout-real.md](bench-v2-holdout-real.md)。需要完整依赖环境的真实任务仍应逐步迁往 Docker/Remote Sandbox。

## 设计参考

FreeSeek Bench 不试图复制 SWE-bench 的排行榜。它借鉴的是两个工程原则：

- SWE-bench：真实 issue + 可复现隔离执行环境，强调 patch 最终必须由测试判定；
- SWE-smith：任务构造需要先证明初始状态会破坏测试，再证明存在有效修复。

因此 v1 先用轻量 public micro-repo 做每次 PR 都能跑的快速回归；后续 real-repo/holdout 层再通过 Docker 或 Remote Sandbox 固定仓库 commit 与依赖环境。


## DeepSeek V4 Context A/B

当前官方 OpenAI-compatible base URL 为 `https://api.deepseek.com`。FreeSeek 的推荐回归模型为 `deepseek-v4-flash`；`deepseek-v4-pro` 可用于较小确认集。凭据只通过环境变量传入：

```bash
export DEEPSEEK_API_KEY="<your-key>"
npm run bench:deepseek-context -- --dry-run
npm run bench:deepseek-context
```

默认实验固定为 Public `context` 类别、`v1.1 -> v1.2`、repeat=3、Planner budget=1500。脚本故意不支持 `--api-key`，避免密钥进入 shell history / argv。可用 `--all-public` 扩到完整公开集，或 `--real` 运行 pinned real-v1。
