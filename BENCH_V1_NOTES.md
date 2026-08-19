# FreeSeek Bench v1 implementation notes

本轮在 Trace/Eval/Index 基线上新增一个版本化 Coding Benchmark 层：

- `src/bench.ts`：suite loader / validation / fingerprint / filtering / repeated runs / weighted scoring / budget diagnostics / report comparison；
- `src/bench-cli.ts`：`list` / `validate` / `run` / `compare`；
- `benchmarks/v1/manifest.json`：20 个公开离线回归任务；
- `benchmarks/v1/gold/**`：只用于 harness 自检，不复制给 Agent；
- `benchmarks/v1/schema.json`：稳定的 v1 数据格式；
- `docs/benchmarks.md`：运行与指标纪律。

设计原则：correctness 是主指标，成本/步数/延迟只做辅助；公开题库用于持续回归，不声称防训练污染。真实排行榜应接 private holdout / pinned real-repo 环境。
