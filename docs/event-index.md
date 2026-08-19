# Indexed Event Store

`events-<session>.jsonl` 仍是唯一 durable source of truth。`src/event-index.ts` 维护可丢弃、可重建的
二级索引：

```text
session-dir/
  events-abc.jsonl
  event-index/
    events-abc.idx.jsonl
    events-abc.meta.json
```

每条 index entry 只记录 JSONL 的 byte offset / byte length / seq / ts / type / actor。查询 trace、
特定工具事件或 event type 时先过滤 index，再 `seek` 需要的行，而不是重新 parse 全部历史。

## Crash consistency

写入顺序固定：

```text
1. append authoritative event JSONL
2. append index entry
3. atomic replace index meta
```

索引任一步失败都不影响用户任务。后续 query 会比较 `meta.sourceBytes` 与 authoritative JSONL
字节数；不一致、index JSON 损坏、覆盖不完整时自动扫描 JSONL 重建。损坏的 source 行会作为
`valid=false` coverage entry 记录，因此 index 仍能描述完整 source byte range。

删除 session 时同步删除 index sidecar。content blobs/event sidecars 的生命周期仍由 EventLog 层负责。
