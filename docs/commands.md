# 命令一览

所有命令通过命令面板（`Ctrl+Shift+P`）执行，前缀为 `FreeSeek:`。

## 命令面板命令

| 命令 | ID | 说明 |
| --- | --- | --- |
| FreeSeek: 打开编程助手 | `freesek.openChat` | 打开侧边栏编程助手视图 |
| FreeSeek: 新建对话 | `freesek.newChat` | 新建一个空对话 |
| FreeSeek: 打开历史对话 | `freesek.openHistory` | 打开历史会话列表 |
| FreeSeek: 恢复历史会话 | `freesek.resumeSession` | 列出全部非归档会话供选择恢复（对齐 Codex / Claude Code 的会话恢复语义） |
| FreeSeek: 清空当前对话 | `freesek.clearConversation` | 清空当前会话上下文 |
| FreeSeek: 切换模型 | `freesek.switchModel` | 在多个提供商 / 模型间切换 |
| FreeSeek: 添加提供商 | `freesek.addProvider` | 弹窗表单向导添加提供商（预设服务商一键选择 + API Key 预填 + 保存后连通性测试） |
| FreeSeek: 在设置中编辑提供商 | `freesek.editProviders` | 跳转到 settings.json 的 `freesek.providers` |
| FreeSeek: 管理 MCP 服务 | `freesek.manageMCP` | MCP server 连接状态 / 传输 / 工具清单 + 重新连接 |
| FreeSeek: 启动免费 DeepSeek 服务 | `freesek.startFreeServer` | 以 Docker 或 Node 方式拉起 `deepseek-free-api` |
| FreeSeek: 打开 Slash 命令 | `freesek.openCommands` | 打开自定义 Slash 命令 |
| FreeSeek: 打开当前会话事件日志（回放） | `freesek.openSessionLog` | 打开当前会话的 eventlog 事件日志，用于回放 / 排查 |
| FreeSeek: 分叉当前对话 | `freesek.forkSession` | 以当前对话为起点分叉出新会话 |
| FreeSeek: 重命名当前会话 | `freesek.renameSession` | 重命名当前会话 |

## Slash 命令（对话内输入）

在对话输入框内以 `/` 开头输入：

| 命令 | 说明 |
| --- | --- |
| `/init` | 初始化项目（生成 AGENTS.md 等工程规范） |
| `/review` | 代码审查 |
| `/compact` | 压缩 / 总结上下文 |
| `/memory` | 查看 / 管理记忆 |
| `/clear` | 清空当前对话 |
| `/summarize` | 生成当前对话的结构化摘要 |
| `/skills` | 打开技能管理面板 |

> 自定义 Slash 命令：项目 `.agent/commands/` 下的 `.md` 文件会被识别为自定义
> 命令。Agent 调用 `slash_command` 执行自定义命令前会弹窗让用户审核确认
> （命令可能含危险操作）。

## 对话内按钮

- **模式切换**：Plan / Ask / Craft / Coder 四态按钮实时切换（对应 `freesek.mode`）。
- **添加提供商**：顶栏模型下拉内的「添加/编辑提供商」入口。
- **对话跳转**：聊天区右下角浮动按钮，列出全部消息书签（序号 + 角色图标 + 摘要），平滑滚动定位。
