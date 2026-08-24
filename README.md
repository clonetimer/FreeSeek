# FreeSeek — 本地优先、模型无关的 Coding Agent

FreeSeek 是一个**宿主无关的 Agent Kernel**。VS Code、CLI/Headless、ACP 与 Standalone Desktop 复用同一 `ToolRegistry → ToolRuntime → EventLog`；当前 `0.26.0 (Stable)` 主线在 0.25.0 之上新增**插件加装与套件皮肤**（plugin ecosystem，见下），0.25.0 已在 0.24.0 之上补齐相对 codex / deepseek-harness 的 5 项可见缺口，仍不复制 Agent/Kernel。

- **FreeSeek for VS Code（Stable）**：编辑器原生 selection/diff/LSP/审批与会话 UI。
- **FreeSeek CLI / Headless（Stable）**：终端、CI、Bench、自动化与 durable session。
- **FreeSeek ACP Agent Server（Stable）**：标准 ACP v1 stdio 协议宿主，已经过独立客户端互操作门禁。
- **FreeSeek Desktop（0.21 RC1 UI 已冻结）**：Electron Shell → ACP → shared Kernel；renderer 无 Node/ToolRuntime 权限，Stable promotion 仍等待原生 Windows 证据。
- **Provider-agnostic**：支持 OpenAI-compatible / DeepSeek / Claude / Gemini 等 Provider；模型身份不写死在 Kernel。
- **Local-first / auditable**：权限、sandbox、checkpoint、EventLog、trace/eval/bench 都在本地可审计。
- **General HMR Runtime（0.22 完成，0.23 保持）**：generation lease + reversible lifecycle + trusted Tool/Connector package HMR；只在 Agent run boundary 原子切换，不修改运行中的 ToolRegistry。

`deepseek-free-api` 网页兼容适配仍可作为**实验性、显式启用的 Provider**使用，但不再定义 FreeSeek 的产品身份；核心架构与其他 Provider 解耦。

架构与交互形态详见 [docs/product-surfaces.md](docs/product-surfaces.md)，Context Planner 详见 [docs/context-planner.md](docs/context-planner.md)。

## 0.25.0 Stable — 补齐的 5 项缺口

相对 codex / deepseek-harness 的差距清单，0.25.0 全部落地：

| # | 缺口 | 0.25.0 实现 | 关键入口 |
| --- | --- | --- | --- |
| 1 | 交互式终端（TUI） | 全交互会话视图：实时流式渲染 + 工具进度 + 键盘审批（`y/N`/Enter） | `node dist/freeseek-headless.js --tui`；`src/tui.ts` |
| 2 | 声明式命令策略语言 | 对标 codex execpolicy 的 DSL：`default` + 规则集（按 cmd/正则/effect/os/network 判定 allow/deny/ask/sandbox/readonly 五档） | `src/sandbox.ts`（`compileExecPolicy`）；`--exec-policy policy.json` |
| 3 | 远程/云沙箱 provider | 三种可落地 transport：本地 Docker（`docker exec`）、SSH 远端、E2B 云沙箱，经 `seam.setCommandRunner` 注入 | `src/remote-sandbox.ts`；`--sandbox remote:docker@<c>` / `remote:ssh@<host>` / `remote:e2b@<id>` |
| 4 | 浏览器端审批与 ask_user 表单 | Web Console 把审批/表单经 SSE 推到浏览器，浏览器弹窗 + 结构化表单回传 | `src/hosts/web/console.ts`、`ui.ts`；`freeseek-web --experimental` |
| 5 | 官方 SDK（TS） | 稳定再导出 `runAgent / ToolRegistry / ToolRuntime / sandboxes / policy / acp`，含 `freeseek-sdk` CLI | `src/sdk.ts`、`src/sdk-cli.ts`；`require("freeseek")` / `import "freeseek"` |

**声明式策略示例**（`policy.json`）：

```json
{
  "version": 1,
  "default": "ask",
  "rules": [
    { "when": { "effect": ["destructive"] }, "tier": "deny", "reason": "禁止破坏性命令" },
    { "when": { "cmd": "git status" }, "tier": "allow" },
    { "when": { "regex": "^npm (i|install)$" }, "tier": "sandbox", "reason": "依赖安装强制沙箱" },
    { "when": { "network": ["off"], "effect": ["net"] }, "tier": "deny", "reason": "离线环境禁止联网" }
  ]
}
```

运行：`node dist/freeseek-headless.js --prompt "..." --exec-policy policy.json`。

## 0.26.0 Stable — Plugin Ecosystem（插件加装与套件皮肤）

在 0.25.0 的 5 项缺口之上，补齐"插件加装"产品形态（对标 `dsh plugin add <spec>` / codex `codex plugin`），并让套件具备可注入的 UI 皮肤：

- **插件加装 CLI**：`freeseek plugin add <spec> [--root <dir>]` / `remove <name>` / `list [--json]`。spec 支持三种来源：
  - `npm:`（裸 `@scope/pkg@ver` 默认按 npm registry）→ `npm pack` + tar 解包（专用缓存目录，用完即删）；
  - `git:`（含 `github:user/repo` 短路径）→ `git clone --depth 1`；
  - `file:` / 绝对路径 → 本地目录直取。
- **套件定位与可逆安装**：下载包内按 `plugin.json`（或 `package.json` 的 `freesek.plugin` 段）定位套件根（对齐 dsh.bundle 语义）；落地复用 kits 的 `installKit` / `uninstallKit`，把 skills / commands / agents / themes 安装到项目 `.agent/` 并登记 `.agent/kits.json` 注册表，卸载依注册表逆操作，构成可逆闭环。
- **套件皮肤（Themes）**：套件可声明 `themes`（CSS 变量覆盖），安装后落到 `.agent/themes/<name>.css`；Web Console / VS Code 设置面板的主题下拉动态包含已安装皮肤（`body[data-theme]` 注入，在默认 5 主题之上扩展）。
- 入口：`src/plugin.ts` + `src/plugin-cli.ts`；`src/kits.ts`（themes 类型）；`node dist/freeseek-headless.js plugin --help`。

## 快速开始（免费方案）

1. 安装本扩展（`.vsix` 或通过源码 `npm i && npm run compile` 后按 F5 调试）。
2. 打开命令面板 → **`FreeSeek: 启动免费 DeepSeek 服务`**，选择 Docker 或 Node 方式拉起 `deepseek-free-api`（默认监听 `http://127.0.0.1:8000/v1`）。
3. **获取并填写 `userToken`**（关键步骤，完整说明见 [docs/quickstart.md](docs/quickstart.md)）。
4. 在设置里确认 `freesek.provider = free`（默认即此），`freesek.freeBaseUrl` 指向 `http://127.0.0.1:8000/v1`。
5. 打开侧边栏 **FreeSeek → 编程助手**，描述任务即可。

## 安装方式

三种方式任选：

| 方式 | 命令 / 步骤 | 适用场景 |
| --- | --- | --- |
| VS Code Marketplace | 扩展市场搜索 FreeSeek 安装（发布后） | 普通用户 |
| VSIX 手动安装 | `code --install-extension releases/freeseek-copilot-<版本>.vsix` 或扩展面板「从 VSIX 安装…」 | 未发布市场时的分发 |
| CLI / npm tarball | `npm install -g ./freeseek-copilot-0.19.0.tgz` 后运行 `freeseek help` | 终端 / CI / 自动化 |
| 源码运行 | `npm install && npm run compile`；VS Code 按 F5，CLI 用 `node dist/freeseek-headless.js help` | 二次开发 / 内测 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/quickstart.md](docs/quickstart.md) | 免费方案完整上手：`userToken` 获取与填写、Docker / Node 两种服务启动方式 |
| [docs/providers.md](docs/providers.md) | 多协议 Provider 接入：openai / claude / gemini、连接器插件、PaperSeek 学术检索 |
| [docs/configuration.md](docs/configuration.md) | 手动配置示例（`freesek.providers`）与全部设置项 |
| [docs/commands.md](docs/commands.md) | 命令面板命令一览 |
| [docs/settings.md](docs/settings.md) | 设置项速查表 |
| [docs/architecture.md](docs/architecture.md) | 架构与源码模块职责 |
| [docs/product-surfaces.md](docs/product-surfaces.md) | 产品交互形态：VS Code、CLI/Headless、ACP、Desktop 与 Web Console 边界 |
| [docs/project/DESKTOP_ARCHITECTURE.md](docs/project/DESKTOP_ARCHITECTURE.md) | 0.20 Desktop Host 架构与安全边界 |
| [docs/cli.md](docs/cli.md) | 统一 CLI：run/eval/bench/acp/web/doctor/sessions/replay、安全默认值与 durable session；0.25 新增 `--tui` / `--exec-policy` / `--sandbox remote:*` 与 `freeseek-sdk` |
| [docs/acp.md](docs/acp.md) | ACP v1 stdio Agent Server：启动、生命周期、权限、MCP、持久化与当前边界 |
| [docs/web-console.md](docs/web-console.md) | Web Console：本地回环 HTTP/SSE 浏览器宿主（0.24；0.25 起支持浏览器端审批 / ask_user 回传） |
| [docs/sdk.md](docs/sdk.md) | 官方 SDK（0.25）：库入口 `require("freeseek")` 导出映射与 `freeseek-sdk` CLI 用法 |
| [docs/deployment/](docs/deployment/) | 各产品形态部署与使用说明：CLI / ACP / VS Code / Desktop / Web Console / Eval-Bench / Core |
| [docs/context-planner.md](docs/context-planner.md) | Context Planner v1/v1.1/v1.2、retrieval/presentation experiment、模型 A/B、Context 使用 trace |
| [docs/deepseek-v4-ab.md](docs/deepseek-v4-ab.md) | DeepSeek V4 官方 API 的安全 Context Planner 真实 A/B 运行手册 |
| [docs/persistence-headless.md](docs/persistence-headless.md) | EventLog / 内容寻址存储 / workspace timeline / Headless 与 fork |
| [docs/evals.md](docs/evals.md) | Trace / Eval Harness：真实 Agent 回归、声明式 checks、baseline 对比 |
| [docs/benchmarks.md](docs/benchmarks.md) | FreeSeek Bench：公开回归、评分与 baseline 对比 |
| [docs/bench-v2-holdout-real.md](docs/bench-v2-holdout-real.md) | Bench v2：private holdout、immutable Git source 与真实仓库任务 |
| [docs/event-index.md](docs/event-index.md) | EventLog byte-offset 二级索引与崩溃重建语义 |
| [docs/remote-sandbox.md](docs/remote-sandbox.md) | Remote Sandbox CommandRunner provider 与 workspace mapping 协议（0.25 落地 Docker / SSH / E2B 三态 transport） |
| [docs/tool-catalog.md](docs/tool-catalog.md) | 内置工具目录（由 `scripts/gen-catalog.mjs` 自动生成） |
| [SECURITY.md](SECURITY.md) | 安全模型：沙箱 / 权限 / 内容扫描 / 漏洞报告 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南：门禁 / 测试 / 模块拆分契约 / 发布流程 |

## 开发

```bash
npm install
npm run compile   # 或 npm run watch（esbuild 增量构建）
npm run check     # 工程门禁：typecheck + 行数上限 + 导出 JSDoc（改动后必跑）
npm test          # 单元测试（node:test，零依赖）
npm run release   # 一键发布：门禁 → 版本 bump → 打包 → vsix 归拢 releases/ → CHANGELOG
# 按 F5 启动 Extension Development Host 调试
```

### CLI / Headless（正式宿主，同一 Agent Kernel）

构建后可在没有 VS Code UI 的 Node/CI 环境复用同一 `ToolRegistry → ToolRuntime → EventLog`：

```bash
node dist/freeseek-headless.js help
# npm 全局安装后
freeseek doctor
freeseek run --workspace . --prompt "检查并修复测试失败" ...
freeseek sessions
freeseek plugin add @scope/plugin@latest   # 插件（npm / git / 本地目录），对标 dsh plugin
freeseek plugin remove <name>              # 可逆卸载
freeseek plugin list                       # 列出已安装插件
```

CLI 默认不允许 shell；需要自动批准写入/高风险能力时显式使用 `--yes`，命令/代码执行还需额外 `--allow-shell`。恢复、历史分叉和 EventLog 回放见 [docs/cli.md](docs/cli.md) 与 [docs/persistence-headless.md](docs/persistence-headless.md)。

### ACP Agent Server（0.19 Stable，第三宿主）

```bash
export FREESEEK_BASE_URL=https://api.deepseek.com
export FREESEEK_API_KEY=...
export FREESEEK_MODEL=deepseek-v4-flash
freeseek acp
# 或独立 bin：freeseek-acp
```

ACP Host 使用 NDJSON JSON-RPC over stdio，stdout 只承载协议；当前实现 `initialize/new/prompt/cancel/list/resume/close`、`session/update`、client permission 与 session-owned stdio MCP。详细能力与显式未支持项见 [docs/acp.md](docs/acp.md)。

### Standalone Desktop（0.20 开发主线）

0.20 dev.1 首个骨架采用 Electron，但 Agent 仍运行在独立 `freeseek-acp` 子进程中。

```bash
npm run vscode:prepublish        # 先生成 dist/freeseek-acp.js
npm run desktop:build
npm --prefix apps/desktop install
npm --prefix apps/desktop start
```

当前 dev.1 支持 workspace/provider 启动、流式 prompt、mode/cancel、permission/elicitation 桥；API Key 仅保存在进程内存，不持久化。详见 [Desktop Architecture](docs/project/DESKTOP_ARCHITECTURE.md)。

### Eval Harness

可用 `freeseek eval --manifest <suite.json> ...`（兼容 `freeseek-eval`）对复制的隔离 workspace 运行真实 Headless Kernel，
从 durable indexed EventLog 统计成功率、token、步骤、工具调用/阻断/超时、审批与模型延迟，并与 baseline report 做 delta 对比。详见 [docs/evals.md](docs/evals.md)。

### FreeSeek Bench v1（公开持续回归集）

构建后可用 `freeseek bench list`（兼容 `freeseek-bench list`）查看内置 20 个离线编码任务，`freeseek bench validate --gold` 自检题库可解性，
先用 `freeseek bench context-retrieval` 跑不花模型 token 的 Context Planner Hit@K/MRR 实验，再用 `freeseek bench run --base-url ... --api-key ... --model ...` 跑真实 Agent。主指标为加权 resolved rate，
token / steps / tool calls / duration 单独报告，不混成一个可被刷的综合分。详见 [docs/benchmarks.md](docs/benchmarks.md)。

### Bench v2（私有 Holdout + 固定真实仓库）

`freeseek bench init-holdout --out <仓库外目录>` 创建 private pack；private report 默认匿名并删除 raw trace。
`freeseek bench list --real` / `freeseek bench validate --real --gold` 使用固定到完整 Git SHA 的历史真实仓库任务；缓存预热后可用 `--offline-sources` 在 CI 中禁止漂移。详见 [docs/bench-v2-holdout-real.md](docs/bench-v2-holdout-real.md)。

## 更新记录

### v0.18.0（多宿主稳定版：统一 Kernel + 正式 CLI + durable replay）

- **正式多宿主**：VS Code 与 CLI/Headless 共享 `runAgent → ToolRegistry → ToolRuntime → EventLog`，不再把 FreeSeek 定义为“VS Code 扩展本体”。
- **统一 CLI**：新增 `freeseek run/eval/bench/doctor/sessions/replay`；0.17.x 的 `freeseek --prompt ...` 与独立 `freeseek-eval` / `freeseek-bench` 保持兼容。
- **实验分支稳定化合并**：纳入统一 Tool Runtime/Registry、安全修复、shadow checkpoint、完整 EventLog 恢复/fork、byte-offset index、Trace/Eval/Bench、Remote Sandbox seam、DeepSeek V4 与 Context Planner v1.2。
- **Context Planner 谨慎推广**：v1.2 可正式使用但默认仍 `off`；真实 A/B 已显示正确率不退化且 token/tool/step 降低，但完整跨 suite 推广门禁尚未满足。
- **发布工程**：Node CLI 声明 `node >=18`；补齐直接 `iconv-lite` 依赖；新增 CLI session/replay 单测。


### v0.17.16（任务分解修复：提示词硬约束 + todo 分解 nudge）

- **提示词硬约束**：`WORKFLOW_GUIDANCE` / `CODER_MODE_GUIDANCE` 明确多步骤/多文件任务必须先调用 `todo_write` 分解为 ≥2 个可执行的具体步骤，**禁止把整条用户需求作为单一任务项**（解决任务面板一直显示整条需求的问题）。
- **todo 分解 nudge 兜底**：`agent.ts` 检测到任务面板仍只有单条「进行中」种子任务（模型未主动分解）且已执行 ≥2 步工具调用时，注入推动消息让模型调用 `todo_write` 补充分解，限次 1 次（对标 lazy-nudge）。

### v0.17.15（修复：用户新消息后右侧对话跳转导航不刷新）

- **修复**：`send()` 与定时注入（`user_injected`）渲染用户消息后缺少 `renderNavRail()` 调用，导致新输入/注入的消息在右侧对话跳转栏不出现跳转圆点。两处路径补齐刷新调用。

### v0.17.14（修复：分级压缩破坏工具配对导致 400 · 过早压缩）

- **修复 400**：`tieredCompact` 按年龄切段可能把 `assistant(tool_calls)` 摘要掉、留下孤立 `tool` 消息（无前置 tool_calls），服务端报 "role 'tool' must be a response to a preceding message with 'tool_calls'"。新增 `context.sanitizeToolSequence` 栈式配对齐整化（孤立 tool 丢弃、未闭合 tool_calls 移除字段、保留消息文本），压缩产物必过校验。
- **修复过早压缩**：消息数兜底（convLen ≥ 30）仅对小窗口模型生效（effectiveBudget < contextBudget），大窗口模型按 85% 预算触发，不再低占比下过早压缩。
- **结构规范**：AGENTS.md 登记压缩配对不变量。

### v0.17.13（命令执行 seam · 冗余清理与结构规范）

- **能力 seam 落地**（对标 deepseek-harness capability seam）：新增 `src/seam.ts`——`CommandRunner` 接口 + `LocalCommandRunner`（默认本地多层沙箱执行）+ 可替换注册表（getCommandRunner / setCommandRunner / resetCommandRunner）；`run_command` / `run_code` 经 seam 消费，未来可无感切换远程/容器执行、dry-run、审计包装器。
- **冗余清理**：根目录发布产物 vsix 归拢 `releases/`，`_tmp_*` 临时残留清除。
- **逻辑优化**：`exec_code.ts` 两处输出截断收敛到 `agent-utils.truncatePreview`；`activate.ts` 定时任务类型复用 `scheduler.ScheduleSpec`（消除手写重复联合类型）。
- **结构规范**：AGENTS.md 仓库概览登记能力 seam 与共享基础模块（frontmatter / similarity / agent-utils / builtin-skills）。

### v0.17.12（借鉴 QwenWork 四项能力 · 执行策略与权限收敛 · 内置角色扩充）

- **Hooks 外部命令**（对标 QwenWork hooks）：hookify 新增 `action: command`，命中规则时执行外部命令（stdin 传事件 JSON），退出码 0=成功/2=阻塞/其他=警告；由 `freesek.allowCommandHooks`（默认关）门控。
- **专家套件**（对标 QwenWork 专家套件）：新增 `src/kits.ts`（plugin.json 清单 + installKit 落位 .agent/skills|commands|agents）+ 命令「安装专家套件」。
- **定时任务**（对标 QwenWork 定时任务）：新增 `src/scheduler.ts`（interval / daily 计划 + Scheduler 管理 API）+ 命令「添加/管理定时任务」，到点触发完整 Agent 会话。
- **记忆生命周期治理**（对标 QwenWork 意识）：记忆条目结构化解析、相似去重、按条数淘汰、单文件治理与备份。
- **执行策略单一真相源**：ExecPolicy 接入 run_command / run_code / 会话沙箱；权限规则改为随 ToolContext 传递（子代理继承），消除散落的 settings 直读与 planSandbox 组合。
- **内置子代理角色 +5**：code_reviewer / minimal_change_engineer / codebase_onboarding / git_workflow_master / prompt_engineer（对齐 agency-agents），并附批量导入脚本 `scripts/import-agency-agents.mjs`。
- **结构规范**：frontmatter 解析收敛到 `src/frontmatter.ts`、相似度收敛到 `src/similarity.ts`；内置技能拆分 `builtin-skills.ts`。

### v0.17.8（工程层 anti-early-stop：对齐 Claude Code 主循环纪律）

- 查证 Claude Code / Codex CLI 成熟实现后补齐工程层机制：`agent.ts` 主循环在「模型无 tool_use 退出」分支，若回复仅由任务清单构成、缺乏结论，注入推动消息再跑一轮（限次 1 次，硬上限兜底）；新增 `looksLikeTaskListOnly` 判定及 3 个单测。

### v0.17.7（修复"了解文件夹"回答不完整）

- **修复"了解当前文件夹功能"回答不完整**：模型原只读一个文件就返回任务清单。现 `SYSTEM_PROMPT` 强制探索/总结类任务输出结构化最终总结；`WORKFLOW_GUIDANCE` 明确 `todo_write` 只是计划、禁止仅以清单结束对话；新增内置技能 `explore-project`（触发词：了解文件夹/项目功能/介绍一下这个项目等）给出必做步骤与输出格式。
- 新增 3 个回归单测验证技能与 prompt 约束。

### v0.17.6（抗攻击加固：路径逃逸 / 命令注入 / 巨文件 OOM / 死循环）

- **修复符号链接路径逃逸**：`resolveSafe` 追加 `realpathSync` 真实路径校验。
- **修复 `run_code` Windows PowerShell 命令注入**：改为 `-File` 执行临时 `.ps1` 脚本。
- **加固重复工具死循环检测**：`normalizeArgsKey` 归一化 + 同工具无进展判定。
- **加固 grep/read_file 巨文件 OOM**：grep 单文件 8MB 上限、read_file 16MB 整读上限。
- 新增 `tests/attack.test.ts` 8 个攻击回归用例。

### v0.17.5（系统提示词防泄露）

- **新增系统提示词保密规则**：追加 `SYSTEM_PROMPT_PROTECTION`，强制模型在用户要求"给出/复述/翻译/解释/总结"系统提示词时只回答「抱歉，我无法分享系统提示词」，然后继续帮助用户处理原本任务。覆盖完整模式与闲聊模式，防御 System Prompt Extraction / 提示注入套取内部指令。

### v0.17.4（模型添加兜底 · DeepSeek 测试连接修复）

- **模型添加兜底**：「添加模型」弹窗在「获取模型 / 测试连接」失败时不再卡死，改为显示「手动填写模型名」输入框（如 NUAA 等只暴露 `/v1/chat/completions`、不暴露 `/v1/models` 的网关），保存时优先使用手填模型名，让此类服务可正常添加。
- **DeepSeek 官方「测试连接」修复**：前端「添加提供商」DeepSeek 预设 baseUrl 由 `https://api.deepseek.com` 改为 `https://api.deepseek.com/v1`；`probeModelList` 的 test 模式放宽重试——401 仍立即定论（路径对、Key 错），其余非 2xx 一律尝试下一个候选路径，避免被提前截断漏掉正确的 `/v1/models`。
- **`release.mjs` 修复**：`vsce package` 补 `--baseContentUrl`，发布流程不再因 README 相对链接校验报错而中断。
- 新增 `tests/probe.test.ts`（4 个单测）覆盖路径拼接与重试行为。

### v0.17.3（修复 DeepSeek 官方「测试连接」联不通）

- **修复前端 DeepSeek 预设 baseUrl**：「添加提供商」弹窗的 DeepSeek 预设 baseUrl 由 `https://api.deepseek.com` 改为 `https://api.deepseek.com/v1`，与后端 `addProvider` 向导一致（原漏 `/v1` 导致拼接候选路径错误）。
- **放宽测试连接重试逻辑**：`probeModelList` 的 `test` 模式下，401 仍立即定论（路径对、Key 错），但其余非 2xx 一律尝试下一个候选路径（不再仅限 404），避免首个候选返回 405/400 等被提前截断而漏掉正确的 `/v1/models`。
- 新增 `tests/probe.test.ts`（4 个单测）覆盖上述路径拼接与重试行为。

### v0.17.2（UI 优化 · 浏览器 Dev Harness）

- **浏览器 Dev Harness**：新增 `src/webview/bridge.ts`（HostBridge + createBridge，隔离 `acquireVsCodeApi`）与 `scripts/webview-dev.mjs`（`npm run dev:webview`，:5173 提供空面板与 `?scenario=events-*.jsonl` 回放），可在浏览器中直接查看/调试 webview UI，无需启动 VS Code。
- **欢迎页重构**：卡片式欢迎界面，渐变背景 + 主题建议标签 + 快捷键提示；空状态 `showWelcome` 现在会在 `#welcome` 为空时正确填充。
- **对话消息去重**：连续同角色消息合并渲染，多段内容以空行连接，减少碎片。
- **工具调用卡片**：默认折叠 `<details>`，降低长输出时的视觉噪声。
- **图片消息占位**：空文本（仅图片）消息显示「（图片消息）」占位。

### v0.17.0（工程化：门禁 · 单测 · 发布 · 模块拆分）

- **工程门禁 `npm run check`**（对齐 deepseek-harness typecheck/lint/hygiene 多门禁）：① typecheck（src 树 0 错误）② hygiene 行数上限（默认 600，超限文件头 `// check:max-lines N` 登记技术债并限期拆分）③ 导出 JSDoc 覆盖检查。
- **单测基础设施 `npm test`**（对齐 deepseek-harness 五层测试、codex 快照测试）：esbuild bundle `tests/*.test.ts` → `node:test` 执行，零新依赖。纯逻辑模块（goal/jobs/eventlog/context 等）首批单测落地。
- **一键发布 `npm run release`**（对齐 codex 发布脚本化）：门禁 → 版本 bump → 生产构建 → vsce 打包 → vsix 归拢 `releases/` → 自动追加 `CHANGELOG.md`。
- **模块拆分**：`extension.ts` 拆出 `freeserver.ts`（免费服务管理）与 `storage.ts`（路径/索引/会话持久化），主文件体量下降（3587 → 3310 行）。
- **UI 设计 token**：webview `:root` 建立语义色 token（`--fs-accent/ok/warn/err/fg-muted/border/bg-*`，映射 VS Code 主题变量），统一替换散落硬编码色（对齐 codex styles.md 语义色规范）；前端动态渲染改用 `var(--fs-ok)/var(--fs-err)`。
- **任务 / 文件列表面板实装**（此前为"样子货"，始终空白）：任务清单自动从用户消息派生「进行中」任务并实时推送，回合结束自动收尾为「已完成」（模型调用 `todo_write` 时以其规划为准）；文件列表新增读取（`read_file`）与删除（`delete_file`）痕迹跟踪，按 `+N/-N`、`已读 N 次`、`-N 行` 区分展示。
- **「当前目标」常驻面板**：接入此前只发不收的 `goal` 消息，新增 `renderGoalPanel` 与 goal 侧栏面板，阶段徽章（进行中/已暂停/受阻/已完成）全部使用 `--fs-*` 语义色；webview 初始化与新会话时主动下发持久化目标。
- **eventlog 会话标题投影**：`projectSessionTitle()` 从首条用户消息派生标题写入 `session_title` 事件（每会话仅投影一次，审计轨迹稳定），回放/排查可直接读"会话在做什么"。
- **继续模块拆分**：`getHtml`（约 700 行 HTML 模板）机械拆分到 `src/webview/html.ts`，`extension.ts` 从 3310 行降至约 2726 行，`// check:max-lines` 豁免随之下降（3400 → 2800）。
- **发布管线实测**：`npm run release` 全流程跑通（门禁→构建→vsce 打包→归拢 `releases/`），并修复两处发布卫生问题——`spawnSync(shell:true)` 的 Node DEP0190 弃用告警（改引号化单命令）、VSIX 混入 `_tmp_*`/`_verify_*`/`tests/` 等调试产物（补 `.vscodeignore` 规则）；`CHANGELOG.md` 新条目插入位置修复（不再顶到 `#` 标题上方）。
- **工程规范落地**：新增 `.gitignore`（vsix/dist/releases/tests 产物归拢）、AGENTS.md 新增「工程门禁」章节、JSDoc 强制、模块拆分契约（豁免即债务，拆分后必须收敛）。
- **README 新增「安装方式」章节**：Marketplace / VSIX / 源码三种安装路径。

### v0.16.4（目标状态机 goal · 后台任务管理 jobs）

- **目标状态机 goal**（吸收 deepseek-harness `goal` 子包，零依赖）：新增 `goal` 工具支持 create/edit/pause/resume/complete/block/clear 七种操作，`goal_view` 随时查看。与 `todo_write` 互补：todo 记「怎么做」（步骤清单），goal 记「为什么做」（当前目标 + 状态机）。
  - **轮次预算防绕圈**：`max_rounds` 设上限，active 目标每工具轮自动推进轮次计数，超预算在 `goal_view`/系统提示词中给出收敛提醒。
  - **跨压缩锚定主线**：上下文压缩的 `preCompactHook` 优先锚定 goal objective（较"最近一条 user 消息"启发式更稳）。
  - **跨会话续行**：目标持久化到 `.agent/.goal.json`，恢复历史会话时系统自动注入「当前目标」，模型续行而非重新问用户。
- **后台任务管理 jobs**（吸收 deepseek-harness `jobs` 子包）：`run_in_background` 启动的子智能体自动登记到统一注册表，新增 `job_list`（状态/标签/起止时间）、`job_output`（读取已收集输出）、`job_kill`（终止并抑制完成通知）三个工具，告别"只能等通知"的被动局面。
- 主循环每工具轮向 webview 回传目标视图（`type: "goal"`），前端可据此展示当前目标。

### v0.16.3（子代理 Description 自动路由 · skills 自动加载 · .codebuddy 兼容 · 恢复会话命令）

- **子代理 Description 自动路由**（对齐 CodeBuddy Subagents）：`RolePreset` 新增 `description` 字段，内置 explore/plan/verify/general 均补描述；主系统提示词注入「可用子代理清单（名字+描述+只读/可执行）」，让主 Agent 主动判断何时派发哪个子代理。
- **skills 自动加载**（对齐 CodeBuddy 子代理 `skills` 字段）：角色文件 / 角色预设可声明 `skills: [...]`，子代理启动时自动把对应技能全文拼进 system body，开箱即掌握 SOP。优先级 agent frontmatter > role 预设。
- **兼容 `.codebuddy/agents/`**：子代理角色文件既可从 FreeSeek 原生 `.agent/agents/` 读取，也可从 CodeBuddy 约定的 `.codebuddy/agents/` 读取（后者优先）。
- **`spawn_agent`/`spawn_agents` 的 role 放开为自由字符串**：不再写死内置四角色 enum，用户自定义角色也能通过合法参数路由派发。
- **恢复历史会话命令**：新增 `FreeSeek: 恢复历史会话`（`freesek.resumeSession`），列出全部非归档会话供选择恢复（对齐 Codex/Claude Code 的会话恢复语义）。
- 代码质量：提取共享 `EXEC_TOOLS` 常量、合并重复 import、`resumeSession` 改为有限轮询等。

### v0.16.2（checkpoint/rewind 升级为可回溯时间线）

- **checkpoint 支持命名**：`checkpoint({ name })` 以 `freesek-cp:<name>` 标识创建检查点，不填自动生成。
- **rewind 可回滚到任意历史点**：`rewind({ name })` 恢复指定命名检查点；不填则回滚到最近一次。检查点使用 FreeSeek 独立 shadow Git，不触碰用户 branch/index/stash。
- **新增 `list_checkpoints`**：列出工作区全部 freesek 检查点时间线（自动检查点 + 命名检查点），供 rewind 选择目标点。
- Checkpoint/rewind 使用 FreeSeek 独立 shadow Git 记录与恢复工作区快照，避免自动 checkpoint 改写用户工作树或删除用户 stash。

### v0.16.1（A2A 互通信 · MCP 知识库检索 · run_python · 文件编码探测/冲突检测 · 对话跳转）

- **A2A 子智能体互通信**：子智能体之间现在可以互相发消息（不再只有主→子单向）。`send_message` 支持子→子寻址续跑，`busyAgents` 集防止递归自触发。内置 4 个角色（explore/plan/verify/general）与默认子智能体白名单均已开放 `send_message`，多智能体协作编排更灵活。
- **MCP 接外部知识库**：FreeSeek 仅做工具接线、不内置知识库。连接 MCP server 后，若其暴露检索类工具（名称匹配 `search|query|retriev|kb|knowledge|find|lookup|semantic|vector|rag`），自动暴露统一检索入口 `mcp_list_kb`（列出可检索来源）+ `mcp_kb_search`（按 query 检索，多键名参数 `query/limit/max/top_k/q` 兼容），系统提示词注入知识库来源清单。
- **run_python 工具**：专用 Python 执行器，运行前自动注入 `matplotlib` Agg 后端（无界面也能出图）；自动选用 `python3`/`python`；带超时与 32MB 输出上限、stdout 截断 8000 字符。脚本生成的 PNG 自动收集并以 base64 回传，在聊天中直接渲染为图表（对标数据分析场景）。需在设置开启 `freesek.allowShell` 才可用。
- **文件工具缺口补齐**：
  - **编码探测**：`read_file` / `write_file` / `edit_file` 自动探测编码（BOM 优先 → 严格 UTF-8 → iconv-lite 回退 `gb18030`/`big5`/`shift_jis`/`euc-kr`），写回时按原编码保留，避免 GBK/UTF-16/BOM 文件被误转。
  - **外部修改冲突检测**：引入文件指纹（mtime+size+sha1 快照）；若 FreeSeek 上次读/写之后文件被外部改动，写/编辑会拒绝并提示，可加 `force: true` 强制覆盖。新建对话时清空快照，避免跨会话误报。
- **对话跳转（长对话回看）**：聊天区右下角新增「对话跳转」浮动按钮（带消息条数角标），点击展开下拉菜单，列出全部消息书签（序号 + 角色图标 + 摘要），点任意一项平滑滚动定位并高亮闪烁。解决对话过长、只能不停上滑回看的问题。

### v0.16.0（修复会话重命名/删除 + 归档功能）

- **修复重命名/删除不生效**：webview 沙箱禁用 `window.prompt`/`window.confirm` 导致弹窗弹不出、操作失效。改为自定义输入框/确认框（`promptInput`/`confirmAction`）。
- **新增归档功能**：侧边栏「🗄 归档」可查看已归档会话，支持恢复/删除；归档会话从主列表/最近 Tab/历史搜索中隐藏。
- 归档状态持久化（`SessionMeta.archived`）。
- **修复换模型下拉被遮挡**：`#topbar` 的 `overflow-x:auto` 会裁剪向下弹出的模型下拉，移除后下拉正常显示（窄屏滚动由会话 Tab 自身承接）。
- **修复技能删除确认框**：`window.confirm` 在 webview 沙箱禁用导致失效，改用自定义 `confirmAction`。
- **模型下拉主动拉取**：点击 modelChip 时向后端请求最新模型选项（含自动发现的模型）再打开菜单。
- **指令审核（执行前确认）**：Agent 调用 `slash_command` 执行自定义 .md 命令前，弹窗让用户审核确认后再执行（命令可能含危险操作）。
- **添加提供商改为弹窗表单**：对齐 CodeBuddy，在 webview 内弹单个表单 modal（预设服务商下拉 + Base URL + API Key + 模型 + 工具模式 + 保存），一个弹窗填完并提交，替代一步步输入。

### v0.15.9（参照 CodeBuddy 完善添加模型向导）

- **预设服务商一键选择**：「添加提供商」向导第一步可选 10 个常见服务商预设（DeepSeek / OpenRouter / 硅基流动 / Kimi / 通义 / 智谱 / 腾讯混元 / OpenAI / Ollama / LM Studio），自动填充 Base URL / 协议格式 / 认证方式 / 模型；仅「自定义」才手动填写。Ollama/LM Studio 预设自动启用模型发现。
- **API Key 预填 `${env:}` 引用**：选预设后 Key 输入框自动填入对应的环境变量引用。
- **保存后连通性测试**：参照 CodeBuddy「保存，测试连通」，添加后自动调用 `/models` 探测服务可达性与鉴权有效性并反馈结果。

### v0.15.8（腾讯云接入 + 窄屏适配 + LM Studio 自动发现）

- **腾讯云混元接入**：内置 `tencent-hunyuan` 预设（OpenAI 兼容，`https://api.hunyuan.cloud.tencent.com/v1`），含 `hunyuan-turbo`/`hunyuan-pro`/`hunyuan-standard` 模型。
- **LM Studio / Ollama 自动发现模型**：`autoDiscoverModels: true` 时自动拉取 `/v1/models` 全部模型，切换模型时实时刷新。
- **窄侧边栏适配**：顶栏宽度过窄时自动切紧凑模式（按钮只留图标）+ 横向滚动兜底，按键不再被遮挡。

### v0.15.7（五维质量修复 + 测试场景手册）

- **可靠**：修复 abort 竞态（新建/切换会话后旧请求不再误判 error）。
- **性能**：`unifiedDiff` LCS 阈值降至 1M 行（大文件 diff 防主线程卡顿）；会话落盘改为异步串行写队列（index/session/transcript 不再同步阻塞）。
- **安全**：`verify`/`delete_file` 纳入统一 Plan/只读守卫；`web_fetch`/HTTP 连接器加内网地址拦截（防 SSRF）；MCP resources/prompts 走用户审批；子代理继承 MCP 审批回调。
- **文档**：新增 `TEST_SCENARIOS.md`（五维测试场景与回归基线）。
- **功能**：LM Studio / Ollama 本地服务支持 **自动发现模型**（`autoDiscoverModels: true`），自动拉取 `/v1/models` 的全部已加载模型，切换模型时实时刷新——不再只能手动写死一个 7b 模型。

### v0.15.6（MCP 资源/提示词 + Agent 并行 + 会话 Tab）

- **MCP resources / prompts 支持**（对齐 Claude Code / CodeBuddy MCP 扩展）：连接时发现并展示 resources/prompts，新增 `mcp_read_resource` / `mcp_get_prompt` 工具，系统提示词注入可用资源/提示词清单。
- **Agent 并行协调**：新增 `spawn_agents` 工具，用 `Promise.all` 并行运行多个独立子智能体（可配合 worktree 隔离并行改不同模块），合并返回各子任务结论。已有 `spawn_agent` 保持不变。
- **会话 Tab 快速切换**：顶栏新增最近会话 Tab 栏，点击即可在多个会话间快速切换（复用现有会话存储）。

### v0.15.5（产物预览：Mermaid 图表渲染）

- **Mermaid 图表渲染**（对齐 CodeBuddy 4.9.12）：代码块 ```` ```mermaid ```` 懒加载 `dist/mermaid.js` 并渲染为 SVG 图表（不进主 bundle，首屏不受影响）。支持流程图/时序图/甘特图等。

### v0.15.4（产物预览：CSV/TSV 表格）

- **CSV/TSV 表格预览**（对齐 CodeBuddy 4.6.4）：代码块 ```` ```csv ```` / ```` ```tsv ```` 自动解析并渲染为可读的 HTML 表格（支持引号包裹字段），保留复制原始数据按钮。

### v0.15.3（借鉴 CodeBuddy：Slash 增强 + MCP 审批 + 自定义 Agent）

- **Slash 指令增强**：新增 `/summarize`（生成当前对话结构化摘要）与 `/skills`（打开技能管理面板），补齐与 `/init`、`/review`、`/compact`、`/memory`、`/clear` 的完整指令集。
- **MCP 工具独立审批**：外部 MCP 工具首次调用时弹窗询问「允许 / 允许本次 / 拒绝」，会话级记录 allow，拒绝则不执行（对齐 CodeBuddy MCP 审批）。
- **自定义 Agent 预设**：新增 `freesek.agentPresets`，用户可自定义 `spawn_agent` 的角色（覆盖内置 explore/plan/verify/general）。
- **历史对话搜索 + JSON 导入**（对齐 CodeBuddy 4.9.15/4.11.0）：历史对话支持按提问内容搜索；导出菜单支持导入 JSON 对话。
- **Safe-Delete 安全删除**：新增 `delete_file` 工具，删除转系统回收站可恢复（Windows/macOS/Linux 跨平台）。

### v0.15.2（联网检索 + PaperSeek 学术检索）

- **联网检索工具**：新增 `web_search`（搜索引擎返回标题/链接/摘要）与 `web_fetch`（抓取网页转文本），解决"查文档/查 API 用法/查报错含义"的联网刚需。
- **PaperSeek 学术检索连接器**：内置 `conn__paper_seek__search`，用自然语言检索论文（OpenAlex/arXiv/Semantic Scholar/PubMed 等），返回标题/作者/年份/引用数/摘要；支持 MCP 方式接入。
- 更新记录新增联网与学术检索能力。

### v0.15.1（连接器插件 + 内置技能模板 + MCP 管理）

- **连接器插件机制**：新增 `src/connectors.ts` 抽象（registerConnector / dispatchConnectorTool），第三方可注册外部服务工具（`conn__<id>__<tool>`），内置通用 HTTP 请求连接器。
- **内置技能模板库**：随扩展内置 `commit-push-pr` / `code-review` / `refactor-to-composable` 三个开箱即用的 SOP 技能（只读，可复制定制）。
- **技能系统强化**：内置模板在技能管理面板标"内置模板（只读）"；技能管理对内置模板做只读保护（不可改状态/删除，不参与去重）。
- **MCP 管理面板**：设置面板新增"🔌 MCP 服务管理"（server 连接状态/传输/工具清单 + 重新连接），新增命令 `FreeSeek: 管理 MCP 服务`。
- **run_command 交互支持**：新增 `input` 参数注入 stdin（应对交互式确认）。

### v0.15.0（多协议 AI 接入 + 质量门禁 + 技能进化闭环）

- **各种 AI 接入**：Provider 抽象层支持 `openai` / `claude` / `gemini` 三种协议格式，自动构造对应端点、认证头（Bearer / x-api-key / x-goog-api-key）与流式解析；支持自定义请求头（`headers`，含 `${env:}` 插值）与额外请求体透传（`extraBody`）。「添加提供商」向导新增协议格式选择。
- **质量门禁（verify）**：新增 `verify` 工具自动运行 typecheck/lint/test 并按「文件:行」定位失败；`freesek.autoVerify`（默认开）驱动「写→跑→修」闭环。
- **计划审批状态机**：Plan Mode 升级为「计划 → 结构化审批 → 执行」；`ask_user` 支持结构化多选项（对齐 Interactive Questions）。
- **技能进化闭环**：会话后自动沉淀可复用技能（pending 待审核）→ 设置面板技能管理（激活/停用/删除/去重合并）→ `promote_skill` 经 `verify` 验证后自动激活。
- **上下文增强**：`@` 提及文件直接注入内容（对标 Claude Code @file）；支持多模态图片输入（支持视觉的模型）。
- **可观测性**：会话审计展示输入/输出 token 与工具调用次数。

### v0.14.0（界面重构 + 对话内 diff 控制）

- **UI 全面重构**：Webview 拆分为组件模块（state/markdown/components），整体视觉对齐 Claude Code / Codex。
- **富文本 markdown**：改用 marked + DOMPurify 渲染（标题 / 列表 / 表格 / 链接 / 引用 / 公式代码块），修复 XSS 风险，链接点击后用系统浏览器打开。
- **代码块增强**：每个代码块带语言标签 + 一键复制按钮；思考过程（reasoning）改为可折叠的「💭 思考过程」块。
- **模型下拉菜单**：顶栏模型 chip 改为内置下拉（多提供商分组 + 当前项勾选 + 添加/编辑提供商入口），不再依赖原生 QuickPick。
- **对话内 diff 应用/回滚**（对标 Codex）：每次 write_file / edit_file 产生的修改卡片带「✓ 接受 / ↩ 回滚」按钮；回滚仅当文件未被后续修改覆盖时执行，恢复为修改前内容（新建文件则删除），并自动刷新已打开的编辑器。
- **会话树分组**：侧栏历史会话按「今天 / 昨天 / 近 7 天 / 月份」分组展示。
- **停止不再报错**：点击「停止」后以友好状态提示，不再弹出错误气泡。
- **CSP 加固**：webview 增加 Content-Security-Policy（nonce 脚本 + 资源白名单）。
- 欢迎页新增快捷任务建议（解释项目 / 找 bug / 补测试 / 代码审查）。

### v0.13.x（此前版本）

- 多提供商 / 多模型（DeepSeek 官方 + 本地逆向 + LM Studio 等自定义），对话内即时切换。
- Agent 内核：21 个内置工具、ReAct + 原生 function calling 双协议、子智能体编排（spawn_agent / send_message）、worktree 并行隔离、三级上下文压缩、OS 沙箱（Seatbelt / bwrap / 进程级降级）、权限规则（allow/deny）、自动记忆（remember）、Slash 命令（.agent/commands）、MCP（stdio + http）等。
