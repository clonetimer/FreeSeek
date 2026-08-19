# 设置项速查表

所有设置以 `freesek.` 为前缀。完整手动配置示例见 [configuration.md](configuration.md)。

## 免费方案

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.provider` | `free` | 【已废弃，仅供旧版兼容】模型接入方式，改用 `freesek.providers` |
| `freesek.freeBaseUrl` | `http://127.0.0.1:8000/v1` | 免费服务 OpenAI 兼容 Base URL |
| `freesek.freeApiLocalPath` | `""` | 本地 deepseek-free-api 源码目录（留空用扩展内置 vendored 源码） |
| `freesek.autoStartFreeServer` | `true` | 扩展激活时自动检测并启动免费服务 |
| `freesek.freeUserToken` | `""` | 【免费模式必填】网页端 userToken（浏览器 LocalStorage 获取） |
| `freesek.freeModel` | `deepseek-chat` | 免费服务模型名 |

## 官方 API

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.officialBaseUrl` | `https://api.deepseek.com` | 官方 API Base URL |
| `freesek.officialApiKey` | `""` | 官方 API Key（platform.deepseek.com） |
| `freesek.officialModel` | `deepseek-v4-flash` | 官方模型名 |

## 多提供商

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.providers` | 见内置默认 | 多提供商数组，每项 id/name/baseUrl/apiKey(支持 `${env:}`/`${setting:}`)/toolMode/models 等 |
| `freesek.activeModel` | `null` | 当前选中的 `{providerId, modelId}`（自动写入） |

## 安全与权限

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.allowShell` | `false` | 允许 Agent 执行终端命令（高危，默认关） |
| `freesek.allowNetwork` | `true` | 允许联网检索与抓网页（独立于 allowShell） |
| `freesek.sandboxMode` | `off` | `off` / `readonly` / `sandbox`（OS 沙箱） |
| `freesek.sandboxNetwork` | `{mode:"off",...}` | sandbox 档网络出网策略（off / localhost / allow） |
| `freesek.sandboxFailIfUnavailable` | `false` | 沙箱引擎缺失时硬拦截（true）或软降级（false） |
| `freesek.commandTimeout` | `120000` | run_command 硬超时（毫秒） |
| `freesek.allowRules` | `[]` | 权限放行正则数组 |
| `freesek.denyRules` | `[]` | 权限拒绝正则数组（优先级最高） |
| `freesek.confirmFileWrites` | `false` | 每次写文件弹权限确认框 |

## Agent 行为

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.maxSteps` | `25` | 单轮最多自动执行的工具步数（防死循环） |
| `freesek.autoVerify` | `true` | 改动后自动 verify（typecheck/lint/test），驱动「写→跑→修」闭环 |
| `freesek.autoDistillSkills` | `true` | 会话后自动沉淀可复用技能（pending 待审核） |
| `freesek.agentPresets` | `{}` | 自定义子代理角色（覆盖内置 explore/plan/verify/general） |
| `freesek.systemPrompt` | `""` | 自定义系统提示词（留空用内置） |
| `freesek.mode` | `coder` | 对话模式：coder / craft / plan / ask |
| `freesek.autoCheckpoint` | `true` | 写文件前自动 git stash 检查点（可 rewind 回滚） |
| `freesek.autoFormat` | `true` | 编辑后自动用 VS Code formatter 格式化 |
| `freesek.importAutoRead` | `true` | 导入对话后自动通读工作区生成状态摘要 |

## 上下文与性能

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.contextBudget` | `32000` | Layer 7 上下文预算（70% 预警 / 85% 自动压缩） |
| `freesek.maxWallClockMs` | `600000` | 单回合墙钟上限（毫秒） |
| `freesek.offloadThreshold` | `50000` | 工具输出落盘阈值（字符） |
| `freesek.debugVerbose` | `false` | 调试：打印完整请求体 JSON |

## 外部服务

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.mcpServers` | `[]` | 外部 MCP server 数组（stdio / http） |
| `freesek.browserPort` | `9222` | browser 工具 CDP 调试端口 |

## 存储与提示音

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `freesek.storageDir` | `""` | 历史会话 / 转录 / 记忆存储目录（留空=VS Code 全局存储） |
| `freesek.soundStart` | `true` | 会话开始提示音 |
| `freesek.soundDone` | `true` | 任务完成 / 停止 / 出错提示音 |
