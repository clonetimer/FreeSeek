# FreeSeek CLI

FreeSeek 0.18 将 CLI/Headless 作为与 VS Code 并列的正式宿主。CLI **不实现第二套 Agent**：`freeseek run` 仍走与扩展相同的 `runAgent → ToolRegistry → ToolRuntime → EventLog`，因此权限、审批、沙箱、checkpoint、Context Planner 与 durable session 语义一致。

## 安装与构建

源码构建：

```bash
npm ci
npm run compile
node dist/freeseek-headless.js help
```

如果使用发布的 npm tarball，可全局安装后直接调用：

```bash
npm install -g ./freeseek-copilot-0.18.0.tgz
freeseek help
```

Node.js 要求 `>=18`。

## 统一命令入口

```text
freeseek run ...       # Coding Agent / Headless
freeseek eval ...      # Eval Harness
freeseek bench ...     # Public/Private/Real benchmark + Context A/B
freeseek doctor ...    # 本地环境检查，不打印 API key
freeseek sessions ...  # durable sessions 列表
freeseek replay ...    # indexed EventLog 回放
```

为兼容 0.17.x，`freeseek --prompt ...` 仍等价于 `freeseek run --prompt ...`；`freeseek-eval` 和 `freeseek-bench` 独立命令继续保留。

## 运行 Coding Agent

推荐把凭据放进环境变量，避免 API key 出现在 shell history / process argv：

```bash
export FREESEEK_BASE_URL=https://api.deepseek.com
export FREESEEK_API_KEY=...
export FREESEEK_MODEL=deepseek-v4-flash

freeseek run \
  --workspace ./my-project \
  --prompt "修复测试失败并运行验证"

# 长任务也可从 stdin 读取
printf %s "请检查整个仓库并修复失败测试" | freeseek run --workspace ./my-project --prompt -
```

默认安全策略：

- shell/代码执行关闭；只有 `--allow-shell` 才开放，并继续经过 Runtime / ExecPolicy / sandbox；
- 需要审批的写入和高风险能力默认 fail-closed；`--yes` 才自动批准；
- 网络默认允许，可用 `--no-network` 关闭；
- Context Planner 默认 `off`；可显式 `--context-planner v1.2`；
- durable session 默认写入 `~/.freesek/headless`。

## 恢复与历史分叉

继续完整 durable session：

```bash
freeseek run --resume <session-id> --prompt "继续完成剩余工作" ...
```

从历史 event 边界分叉：

```bash
freeseek run \
  --fork <source-session-id> \
  --at <event-seq> \
  --prompt "从这个历史状态尝试另一种实现" ...
```

fork 必须存在 checkpoint anchor。FreeSeek 会把历史 shadow checkpoint 物化到隔离工作区，不会拿旧对话继续操作当前代码。

## Session 与 EventLog

列出 session：

```bash
freeseek sessions
freeseek sessions --json
freeseek sessions --session-dir /path/to/sessions --json
```

回放最后 50 个事件：

```bash
freeseek replay <session-id>
freeseek replay <session-id> --limit 200
freeseek replay <session-id> --type tool/result
freeseek replay <session-id> --json
```

这些命令读取 byte-offset event index；JSONL 仍是 authoritative source，索引失配时会重建。

## Doctor

```bash
freeseek doctor
freeseek doctor --workspace ./repo --json
```

`doctor` 检查 Node、workspace、Git，以及 Provider 环境变量是否齐全。API key 只报告“已设置/未设置”，不会输出值。

## Eval 与 Bench

统一入口：

```bash
freeseek eval --manifest suite.json --base-url ... --model ...
freeseek bench list
freeseek bench validate --gold
freeseek bench context-retrieval
freeseek bench ab-context --baseline-planner v1.1 --candidate-planner v1.2 ...
```

独立兼容入口 `freeseek-eval` / `freeseek-bench` 语义相同。

## Context Planner 稳定策略

0.18.0 包含 v1/v1.1/v1.2，但默认仍为 `off`。当前真实 DeepSeek v1.1→v1.2 A/B 显示正确率不退化且 token/tool/step 更低，但墙钟时间略升；在 Public + Private Holdout + pinned Real Repo 的推广门禁全部满足前，不把实验结论扩大为全局默认。
