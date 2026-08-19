# Session Event Log

FreeSeek 的 `src/eventlog.ts` 是面向 replay / audit / fork 的 durable journal。当前版本仍保留 `session-<id>.json` 作为 UI 会话恢复的主快照；Event Log 已经承担统一审计和模型上下文投影，但尚未强行替换现有 SessionStorage。

## 设计不变量

### 每个 session 独立日志

日志实例按 `sessionId` 缓存，而不是只有一个“当前 UI 会话”的全局实例。用户切换到其它聊天时，仍在后台运行的旧 Agent 保留它原先捕获的 `SessionEventLog`，不会把后续事件写进新会话。

### 单调序号

`SessionEventLog` 初始化时读取已有 JSONL 的最大有效 `seq`，扩展重启后继续递增。损坏行会跳过，不把整个日志判废。

### 删除语义

删除会话时先 abort 对应后台 Agent，再关闭缓存的 `SessionEventLog` sink，最后删除 `events-<id>.jsonl` 与 `event-blobs/<id>/`。已捕获旧 sink 的异步任务在 close 后 append 会返回 `null`，不会把用户刚删除的审计数据重新创建出来。

### Actor 隔离

每条事件包含 `actor`：

```text
main
main/sub:researcher
main/sub:reviewer
...
```

主会话投影默认只读取 `actor=main`。子 Agent 的内部 message/tool 事件仍可审计，但不会被错误塞回主模型历史。

### 模型可见输入必须可投影

canonical durable 事件包括：

- `conversation/snapshot`
- `system/message`
- `user/message`
- `assistant/message`
- `tool/message`

`deriveConversationFromEvents()` 从最近的 snapshot 重置点开始，再应用后续 canonical message，得到某个 actor 的模型上下文投影。

Agent 在这些边界写 snapshot：

- `run_start`
- context `compact`
- context-window retry truncate

这样压缩或截断不会只存在于内存里。

### 工具审计属于 Runtime

工具生命周期由 ToolRuntime 写入：

- `tool/call`
- `approval/request`
- `approval/result`
- `tool_timeout`
- `tool/result`

message protocol 层由 Agent 写 `assistant/message` / `tool/message`。两层分开后既能重放模型历史，也能检查“为什么某个工具被执行/拒绝”。

## 大事件 sidecar

JSONL 单行超过阈值时，Event Log 不再静默截断原始 data，而是写入：

```text
event-blobs/<sessionId>/<seq>.json
```

JSONL 只保留 `dataRef`。`readSessionEvents()` 会校验 `dataRef` 不越出历史目录后自动还原。

## 多模态限制

当前 base64 图片不会复制进 JSONL。`messageForEventLog()` 会记录 `imageCount` 并设置 `replayable=false`；`deriveConversationFromEvents()` 因此返回 `complete=false`。

这意味着：

- 文本/tool-only 会话已具备 event projection 基础；
- 含图片的完整恢复仍必须依赖 `session-<id>.json`；
- 后续应把图片/附件写入 content-addressed blob store，再让 Event Log 只记录 hash/ref。

在这个缺口补齐前，不应把 Event Log 宣称为所有会话的唯一 source of truth。

## 下一阶段

Event Log 已为以下能力提供稳定边界：

1. crash recovery：session JSON 损坏时从完整 event projection 恢复；
2. fork：在某个 durable seq 建立子 session；
3. replay/debug：按 actor/step 重放模型输入与工具决策；
4. checkpoint correlation：把 workspace checkpoint id 与 tool/result/turn boundary 对齐；
5. eval trace：把同一任务的模型、工具步骤、审批、失败和最终 patch 作为可比较 trace。

下一步优先补 content-addressed attachment blob，再把 SessionStorage 的恢复路径逐步切到 Event Log；不要在 `complete=false` 时做有损恢复。
