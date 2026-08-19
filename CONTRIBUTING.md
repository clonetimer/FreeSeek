# 贡献指南

感谢你参与 FreeSeek 的开发。本仓库有一套工程纪律（AGENTS.md），本文件是面向
贡献者的操作指南：改动前的约定、提交前必须过的门禁、测试要求与发布流程。

## 环境准备

```bash
npm install
npm run compile   # esbuild 构建（或 npm run watch 增量）
```

要求 Node ≥ 18，TypeScript 严格模式。

## 编码规范

- TypeScript 严格模式；**禁止未使用的变量/导入**（lint 会报，改完必须自查）。
- 字符串一律用单引号；2 空格缩进；行宽 ≤100。
- 每个**顶层导出符号必须有 JSDoc**（`scripts/check.mjs` 统计，warning 不阻塞，
  但新代码必须带上）。
- 不得引入新的运行时依赖除非确有必要（当前为纯 TS + VS Code API + Node 内置
  模块）；测试用 `node:test`，零依赖。
- 修改任何文件前先 `read_file` 拿最新内容，用 `replace_in_file` 做局部改动，
  禁止整文件盲改。

## 模块拆分契约

- 模块 ≤600 行；超限文件必须加文件头 `// check:max-lines N` 豁免（作为技术债
  登记），并在本会话内或近期拆出独立模块。
- **拆分完成后必须减小/移除豁免**。当前豁免清单见 `npm run check` 输出。
- 已有拆分先例：`promptFragments.ts`、`wsdiff.ts`、`goal.ts`、
  `components-*.ts`（webview 组件 12 模块）、`agent-subagent.ts` 等。

## 工程门禁（改动后必须过）

```bash
npm run check
```

`scripts/check.mjs` 三道门禁：

1. **typecheck**（`tsc -p tsconfig.check.json`，**硬性**，src 树须 0 错误）。
2. **hygiene 行数上限**（**硬性**）。
3. **导出 JSDoc 覆盖**（warning，可留 TODO）。

提交前必须 `npm run check` 全绿（warning 可留 TODO）。

## 测试

```bash
npm test
```

- 零依赖单测：`scripts/test.mjs` esbuild bundle `tests/*.test.ts` → `node:test`。
- **纯逻辑模块（goal/jobs/eventlog/context/promptFragments/skills/hooks 等）
  必须有单测**，改动核心逻辑时补/更新。
- 冒烟验证脚本以 `_debug_*` / `_tmp_*` / `_verify_*` / `_probe*` 前缀放根目录，
  **用完删除**。
- 修改上下文压缩 / trimUnfinishedTurn / 工具结果回灌逻辑后，**必须用真实
  provider 做一轮冒烟**。

## 系统提示词纪律（改动 prompt 组装时）

- 所有动态注入片段必须走 `assembleBoundedFragments`
  （`src/promptFragments.ts`）：单片段有上限、总量有硬上限、超限片段截断或
  丢弃并标注。
- 关键协议（REACT_PROTOCOL / NATIVE_TOOL_GUIDANCE）必须在组装结果之后追加，
  永不被截断。
- 「当前时间」片段用 `currentTimeBlock()`，刷新用 `refreshPromptTime()`（轻量替换）。
- 新增注入内容时，先评估大小；大内容（技能全文、长文档）只放索引，用工具
  按需加载（渐进式披露）。

## 安全改动纪律

- 新增工具/命令时：off 档也必须防灾难性命令（见 `sandbox.ts
  isDestructiveCommand` 与 `hooks.ts DANGEROUS_PATTERNS`，两处清单保持一致风格）。
- 文件编辑内容的静态安全扫描集中在 `hooks.ts scanFileContent`（9 类模式），
  新增模式加在那里。
- 可编程规则（hookify）新增事件/动作时，同步更新
  `project-template/.freeseek/hooks/` 示例。
- 安全模型完整文档见 [SECURITY.md](SECURITY.md)。

## 发布与模板同步

- 功能改动后，若影响用户项目内的可用能力（hook、命令、技能、安全规则），
  同步更新 `project-template/`（`.agent/` 与 `.freeseek/hooks/` 模板 +
  AGENTS.md 章节），让新项目开箱即得。
- 内置技能在 `src/skills.ts BUILTIN_SKILLS` 维护；需要入盘模板时同步放
  `project-template/.agent/skills/`。

## 发布流程

```bash
npm run release
```

`scripts/release.mjs` 一键发布：

1. 跑门禁（`npm run check`）。
2. 版本 bump。
3. 生产构建 + vsce 打包。
4. vsix 归拢 `releases/`。
5. 自动追加 `CHANGELOG.md`（从 README「更新记录」提取对应版本条目）。

### 更新记录规范

- 每个新版本在 README「更新记录」顶部加 `### vX.Y.Z（简短标题）` 小节，
  逐条列出用户可见变更。
- `release.mjs` 用正则 `^### v${next}` 从 README 提取条目写入 CHANGELOG.md，
  因此 README 的条目格式必须保持。
- 已发布的版本条目不要从 README 删除（release.mjs 依赖其作为提取源）。

## 文档

- 用户文档在 `docs/`（quickstart / providers / configuration / commands /
  settings / architecture），README 只保留简介 + 快速开始摘要 + 文档导航。
- 改动用户可见行为时，同步更新对应文档与 README 更新记录。


## Benchmark 任务贡献

修改 `benchmarks/v1` 或新增 benchmark suite 时：

1. fixture 必须离线可运行，v1 不引入第三方运行时依赖；
2. pristine workspace 至少失败一个 verifier；
3. public gold overlay 必须通过全部 command verifier；
4. 不要把 gold 放进 Agent workspace；
5. correctness verifier 不得用 token/step 数代替功能正确性；
6. 运行 `freeseek-bench validate --gold`、`npm run check` 与 `npm test`。

公开 suite 是持续回归集，不应宣称为未污染 holdout；排行榜/泛化结论应使用独立私有或 pinned real-repo suite。
