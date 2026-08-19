# FreeSeek Persistence + Headless Kernel — Refactor Notes

本轮基于上一版 **ToolRegistry + EventLog** 源码继续推进，目标是让 durable replay 具备完整内容恢复、代码状态锚点和无 VS Code 宿主运行能力。

## 已完成

- 新增 `src/content-store.ts`：SHA-256 content-addressed blob store；多模态引用去重、完整性校验、会话删除 GC。
- `src/eventlog.ts`：图片/附件引用可完整 hydrate；`deriveConversationAtSeq`；`turn/start|end`、`step/start|end`、`checkpoint`、`session/fork`；完整 projection 才允许 crash recovery/fork。
- 新增 `src/workspace-timeline.ts`：shadow checkpoint 与 event seq 的统一绑定入口。
- `src/checkpoints.ts`：checkpoint metadata 查询；`materializeCheckpoint` 用临时 shadow index 将历史代码物化到独立目录。
- `src/tool-runtime.ts`：潜在 workspace mutation 完成后记录 post-state checkpoint，使 `tool/result` 边界对应可恢复代码状态。
- `src/agent.ts`：main turn baseline checkpoint；完整 turn/step 生命周期；异常 step 自动闭合。
- `src/storage.ts`：session JSON 丢失/损坏时仅从 `complete=true` EventLog 恢复。
- 新增 `src/headless.ts`：复用真实 Agent/ToolRegistry/ToolRuntime/EventLog 的最小 Headless CLI；支持 resume/fork。
- `src/providers.ts` / `src/debug.ts` / `src/hooks.ts` / `src/lsp.ts` / `src/provider-secrets.ts` 等核心路径改为 host 注入/懒加载，去除 Headless 启动时的 VS Code runtime 依赖。
- `scripts/test.mjs`：esbuild 平台不匹配时自动 fallback 到 `tsc + node:test`。
- 修复 OpenAI-compatible streaming tool-call 首个 `function.name` 分片被重复拼接的问题；此前 fuzzy tool-name correction 会掩盖该错误，但 durable replay 会被污染。
- `esbuild.js` 同时生成 `dist/extension.js` 与 `dist/freeseek-headless.js`；package 暴露 `freeseek` bin。

## Fork 语义

Headless historical fork 不允许只回放旧对话却继续在当前 workspace 上运行。它要求 boundary 前存在 checkpoint anchor，并把该 shadow commit 物化到：

`<session-dir>/fork-workspaces/<target-session-id>/`

随后新 Agent 仅在这个隔离工作区继续运行，源工作区不变。

## 验证

- `node scripts/check.mjs`：通过（source/test typecheck、hygiene、Runtime boundary；仅保留仓库已有 JSDoc warning）。
- `node scripts/test.mjs`：跨平台 tsc fallback 可运行全部测试。
- Headless E2E：本地 fake OpenAI SSE → `write_file` → final response；不开 shell、`--yes` 时文件写能力独立可用；durable `turn/step/tool` 生命周期成对。
- Headless fork E2E：在 `tool/result` event 边界分叉，隔离 workspace 能恢复刚写入的文件，源 workspace 不被修改。
- 单独 tsc emit 后，在没有 VS Code runtime module 的 Node 启动路径执行 `headless --help` 成功。

## 暂未宣称完成

- 外部数据库/网络副作用不可通过 workspace checkpoint 回滚。
- shadow Git 仍尊重 `.gitignore`，忽略文件不会被 historical workspace 物化。
- Headless 首版只提供简化 OpenAI-compatible CLI provider 配置；完整 Provider/MCP config file 尚未抽成独立 host package。
- EventLog 目前按文件扫描，尚未增加 sparse index / 大历史增量查询。
- 当前审计环境的既有 `node_modules` 是 Windows esbuild 包，因此没有生成并冒充正式可发布 VSIX；源码与 tsc/node:test 路径已完整验证。
