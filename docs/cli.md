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

Node.js 要求 `>=22.0.0`；CI 持续验证 Node 22、24、26。

## 统一命令入口

```text
freeseek run ...       # Coding Agent / Headless
freeseek eval ...      # Eval Harness
freeseek bench ...     # Public/Private/Real benchmark + Context A/B
freeseek acp ...       # ACP v1 stdio Agent Server（0.19 Stable）
freeseek web ...       # 本地 Web Console（浏览器端，0.24；0.25 支持浏览器审批，见 docs/web-console.md）
freeseek doctor ...    # 本地环境检查，不打印 API key
freeseek sessions ...  # durable sessions 列表
freeseek replay ...    # indexed EventLog 回放
freeseek-sdk ...       # 官方 SDK CLI（0.25；run/acp/version，见 docs/sdk.md）
```

为兼容 0.17.x，`freeseek --prompt ...` 仍等价于 `freeseek run --prompt ...`；`freeseek-eval` 和 `freeseek-bench` 独立命令继续保留。0.19 另提供独立 `freeseek-acp` bin，与 `freeseek acp` 路由到同一 ACP Host；0.24 提供独立 `freeseek-web` bin，与 `freeseek web` 路由到同一 Web Console 宿主；0.25 提供独立 `freeseek-sdk` bin，与 SDK 库入口（`require("freeseek")`）共享同一导出面。

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
- 需要审批的写入和高风险能力默认 fail-closed；`--yes` 才自动批准；`--tui`（0.25.0）可交互式逐条批准/拒绝；
- 网络默认允许，可用 `--no-network` 关闭；
- Context Planner 默认 `off`；可显式 `--context-planner v1.2`；
- durable session 默认写入 `~/.freesek/headless`。

## 0.26.0 新能力

### 插件加装（`freeseek plugin add / remove / list`）

对标 `dsh plugin --profile web add <spec>` 的插件形态（完整文档见 `docs/plugin.md`；运行时见 `src/plugin.ts` / `src/plugin-cli.ts`）：

```bash
freeseek plugin add @scope/pkg@1.2.3   # npm registry（npm pack + tar 解包）
freeseek plugin add github:user/repo   # git clone --depth 1
freeseek plugin add file:./my-kit      # 本地目录直取
freeseek plugin remove my-kit          # 依 .agent/kits.json 注册表逆操作
freeseek plugin list --json            # 已安装套件与皮肤
```

- spec 语法：裸 `@scope/pkg@ver` 默认按 npm registry；显式 `npm:`、`git:`（含 `github:user/repo` 短路径）、`file:` / 绝对路径本地目录。
- 落地复用 kits 的 `installKit` / `uninstallKit`：把 skills / commands / agents / themes 安装到项目 `.agent/`，并在 `.agent/kits.json` 登记，卸载可逆。
- 套件可声明 `themes`（CSS 变量覆盖），安装后落到 `.agent/themes/<name>.css`；Web Console / VS Code 设置面板主题下拉动态包含已安装皮肤。

## 0.25.0 新能力

### 交互式终端 TUI（`--tui`）

`--tui` 启用增量式终端 UI：流式渲染回合事件（工具调用、消息、审批请求），键盘交互式处理
权限审批与 ask_user 表单，不再依赖 `--yes` 一把梭。仅在 stdout 是 TTY 时生效；非 TTY（管道/CI）
自动降级为普通流式输出，行为与 0.24 一致。

```bash
freeseek run --workspace ./my-project --prompt "..." --allow-shell --tui
```

### 声明式执行策略（`--exec-policy`）

`--exec-policy <policy.json>` 加载 ExecPolicy DSL 文档（DSL 完整规范见 README.md「0.25.0 Stable — 补齐的 5 项缺口」一节的声明式策略示例，或 `src/sandbox.ts` 的 `compileExecPolicy` / `ExecPolicyDocument` 类型），
覆盖 `run_command` 的默认审批决策。未传该参数时行为与 0.24 完全一致（走 Runtime 默认 approval / sandbox）。

策略文档结构（`version` 必填，缺失/非法即报错；`default` 缺失时 fail-closed 为 `"ask"`）：

```json
{
  "version": 1,
  "default": "deny",
  "rules": [
    { "when": { "cmd": "npm test" }, "tier": "allow" },
    { "when": { "effect": ["destructive"] }, "tier": "deny" },
    { "when": { "regex": "^git .*" }, "tier": "allow" }
  ]
}
```

档位 `tier`：`allow | deny | ask | sandbox | readonly`；`when` 支持 `cmd`（精确）、`regex`、
`effect`（`read|write|net|destructive|neutral`）、`os`（`win32|darwin|linux`）、`network`
（`off|localhost|allow`），规则按数组顺序首条命中胜出。

```bash
freeseek run --workspace ./my-project --prompt "..." --exec-policy ./policy.json
```

策略在 Runtime 统一审批链之后、工具执行之前裁决，仅作增量 gate；不改变 `--sandbox` 的执行位置。

### 远程沙箱（`--sandbox remote:*`）

`run_command` 可在远端执行（0.25.0 落地三态 transport，见 `docs/remote-sandbox.md`）：

```bash
freeseek run --workspace ./my-project --prompt "..." \
  --sandbox remote:docker@my-container     # Docker 容器

freeseek run --workspace ./my-project --prompt "..." \
  --sandbox remote:ssh@user@my-host        # SSH 远端主机

export E2B_API_KEY=...                     # E2B 云沙箱
freeseek run --workspace ./my-project --prompt "..." \
  --sandbox remote:e2b@<sandbox-id>
```

`sandbox` 取值：`off | readonly | sandbox | remote:<docker|ssh|e2b>@<target>`。前三个为既有本地模式。

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
