# FreeSeek — Trace/Eval + Indexed Event Store + Remote Sandbox Seam

本轮在 Persistence + Headless Kernel 之上完成：

1. **Indexed Event Store**：JSONL source-of-truth + 可重建 byte-offset sidecar，支持按 actor/type/seq seek。
2. **Durable model/tool telemetry**：`model/request` / `model/result` 记录模型、attempt、token、latency/error；`tool/result` 记录 durationMs。
3. **Trace projection**：从 indexed durable events 汇总 token、steps、latency、tool/approval/timeout/checkpoint 等指标。
4. **Eval Harness**：隔离复制 workspace，复用真实 Headless Kernel，声明式 checks，稳定 JSON report 与 baseline delta。
5. **OpenAI usage 修复**：`stream_options.include_usage` 常见的 `choices: []` 最终 usage chunk 现在不会再被提前 continue 丢失。
6. **Headless IO 注入**：Eval 可以复用 Headless 而不污染报告 stdout，也不复制 Agent 实现。
7. **Remote Sandbox provider seam**：显式 remote workspace mapping + JSON/HTTP transport；不假装本地 cwd 自动存在远端。
8. **测试 runner/build**：新增 `freeseek-eval` bundle/bin；smoke 会检查 Headless 与 Eval CLI 产物。

原则：eval 只观察 durable truth，不把 UI callback 当统计真相；index 永远可丢弃，JSONL 永远 authoritative；远程执行不能模糊 workspace 语义。
