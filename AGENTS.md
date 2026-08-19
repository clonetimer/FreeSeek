# FreeSeek — Engineering Rules for This Repository

> 本文件是 FreeSeek 扩展自身的工程规范（对修改本仓库代码的 Agent 生效）。
> 借鉴自 Codex CLI 的 AGENTS.md 工程纪律，逐条可执行、定期 ruthlessly edit。

## 仓库概览
- VS Code 扩展：在 Webview 面板中运行多 provider 的 Agent 编程助手（FreeSeek）。
- 核心入口 `src/extension.ts`（UI/会话/prompt 组装）、`src/agent.ts`（模型循环/工具调度）、
  `src/tool-registry.ts`（每次 run 的 schema/spec/executor 能力快照）、
  `src/tool-runtime.ts`（统一工具执行管线）、`src/tool-runtime-spec.ts`（宿主执行策略）、
  `src/eventlog.ts`（per-session durable journal / actor replay）、`src/event-index.ts`（可重建 byte-offset 二级索引）、
  `src/content-store.ts`（SHA-256 blob store）、`src/trace.ts`（durable trace 指标投影）、`src/eval.ts`（真实内核 eval harness）、
  `src/bench.ts` / `src/bench-cli.ts`（版本化 Coding Benchmark、评分与 CLI）、`src/bench-source.ts`（immutable source/cache）、`src/bench-validate.ts`（pristine/gold 自检）、
  `src/workspace-timeline.ts`（checkpoint ↔ event seq）、`src/context-planner.ts`（实验性 Repo Map / Symbol / Dependency 检索）、
  `src/agent-context-planner.ts`（Planner→Agent/EventLog 接线）、`src/headless.ts`（无 VS Code UI 的同内核宿主）、
  `src/tools.ts`（raw 工具 body）、`src/sandbox.ts`（命令执行与沙箱）、`src/hooks.ts`（安全钩子）、
  `src/context.ts`（上下文压缩；压缩产物必须经 sanitizeToolSequence 配对校验——tool 消息不得孤立）、`src/skills.ts`（技能系统）、`src/hookify.ts`（可编程规则）。
- 能力 seam：`src/seam.ts`（命令执行 CommandRunner，可替换 Provider，run_command/run_code 经它消费）；`src/remote-sandbox.ts` 提供显式 workspace mapping 的远程 provider 协议。
- 扩展能力：`src/kits.ts`（专家套件 plugin.json + 可逆安装：installKit 登记 `.agent/kits.json` 文件清单，uninstallKit 逆操作删除；requires 依赖校验；仅删 `.agent/` 内文件防越界）、`src/scheduler.ts`（定时任务）、
  `src/connectors.ts`（连接器注册表）、`src/mcp.ts`（MCP server）。
- 共享基础模块：`src/frontmatter.ts`（通用 YAML frontmatter 解析）、`src/similarity.ts`（tokenize/jaccard）、
  `src/agent-utils.ts`（纯工具函数）、`src/builtin-skills.ts`（内置技能清单）。
- 构建：`npm run compile`（esbuild + tsc）；发布：打包 vsix。

## 编码规范
- TypeScript 严格模式；禁止未使用的变量/导入（lint 会报，改完必须自查）。
- 模块 ≤600 行；超限文件必须加文件头 `// check:max-lines N` 豁免（作为技术债登记），
  并在本会话内或近期拆出独立模块（已有先例：`promptFragments.ts`、`wsdiff.ts`、`goal.ts`）。
  拆分完成后必须减小/移除豁免。当前豁免清单见 `npm run check` 输出。
- 每个顶层导出符号必须有 JSDoc（`scripts/check.mjs` 3/3 会统计缺注释导出，warning 不阻塞，但新代码必须带上）。
- 修改任何文件前先 `read_file` 拿最新内容，用 `replace_in_file` 做局部改动，禁止整文件盲改。
- 字符串一律用单引号；2 空格缩进；行宽 ≤100。
- 不得引入新的运行时依赖除非确有必要（当前为纯 TS + VS Code API + Node 内置模块）；测试用 `node:test`，零依赖。

## 系统提示词纪律（改动 prompt 组装时必须遵守）
- 所有动态注入片段必须收敛为 `ContextualFragment` 契约（key/kind/source/indexOnly），
  并走 `assembleBoundedFragmentsWithManifest`（`src/promptFragments.ts`）：
  单片段有上限、总量有硬上限、超限片段截断或丢弃并标注，同时产出处置清单 manifest。
  纯字符串入口 `assembleBoundedFragments` 仅作兼容，新代码用带 manifest 的版本。
- 关键协议（REACT_PROTOCOL / NATIVE_TOOL_GUIDANCE）必须在组装结果之后追加，永不被截断；
  协议不得以 kind="protocol" 的片段参与组装。
- buildSystemPrompt 组装后必须 `appendEvent("prompt_manifest", {opts, manifest, protocol})`
  （尽力而为，失败不影响主流程），供 `scripts/check-fragments.mjs` 回放校验。
- 「当前时间」片段用 `currentTimeBlock()`，刷新用 `refreshPromptTime()`（轻量替换，不重建整段）。
- 新增注入内容时，先在 buildSystemPrompt 中评估其大小；大内容（技能全文、长文档）只放索引，
  用工具按需加载（渐进式披露）。

## 安全改动纪律
- **所有模型工具必须先进入 `ToolRegistry`，再通过 `ToolRuntime.execute()`**。Provider schema、并发策略、Runtime policy 与 executor 必须来自同一个 run-snapshot。禁止在 Agent/Extension/Connector/MCP 分支中直接调用 `executeToolBody` 或 `ToolRegistry.executeBody`；`npm run check` 会硬性扫描旁路。
- 新增内置工具必须同时登记 `src/tools/defs.ts`（模型 schema）与 `src/tool-runtime-spec.ts`（effect / approval / concurrency / capability / timeout）；Agent-native 工具还必须显式注册 executor。模型不可见元数据禁止塞进 Provider ToolDefinition。
- Session durable 行为优先写 `src/eventlog.ts` 的 canonical event；后台 Agent 必须捕获自己的 session log + actor，不得依赖可变的 UI active session。对 `complete=false` 的多模态 event projection 禁止做有损自动恢复。
- `events-*.jsonl` 永远是 durable source of truth；`event-index/**` 只允许作为可丢弃/可重建二级索引。新查询优先用 indexed query，但不得把索引本身当用户数据真相。
- Eval 指标必须从 durable events/trace 投影，不得只从 UI callback 统计；command checks 必须 argv-only 且显式 opt-in。
- FreeSeek Bench 的 correctness 与效率必须分离：`weightedScore` 只来自 case verifier；token/steps/tool calls/duration 只做辅助指标。公开 `benchmarks/v1` 用于持续回归，不得宣传为防训练污染 holdout。v2 private pack 必须位于公开仓库外，默认 report/trace 脱敏；真实仓库 source 必须固定完整 commit SHA，不得使用 branch/tag/短 SHA。host verifier 必须位于 Agent workspace 外。修改 benchmark prompt/fixture/verifier 后必须重新跑对应 `freeseek-bench validate --gold`，并接受 suite fingerprint 变化。
- **Agent 行为优化必须先写 Benchmark hypothesis**：Context Planner / prompt / tool-selection / agent-loop 的默认行为改变前，先用最便宜的可归因实验定位瓶颈，再用相同 suite/filter/repeat 做真实模型 baseline/candidate 对比。Context Planner 先跑 `freeseek-bench context-retrieval` 区分 ranking/retrieval/dependency/budget 问题；若 retrieval 已正确，下一步应固定排序、单独实验 Context Presentation / Tool Selection，并观察 post-plan search/read/mutation trace，再用 `freeseek-bench ab-context --baseline-planner <a> --candidate-planner <b>`。公开回归、private holdout、real-repo 三层至少覆盖与改动相关的层；没有真实模型证据时实验能力保持显式开关，不得仅凭离线 Hit@K 改默认。
- **产品是单 Kernel 多宿主**：VS Code Extension 是当前旗舰交互；CLI/Headless 是一等自动化宿主；未来 Agent Server/ACP 与 Web Console 只做协议/控制面。不得在 Kernel 写死 VS Code UI 或 Provider 身份，也不得为新宿主复制 ToolRuntime/权限逻辑。
- **历史 fork 必须保持对话状态与 workspace 状态一致**：main turn / potential mutation 的 checkpoint 必须通过 `src/workspace-timeline.ts` 绑定 event seq；Headless fork 没有 checkpoint anchor 时 fail-closed，不得把旧对话接到当前代码树。
- 大二进制/图片只通过 `src/content-store.ts` 的 SHA-256 引用进入 durable events；禁止重新把 base64 大对象直接塞回 JSONL。
- Extension 的 `onPermissionRequest` 只渲染审批 UI；“哪些工具需要审批”只由 Runtime spec 决定。
- 新增工具/命令时：off 档也必须防灾难性命令（见 `sandbox.ts isDestructiveCommand` 与
  `hooks.ts DANGEROUS_PATTERNS`，两处清单需保持一致风格）。
- 文件编辑内容的静态安全扫描集中在 `hooks.ts scanFileContent`（9 类模式），新增模式加在那里。
- 可编程规则（hookify）新增事件/动作时，同步更新 `project-template/.freeseek/hooks/` 示例。

## 工程门禁（改动后必须过）
- `npm run check`（`scripts/check.mjs`）六道门禁：① source typecheck（硬性）② tests typecheck（硬性）③ hygiene 行数上限（硬性）④ Tool Registry/Runtime boundary（硬性，禁止 raw body 旁路）⑤ benchmark private/immutable-source boundary（硬性）⑥ 导出 JSDoc 覆盖（warning）。
  提交前必须 `npm run check` 全绿（warning 可留 TODO）。

## 测试
- 单元测试：`npm test`（`scripts/test.mjs`，优先 esbuild bundle；原生 esbuild 与当前平台不匹配时自动 fallback 到 `tsc emit + node:test`）。
  纯逻辑模块（goal/jobs/eventlog/context/promptFragments/skills/hooks 等）必须有单测，改动核心逻辑时补/更新。
- 类型门禁：`npm run check` 内 typecheck（src 树须 0 错误）。
- prompt 组装回放检查：`node scripts/check-fragments.mjs --self`（检测器自检）；
  实盘回放 `--file <events-*.jsonl>` / `--dir <历史目录>`（校验 bounds / system-core /
  协议尾不变量）。
- 工具目录生成：改动 `src/tools/defs.ts` 后运行 `node scripts/gen-catalog.mjs --write`
  重新生成 `docs/tool-catalog.md`（自动生成文件勿手改）。
- 冒烟验证脚本以 `_debug_*` / `_tmp_*` / `_verify_*` / `_probe*` 前缀放根目录，用完删除。
- 修改上下文压缩 / trimUnfinishedTurn / 工具结果回灌逻辑后，必须用真实 provider 做一轮冒烟。

## 发布与模板同步
- 功能改动后，若影响用户项目内的可用能力（hook、命令、技能、安全规则），
  同步更新 `project-template/`（`.agent/` 与 `.freeseek/hooks/` 模板 + AGENTS.md 章节），让新项目开箱即得。
- 内置技能在 `src/skills.ts BUILTIN_SKILLS` 维护；需要入盘模板时同步放 `project-template/.agent/skills/`。
