# Persistence + Headless Kernel

FreeSeek 的持久化层现在由“会话快照”逐步迁移为 **Event Log + Content Store + Workspace Timeline**。VS Code UI 仍可保留现有 session JSON 作为兼容快照，但核心 Agent 已能在没有 VS Code runtime 的 Node 进程中恢复、执行和分叉。

## 1. Durable 数据布局

典型 Headless session 目录：

```text
<session-dir>/
├── events-<session-id>.jsonl          # append-only canonical event journal
├── event-blobs/<session-id>/...       # 超大 event data sidecar
├── content-blobs/sha256/ab/<digest>.blob
│                                      # 图片/附件的共享内容寻址存储
├── checkpoints/<workspace-id>/
│   ├── shadow-git/                    # 不接触用户 .git 的 workspace 快照
│   └── checkpoint-events.jsonl        # shadow commit ↔ session/event seq
└── fork-workspaces/<fork-session-id>/ # Headless historical fork 的隔离工作区
```

### Content-addressed blobs

`src/content-store.ts` 使用 SHA-256 作为内容主键：

- 相同图片只保存一次；
- EventLog 只保存 digest/长度/MIME 等引用，不重复塞 base64；
- 读取时重新计算 SHA-256 与长度，损坏或缺失即 fail-closed；
- 删除会话后会扫描其余 EventLog，回收没有任何 session 引用的 blob；共享 blob 保留。

因此多模态会话可以得到 `complete=true` 的 canonical replay，而不再依赖 JSONL 中的大段 base64。

## 2. Canonical Event 生命周期

Agent 主循环写入：

```text
turn/start
  checkpoint               # main actor 的 turn baseline（autoCheckpoint 开启时）
  conversation/snapshot
  step/start
    assistant/message
    tool/call
    approval/request?
    approval/result?
    checkpoint?            # pre-edit safety snapshot
    tool execution
    checkpoint?            # post-state timeline snapshot
    tool/result
    tool/message
  step/end
turn/end
```

异常路径也要求闭合：若 Provider、压缩或工具执行在一个已开始的 step 中抛错，Agent 先写 `step/end(error)`，再写 `turn/end(error|aborted)`。这保证 trace/replay 不出现悬空 step。

`actor` 区分 `main` 与子 Agent。默认模型恢复只投影 main actor；子 Agent 内部事件仍可审计，但不会污染主 Agent 上下文。

## 3. Crash recovery

`deriveConversationAtSeq()` 从最近的 `conversation/snapshot` 加后续 canonical message events 投影模型历史：

```text
snapshot
  + system/message
  + user/message
  + assistant/message
  + tool/message
      ↓
ChatMessage[]
```

只有在所有所需 blob 都存在且哈希校验通过时，projection 才返回 `complete=true`。

`SessionStorage` 的恢复策略为：

1. 活跃后台 buffer；
2. session JSON 兼容快照；
3. JSON 缺失/损坏时，仅在 EventLog projection `complete=true` 时恢复；
4. incomplete 时拒绝“猜测恢复”，避免静默丢图片/工具上下文。

## 4. Workspace timeline

`src/workspace-timeline.ts` 是代码时间线写入的统一入口。它把：

```text
shadow Git commit
    ↕
checkpoint event seq
```

绑定在一起。

当前会创建三类关键锚点：

- **turn baseline**：main actor 每个 turn 开始时；
- **pre-edit checkpoint**：文件修改前，主要用于安全 rewind；
- **post-state checkpoint**：write/execute/destructive 工具和 formatter 完成后，用于精确历史 fork。

Shadow Git 使用独立 `GIT_DIR` / index，不触碰用户的 branch、index、stash 或 `.git`。

> 限制：shadow checkpoint 当前尊重项目 `.gitignore`。被忽略的大型构建产物/秘密文件不会进入历史物化结果。外部数据库、远程 API 等副作用也不可能由 Git checkpoint 回滚。

## 5. Historical fork

`forkSessionEventLog(dir, source, target, seq)` 会：

1. 读取 `seq` 及之前的 source events；
2. 要求 canonical projection 完整；
3. 找到不晚于该边界的最近 `checkpoint` event；
4. 新 target session 写入 `session/fork` 与 canonical snapshot；
5. 返回 checkpoint anchor（hash/workspaceRoot/eventSeq）。

Headless CLI 对 fork 采用更严格语义：**对话状态和代码状态必须一起分叉**。如果没有 workspace checkpoint，它会拒绝创建“历史对话 + 当前代码”的混合状态。

存在 checkpoint 时，`materializeCheckpoint()` 使用临时 shadow Git index 把历史 commit 写到：

```text
<session-dir>/fork-workspaces/<target-session-id>/
```

源工作区完全不修改。

## 6. Headless runner

构建后：

```bash
npm run vscode:prepublish
node dist/freeseek-headless.js \
  --prompt "修复 failing test" \
  --base-url https://api.deepseek.com \
  --api-key "$DEEPSEEK_API_KEY" \
  --model deepseek-v4-flash \
  --workspace /path/to/repo \
  --session-dir ~/.freesek/headless \
  --yes
```

或安装 package 后使用 `freeseek` bin。

### 安全默认值

- 默认 **不允许 shell/code execution**；必须显式 `--allow-shell`；
- 文件写与 shell 是独立 capability：不开 shell 不会强制整个 workspace 只读；
- 需要人类审批的工具默认 fail-closed；非交互 CI 只有显式 `--yes` 才自动批准；
- `--no-network` 阻止 Runtime 标记为网络能力的工具/connector；
- Headless 仍复用同一个 `ToolRegistry → ToolRuntime → EventLog`，没有第二套权限实现。

### Resume

```bash
freeseek ... --resume <session-id> --prompt "继续"
```

只有 complete EventLog 才允许恢复。

### Fork

```bash
freeseek ... \
  --fork <source-session-id> \
  --at <event-seq> \
  --session-id experiment-b \
  --prompt "从这个节点尝试另一种实现"
```

Fork 会自动切换到隔离 historical workspace。

## 7. 无 VS Code 启动依赖

Agent 核心路径不再在模块加载时静态 import `vscode`：

- provider settings 改为可注入 host；
- debug output 可注入 channel；
- formatter/LSP/SecretStorage 等 VS Code 能力按需懒加载；
- 无对应宿主能力时明确降级，而不是 `require("vscode")` 直接崩溃。

VS Code Extension 仍是完整宿主；Headless 是同一内核的第二个宿主。

## 8. 测试/CI

`scripts/test.mjs`：

1. 优先使用 esbuild 快速 bundle；
2. 若 `node_modules` 来自其它平台、esbuild 原生二进制不可用，自动 fallback 到 `tsc emit + node:test`；
3. fallback 与正常 runner 都以仓库根为静态资源定位基准。

这使安全回归不再绑定某一操作系统的 esbuild 二进制。

## 9. 下一步

这层完成后更值得继续的是：

- EventLog sparse index / 大日志增量读取；
- content blob quota、LRU/retention 与显式 export/import；
- Fork UI（conversation + workspace diff + restore/branch）；
- Headless 多 Provider/MCP 配置文件，而非仅 CLI OpenAI-compatible 参数；
- remote sandbox / container execution provider；
- 基于 durable trace 的 eval harness、record/replay 与失败聚类。
