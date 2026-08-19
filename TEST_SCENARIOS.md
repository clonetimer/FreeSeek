# FreeSeek 测试场景与质量回归手册

> 覆盖五维：性能 / 功能 / 安全 / 可靠 / UI 交互友好。
> 标注 [手动] 的需在扩展开发宿主（F5）中交互验证；[自动] 的可用脚本或构建命令验证。

## 0. 回归基线（每次改动后必跑）
- [自动] `node esbuild.js`：三个 bundle（extension/webview/mermaid）构建成功、无 error/warning。
- [自动] `node esbuild.js --production`：production 构建成功（minify）。
- [自动] 全文件 `read_lints`：零诊断。

---

## 1. 性能

| 场景 | 操作 | 预期 | 优先级 |
|---|---|---|---|
| P-1 大文件 diff | [手动] 让 Agent `edit_file` 一个 2000+ 行文件 | UI 不卡顿；diff 卡正常渲染（阈值>1M 行时走降级"整体对照"） | 高 |
| P-2 长会话 | [手动] 连续对话 30+ 轮 | token 估算/压缩不拖慢响应；落盘不阻塞（异步写队列） | 中 |
| P-3 Mermaid 懒加载 | [手动] 发送含 ```` ```mermaid ```` 的消息 | 首屏 bundle 不含 mermaid；命中时才加载 `dist/mermaid.js` | 中 |
| P-4 大文件读取 | [手动] `read_file` 无 limit 读超大文件 | 默认只读前 2000 行，不撑爆上下文 | 中 |

## 2. 功能

| 场景 | 操作 | 预期 | 优先级 |
|---|---|---|---|
| F-1 工具全链路 | [手动] 逐一触发 22+ 工具（read/edit/write/grep/search/lsp/run_command/verify/web_search/web_fetch/delete_file/spawn_agent/spawn_agents/mcp_* /promote_skill/remember/ask_user 等） | 无死代码、参数缺失友好报错 | 高 |
| F-2 并行子代理 | [手动] `spawn_agents` 派发 3 个独立任务 | 并行执行、结果按「### 子任务 N」合并 | 高 |
| F-3 CSV/TSV 预览 | [手动] 发送含 ```` ```csv ```` / ```` ```tsv ```` 代码块 | 渲染为 HTML 表格，可复制原始数据 | 中 |
| F-4 Slash 指令 | [手动] `/init` `/review` `/summarize` `/skills` `/compact` `/memory` `/clear` | 各指令按预期执行；`/summarize` 生成摘要 | 中 |
| F-5 会话 Tab | [手动] 多个会话间点击顶栏 Tab 切换 | Tab 显示最近会话、当前高亮、切换正确 | 中 |

## 3. 安全（重点，含修复回归）

| 场景 | 操作 | 预期 | 优先级 |
|---|---|---|---|
| S-1 守卫收口 | [手动] Plan 模式下让 Agent 调 `verify` / `delete_file` / `run_command` | 全部被拦截（统一 PLAN_BLOCKED） | 高 |
| S-2 SSRF 拦截 | [手动] Agent `web_fetch http://127.0.0.1:1234/` 或 `conn__http__request` 内网地址 | 被拦截提示「已阻止内网/本机地址」 | 高 |
| S-3 路径越界 | [手动] Agent 读写 `../secret.txt`（工作区外） | 被拒 | 高 |
| S-4 MCP 审批 | [手动] 首次调用 `mcp__xxx__tool` 与 `mcp_read_resource` / `mcp_get_prompt` | 均弹审批（允许/允许本次/拒绝）；拒绝不执行 | 高 |
| S-5 子代理 MCP 审批 | [手动] 子代理（spawn_agent/spawn_agents）调用 MCP 工具 | 仍弹审批（子代理继承父级回调） | 高 |
| S-6 凭据拦截 | [手动] sandbox/restricted 档下 `cat ~/.ssh/id_rsa` | 被拦（凭据路径检测） | 中 |
| S-7 XSS | [手动] 让模型输出含 `<img onerror>` / `<script>` 的 markdown | 被 DOMPurify 净化，不执行 | 中 |

## 4. 可靠（含本轮修复回归）

| 场景 | 操作 | 预期 | 优先级 |
|---|---|---|---|
| R-1 abort 竞态（回归） | [手动] Agent 运行中点「新建对话」，立刻发新消息 | 旧请求不误判 error（不弹错误气泡）；新对话正常 | 高 |
| R-2 会话切换竞态 | [手动] Agent 运行中切换会话 | 落盘一致、无错乱；切换后加载正确会话 | 中 |
| R-3 MCP 断连重连 | [手动] 杀掉 MCP server 子进程，再点「重新连接」 | 重连成功，工具恢复 | 中 |
| R-4 网络失败恢复 | [手动] provider 返回 500 / 流中断 | 友好报错，不卡死；可重试 | 中 |
| R-5 并行子代理异常 | [手动] `spawn_agents` 中某子任务失败 | 其它子任务不受影响；合并报告含失败信息 | 中 |
| R-6 落盘竞态 | [自动] 快速连续多轮对话后立即退出 | index/session/transcript 写队列串行，无截断/损坏 | 中 |

## 5. UI 交互友好

| 场景 | 操作 | 预期 | 优先级 |
|---|---|---|---|
| U-1 流式/停止 | [手动] 长回复中点「停止」 | 流式停止、状态恢复可输入 | 高 |
| U-2 空状态 | [手动] 全新会话/无历史/无技能/无 MCP | 各处有友好空状态提示，不空白 | 中 |
| U-3 错误信息 | [手动] 故意触发模型/网络错误 | 错误信息可理解（非裸异常/堆栈） | 中 |
| U-4 删除确认 | [手动] 技能管理删除技能 / 清空记忆 | 有二次确认 | 中 |
| U-5 面板可用性 | [手动] 设置/技能管理/MCP 管理/历史面板 | 各区块正常展开、操作生效、列表刷新 | 中 |

---

## 附：可自动化的核心纯函数（建议后续补单测）
- `unifiedDiff`（LCS + 降级阈值）
- `parseDelimitedRow`（CSV/TSV 解析）
- `parseClaudeLine` / `parseGeminiLine`（协议解析）
- `estimateTokens` / `conversationTokens`
- `trashPath`（回收站路由）
- `isInternalUrl`（SSRF 检测）
- `SkillManager.dedupe`（Jaccard 去重）
