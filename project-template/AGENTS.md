# Project Rules

> 本文件由 FreeSeek Coder 自动分层加载（Layer 1: Agent Rules）。
> 放在项目根目录即对项目全局生效；子目录放同名文件可对模块追加规则。
> 原则：单文件 ≤200 行、只写「删掉这行 Agent 就不会遵守」的硬规则、定期 ruthlessly edit。

## 禁止事项
- 不要直接修改 `.env` / credentials 文件。
- 不要在未经确认的情况下执行 `git push --force`。
- 不要跳过测试提交代码。

## 编码风格
- TypeScript: 遵循项目 `.eslintrc`，行宽 100，使用 2 空格缩进。
- 提交前必须通过 `npm run lint`。
- 优先用 `edit_file` 做局部修改，避免整文件重写。

## 测试
- 运行测试: `npm test`（前端）/ `pytest tests/`（Python）。
- 新增功能必须附带测试；修改核心逻辑必须跑全量测试。

## 提交流程
- 分支命名: `feature/xxx`、`fix/xxx`、`refactor/xxx`。
- 提交信息遵循 conventional commits 格式。
- 提 PR 前自测通过（可用 `load_skill commit-push-pr` 走标准流程）。

## 可编程 Hook 规则（hookify）
- 在 `.freeseek/hooks/*.md` 放置规则文件即可热加载（无需重启），示例见 `.freeseek/hooks/`。
- 支持 `event: bash | file | prompt | stop | all`、`action: warn | block`、`pattern`（简单正则）或 `conditions`（多条件）。
- 全局规则放 `~/.freeseek/hooks/*.md` 跨项目生效。

## FreeSeek 的模型可见上下文纪律
- 系统提示词中的每条注入片段（规则 / 记忆 / 技能索引 / 工具清单…）都有大小上限，超限片段会被截断并在头部标注 ⚠️；总量超过硬上限的低优先级片段会被整体丢弃并列出清单。请保持本文件精简（≤200 行），核心信息放前面，否则可能被截断。
- 模型会自动感知「当前时间」：长会话中每次提问都会刷新时间片段，不需要你手动补充日期。

## 工作区变更检测
- 每次 `run_command` 前后会自动对比 git 工作区状态。若命令产生了未声明的文件改动，模型会收到 ⚠️ 提示并要求核实/回滚。因此：
  - 执行会改动文件系统的命令（如构建、格式化、迁移）时，请先明确告诉模型预期改动，避免误判。
  - 需要暂存/提交时用标准流程（git add / commit / push），这属于有意操作。

## 技能依赖（requires）
- 技能 SKILL.md 的 frontmatter 可声明 `requires: skill-a, skill-b`；`load_skill` 加载时会自动先加载依赖技能全文（递归、防循环），缺失的依赖会给出提示。
- 技能索引（系统提示词中的「可用技能」）会标注每个技能的依赖关系。

## 技能所需工具（tools）
- 技能 SKILL.md 的 frontmatter 可声明 `tools: read_file, run_command`（逗号分隔工具名）。
- `load_skill` 加载时校验工具是否可用：缺失只给出提示、不阻塞技能使用（加载时审查而非运行时发现）。
- 技能索引会标注每个技能声明的工具。

## 专家套件（可逆安装）
- 套件 = 目录下 `plugin.json` 清单 + `skills/` + `commands/` + `agents/`，安装后落到 `.agent/` 下自动生效。
- 套件 `plugin.json` 可声明 `requires: ["skill-a"]`：安装时校验依赖，缺失会告警但不阻塞。
- 安装会登记到 `.agent/kits.json`（文件清单 + 版本 + 时间）；卸载依据登记删除套件安装的文件（只删 `.agent/` 内文件，不触碰项目自建内容）。
