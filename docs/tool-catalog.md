# 工具目录（Tool Catalog）

> 本文件由 `scripts/gen-catalog.mjs` 从 `src/tools/defs.ts` 的 TOOL_DEFINITIONS 自动生成，**勿手改**。
> 重新生成：`node scripts/gen-catalog.mjs --write`

共 **37** 个内置工具（不含 MCP / 连接器动态注入的工具；实际可用集合由 `getAllToolDefinitions()` 合并）。
参数列中带 `*` 为必填。

## 文件与代码

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `read_file` | 读取文件内容。可指定起始行与行数。用于查看代码、配置。 | path*, offset, limit |
| `write_file` | 创建或覆盖写入文件。用于新建/修改代码、文档。自动按原文件编码写回（保留 GBK/UTF-16 等非 UTF-8 编码），并在文件已被外部修改时做冲突检测。 | path*, content*, force |
| `list_directory` | 列出目录内容（含子目录标记）。 | path |
| `search_files` | 按文件名模式递归查找文件，支持 * 与 ** 通配。 | pattern* |
| `grep` | 在工作区内按正则/关键字搜索文件内容，返回匹配行。 | pattern*, path, include |
| `edit_file` | 精确字符串替换（不重写整个文件）。提供 old_string 与 new_string；若 old_string 出现多次，需设 replace_all=true 或提供更多上下文。省 token，对齐 Claude Code 的 Edit。 | path*, old_string*, new_string*, replace_all, force |
| `glob` | 按文件名模式匹配（如 '**/*.ts'、'src/**/*.json'）。比 search_files 更贴合 glob 语义，用于快速定位文件。 | pattern* |
| `delete_file` | 安全删除文件/目录（Safe-Delete）：删除操作转为移入系统回收站，可恢复，避免误删。删除前会读取目标内容供你确认。不可删除工作区外的路径。 | path*, recursive |

## 命令与执行

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `run_command` | 在工作区内执行一条 shell 命令并返回 stdout/stderr。仅在用户开启 allowShell 时可用。命令需要 stdin 确认时用 input 提供（非交互式终端，但可注入输入）。 | command*, cwd, input |
| `verify` | 运行项目的验证（质量门禁）：根据项目类型自动执行 typecheck / lint / test（如 tsc --noEmit、npm run lint、npm test）。返回结构化结果：通过/失败、执行命令、以及失败时按「文件:行」解析出的错误定位列表。用于在改动后自动验证并驱动修复循环（Agentic Engineering 的写→跑→修闭环）。可指定 command 覆盖自动探测。需 allowShell 开启。 | command, kind（auto/typecheck/lint/test） |
| `run_python` | 执行一段 Python 代码（专门的 Python 运行器）。pandas / numpy / matplotlib 等常用科学计算库已随运行环境自动可用；matplotlib 生成的图表会自动渲染进聊天。适合数据分析、统计、可视化、CSV/Excel 处理。带超时与输出截断（防止长输出撑爆上下文）。需要 freesek.allowShell 开启。 | code*, timeout, cwd |
| `run_code` | 通用代码执行器（Code Mode）：在沙箱内执行代码片段，适合计算、数据转换、脚本验证等不落盘的轻量任务。language 支持 python（pandas/numpy/matplotlib 自动可用，图表自动渲染）/ javascript（Node 的 .mjs）/ typescript（Node，自动擦除类型注解）/ bash（shell，走 run_command 沙箱通道）。带超时与输出截断，防撑爆上下文。需要 freesek.allowShell 开启。 | language（python/javascript/typescript/bash）, code*, timeout, cwd |

## 计划与目标

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `todo_write` | 写入/覆盖当前任务清单（Claude Code 式：每次调用给出完整列表）。用于多步骤任务的规划与进度跟踪。每项含 content 与 status（pending/in_progress/completed）。每开始一步置 in_progress，完成置 completed。 | todos* |
| `todo_read` | 读取当前任务清单，返回各任务的状态。用于在多步任务中确认进度。 | — |
| `goal` | 目标状态机（区别于 todo_write 的步骤清单：goal 跟踪『为什么做』，todo 跟踪『怎么做』）。op=create 登记新目标（max_rounds 可选设置轮次预算，0=不限，防止无限绕圈）；edit 改目标/预算；pause 暂停；resume 恢复；complete 完成；block 标记受阻（附 reason）；clear 清空。目标跨压缩、跨会话持久：恢复历史会话后自动重新注入当前目标。 | op*（create/edit/pause/resume/complete/block/clear）, objective, max_rounds, reason |
| `goal_view` | 查看当前目标状态（目标描述 / 阶段 / 已用轮次与预算 / 受阻原因）。 | — |

## 记忆与技能

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `load_skill` | 按需加载某个技能的完整 SOP（系统提示词中已列出可用技能名与描述）。返回该技能 SKILL.md 全文。 | name* |
| `remember` | 把一条值得跨会话记住的信息写入持久记忆（用户偏好、项目约定、踩过的坑等）。scope=user 写入用户级记忆（跨所有项目），scope=project 写入项目级记忆（.agent/memory，随项目）。下次会话自动注入系统提示词。 | content*, scope（user/project） |
| `promote_skill` | 技能自动激活（验证门控）：当你用某个 pending（待审核）技能完成了一次真实任务、且已通过 verify 验证后，调用本工具激活该技能（status: pending → active），使其后续可被自动加载。若技能不存在或已激活会提示。 | name* |

## 子代理与团队

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `spawn_agent` | 派发一个独立上下文的子智能体去探索代码库或执行子任务，它只把一页结论交回，保持主上下文干净。用于理解陌生模块、技术调研、大规模搜索、并行实现。参数：agent=角色定义文件名（.codebuddy/agents/ 或 .agent/agents/<name>.md，可选）；role=角色预设名（系统提示词「可用子代理」清单中的名字：内置 explore(只读探索)/plan(只读规划)/verify(读+跑测试验证)/general(可改通用) 及用户自定义角色）；mode=explore（只读）或 executor（可改），当未指定 role 时作为默认；provider/model=可选，指定该子智能体使用哪个提供商/模型（多模型分工，如规划用便宜模型、写代码用强模型），省略则与主 Agent 共用全局活动模型；worktree=可选，指定在某 Git 工作树内独立运行，实现并行改不同模块且互不覆盖；run_in_background=可选 true，后台异步运行并在完成时通知，不阻塞主流程。 | agent, provider, model, task*, name, role, mode（explore/executor）, worktree, run_in_background |
| `spawn_agents` | 并行派发多个独立子智能体（Promise.all 同时运行），各自独立上下文并行执行，最后合并交回各子智能体的结论。用于可拆分的多任务并行（如分别调研多个模块、并行实现互不依赖的改动）。比逐个 spawn_agent 更快。每个子任务参数同 spawn_agent（task 必填，role/mode/worktree 可选）。 | agents* |
| `create_worktree` | 新建一个 Git 工作树（<root>/.worktrees/<name>），含独立文件副本与分支 worktree/<name>，用于派发子智能体并行修改不同模块而不互相覆盖。需工作区为 git 仓库。返回该工作树路径，可传给 spawn_agent 的 worktree 参数。 | name*, branch, base |
| `remove_worktree` | 移除一个 Git 工作树（含其分支）。仅移除工作副本，已合并的内容不受影响。 | path* |
| `list_worktrees` | 列举当前仓库的全部 Git 工作树（含主工作树），返回路径与分支，便于选择派发目标。 | — |
| `send_message` | 向一个此前用 spawn_agent 派发并指定了 name 的命名子智能体发送后续消息，使其在已有上下文上续跑并交回新结论（即 Agent Teams 寻址，对标 Claude Code SendMessage）。target 为该子智能体的 name。 | target*, message* |
| `job_list` | 列出全部后台任务（run_in_background 启动的子智能体）：ID / 状态 / 标签 / 起止时间。 | — |
| `job_output` | 读取某个后台任务已收集的输出分片（完成/运行中均可读）。 | id* |
| `job_kill` | 终止某个后台任务（标记为 killed，其完成通知将被抑制）。 | id* |

## 检查点

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `checkpoint` | 创建检查点：把当前工作区全部改动（含未跟踪文件）暂存为一个命名的 freesek 检查点，形成可回溯时间线，便于后续 rewind 回滚到任意历史点。name 可选，便于定位；不填自动生成。需工作区为 git 仓库。对标 Claude Code 的自动 Checkpoints / rewind。 | name |
| `rewind` | 回滚到指定检查点：恢复该检查点暂存的改动，并丢弃其后创建的所有更晚检查点（时间线截断）。name 可选：不填则回滚到最近一次检查点；填 name 则回滚到该命名检查点并截断其后检查点。需工作区为 git 仓库且存在对应检查点。 | name |
| `list_checkpoints` | 列出当前工作区全部 freesek 检查点时间线（含自动检查点与命名检查点），显示每个检查点的标识与摘要，供 rewind 选择回滚到任意历史点。需工作区为 git 仓库。 | — |

## 联网与浏览器

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `web_search` | 联网搜索：向公开搜索引擎发起查询并返回相关结果（标题/链接/摘要）。用于查找最新文档、API 用法、报错含义、技术方案等模型记忆可能过时或不确定的信息。 | query*, max |
| `web_fetch` | 抓取指定 URL 的网页内容并转换为可读文本。用于阅读文档页、博客、GitHub README 等以获取详细内容。仅 http/https。 | url* |
| `browser` | 浏览器操作（CDP 控制真实 Chrome/Edge，或自动拉起 headless 实例）。适合验证网页效果、抓取动态页面、登录后操作、截图回显。动作：navigate{url} 打开页面并返回标题与正文；click{selector} 点击元素；type{selector,text} 输入文本；press{key} 按键；evaluate{expression} 执行 JS 并返回结果；screenshot{name?} 截图并渲染进聊天；list 列出标签页；status 查看当前页面；close 关闭连接。页面正文默认截断 3000 字符。仅在 Craft 模式可用（plan/ask 会拦截）。 | action*（navigate/click/type/press/evaluate/screenshot/list/status/close）, url, selector, text, key, expression, name |

## 代码智能

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `lsp` | 语义级代码导航（Language Server Protocol）：查找符号的定义（definition）、所有引用（references）、文件内符号（documentSymbols）、工作区符号（workspaceSymbols）。比文本 grep 更准确，用于理解代码结构与调用关系。 | action（definition/references/documentSymbols/workspaceSymbols）, file, line, character, query |

## 交互与指令

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `ask_user` | 向用户提问并等待回答（用于澄清需求、确认高风险操作）。可提供结构化多选项（对齐 Claude Code Interactive Questions）：传 options 时用户从选项中选，不传则为自由文本输入。 | question*, options, multiSelect |
| `slash_command` | 执行一个用户自定义 Slash 命令（项目 .agent/commands/<name>.md）。不传 name 时列出全部可用命令；传入 name（和可选 args）时返回该命令展开后的提示词（将正文中的 $ARGUMENTS 替换为 args），供你按此指令继续工作。用于在对话中复用项目级预设工作流。 | name, args |

## 权限与可用性说明

- `run_command` / `verify` / `run_python` / `run_code` 需 `freesek.allowShell` 开启（默认关闭）。
- `web_search` / `web_fetch` / `browser` 受 `freesek.allowNetwork` 控制（默认开启）；`browser` 仅在 Craft 模式可用（plan/ask 拦截）。
- `delete_file` 为 Safe-Delete（转系统回收站），且不可删除工作区外路径。
- `verify` / `run_code` / `run_python` 等带超时与输出截断，防长输出撑爆上下文。
- 动态工具：MCP server 工具以 `mcp__<name>__<tool>` 注入；连接器工具以 `conn__<id>__<tool>` 注入，均不由本目录收录。
