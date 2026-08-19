# FreeSeek ToolRegistry + Session Event Log 收拢说明

本轮以上一版 Tool Runtime Safety Reset 源码为基线，继续解决两个长期架构漂移点：**能力注册多份真相源**和**Session Event Log 无法可靠支撑后台/replay**。

## 已完成

### 1. ToolRegistry 成为每次 Agent run 的能力快照

新增 `src/tool-registry.ts`，每项注册同时持有：

- Provider `ToolDefinition`
- `ToolRuntimeSpec`
- source（builtin / MCP / connector / agent）
- executor

Registry 创建时检查重复名称、内置 spec 漂移，以及 Agent-native executor 缺失。schema 与 runtime spec 会冻结，run 中途外部对象修改不会改变当前能力集合。

Provider 工具 schema、并发调度、Runtime policy 与最终 body dispatch 都从同一个 Registry 读取。未注册工具不能执行。

### 2. Runtime 拥有 durable 工具审计

`tool/call`、通用/MCP `approval/*`、`tool_timeout`、`tool/result` 已移入 ToolRuntime。这样未来 CLI / Headless 直接复用 Runtime 时，不需要重新实现审计。

### 3. Session Event Log 改为 per-session + actor

修复旧的 process-global current log：UI 切换不再导致后台旧 Agent 后续事件写错 session。

- 每个 session 缓存独立 `SessionEventLog`；
- `seq` 从磁盘最大有效值续写；
- 子 Agent 使用独立 actor path；
- main replay 默认不混入 subagent 内部历史；
- 删除会话会先关闭 captured event sink 并清理 JSONL/sidecar，后台旧引用不能重新生成已删除日志。

### 4. canonical conversation projection

新增 canonical message events 与 `conversation/snapshot`。Agent 在 run start、compact、context retry truncate 后落快照；system/user/assistant/tool 消息继续追加。

`deriveConversationFromEvents()` 可从最新快照投影 main actor 上下文。含 base64 图片时显式 `complete=false`，避免把有损投影伪装成完整恢复。

### 5. 大事件使用 sidecar

超过 JSONL 单行阈值的数据写 `event-blobs/<session>/<seq>.json`，日志保存受约束的 `dataRef`。读取时验证路径 containment 后自动还原。

### 6. 工程门禁强化

`npm run check` 现在同时 strict typecheck `src` 与 `tests`，并强制：

```text
raw executeToolBody
      -> ToolRegistry.executeBody
      -> ToolRuntime.execute
```

其它模块直接碰 raw body / Registry body 都会让检查失败。

## 当前刻意没有做的事

`session-<id>.json` 仍是 UI 恢复的主快照，没有在本轮强行删除。原因是图片附件尚未迁移到 content-addressed blob；Event Log 对含图片历史会明确返回 `complete=false`。

因此当前定位是：**Event Log 已成为 durable audit + replay foundation，但不是所有多模态会话唯一存储。**

## 下一步推荐

1. attachment/blob store：图片与大附件用 SHA-256 内容寻址；
2. Event Log crash-recovery fallback：仅 `complete=true` 时从事件恢复；
3. durable turn/step boundary + checkpoint id correlation；
4. `fork(sessionId, seq)`；
5. Headless runner 直接依赖 ToolRegistry + ToolRuntime + Event Log，不依赖 VS Code UI；
6. trace/eval harness：同一 repo task 比较成功率、工具步数、token、审批和 patch。
