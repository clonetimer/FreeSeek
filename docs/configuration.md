# 配置（手动配置示例）

所有设置均以 `freesek.` 为前缀，可在 VS Code 设置 UI 中搜索，也可直接编辑
`settings.json`。设置项速查表见 [settings.md](settings.md)，这里是典型场景的
完整 JSON 示例。

## 多提供商配置 `freesek.providers`

数组结构，每项字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 提供商唯一标识 |
| `name` | ✅ | 展示名称 |
| `baseUrl` | ✅ | OpenAI 兼容 Base URL |
| `apiKey` | ✅ | 支持 `${env:VAR}` 或 `${setting:freesek.xxx}` 插值 |
| `toolMode` | ✅ | `native`（原生 function calling）/ `react`（ReAct 文本协议） |
| `models` | ✅ | 数组，每项 `{ id, name? }` |
| `format` | | `openai` / `claude` / `gemini`（默认 openai） |
| `authType` | | 认证方式，如 `bearer` |
| `headers` | | 自定义请求头，支持 `${env:}` 插值 |
| `extraBody` | | 额外请求体透传 |
| `autoDiscoverModels` | | 自动拉取 `/v1/models`（LM Studio / Ollama 推荐） |

默认配置示例：

```jsonc
{
  "freesek.providers": [
    {
      "id": "deepseek-official",
      "name": "DeepSeek 官方",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "${setting:freesek.officialApiKey}",
      "toolMode": "native",
      "models": [
        { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash" },
        { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
      ]
    },
    {
      "id": "deepseek-free",
      "name": "FreeSeek 本地（逆向）",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "${setting:freesek.freeUserToken}",
      "toolMode": "react",
      "models": [
        { "id": "deepseek-chat", "name": "DeepSeek Chat（免费）" }
      ]
    },
    {
      "id": "lm-studio",
      "name": "LM Studio 本地",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "lm-studio",
      "toolMode": "native",
      "autoDiscoverModels": true,
      "models": [
        { "id": "qwen2.5-coder-7b-instruct", "name": "Qwen2.5-Coder 7B" }
      ]
    },
    {
      "id": "tencent-hunyuan",
      "name": "腾讯云混元",
      "baseUrl": "https://api.hunyuan.cloud.tencent.com/v1",
      "apiKey": "${env:TENCENT_HUNYUAN_API_KEY}",
      "toolMode": "native",
      "format": "openai",
      "authType": "bearer",
      "models": [
        { "id": "hunyuan-turbo", "name": "腾讯混元 Turbo（速度快）" },
        { "id": "hunyuan-pro", "name": "腾讯混元 Pro（更强）" },
        { "id": "hunyuan-standard", "name": "腾讯混元 Standard（均衡）" }
      ]
    }
  ]
}
```

> 当前选中的 `{providerId, modelId}` 存于 `freesek.activeModel`，由
> 「FreeSeek: 切换模型」自动写入，无需手动改。

## 免费方案专属配置

```jsonc
{
  "freesek.provider": "free",                       // 已废弃，仅供旧版兼容
  "freesek.freeBaseUrl": "http://127.0.0.1:8000/v1",
  "freesek.freeApiLocalPath": "",                   // 自定义本地 deepseek-free-api 源码目录
  "freesek.autoStartFreeServer": true,
  "freesek.freeUserToken": "eyJhbGciOiJ...",        // 必填，来自浏览器 LocalStorage
  "freesek.freeModel": "deepseek-chat"
}
```

免费方案完整上手流程见 [quickstart.md](quickstart.md)。

## 官方 API 专属配置

```jsonc
{
  "freesek.officialBaseUrl": "https://api.deepseek.com",
  "freesek.officialApiKey": "sk-...",               // https://platform.deepseek.com
  "freesek.officialModel": "deepseek-v4-flash"
}
```

## 安全与权限

```jsonc
{
  "freesek.allowShell": false,       // Agent 执行终端命令（高危，默认关）
  "freesek.allowNetwork": true,      // web_search / web_fetch 联网检索
  "freesek.sandboxMode": "off",      // off / readonly / sandbox
  "freesek.allowRules": [],          // 权限放行正则，如 ["^run_command .*npm test"]
  "freesek.denyRules": [],           // 权限拒绝正则，如 ["^write_file .*\\.env"]
  "freesek.confirmFileWrites": false // 每次写文件前弹权限确认
}
```

详见 [SECURITY.md](../SECURITY.md)。

## Agent 行为

```jsonc
{
  "freesek.maxSteps": 25,            // 单轮最多工具步数
  "freesek.autoVerify": true,        // 改动后自动 typecheck/lint/test
  "freesek.autoDistillSkills": true, // 会话后自动沉淀技能
  "freesek.autoCheckpoint": true,    // 写文件前自动 git stash 检查点
  "freesek.mode": "coder",           // coder / craft / plan / ask
  "freesek.systemPrompt": "",        // 自定义系统提示词
  "freesek.agentPresets": {}         // 自定义子代理角色
}
```

## MCP 服务

```jsonc
{
  "freesek.mcpServers": [
    {
      "name": "my-kb",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "KEY": "value" }
    },
    {
      "name": "http-kb",
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  ]
}
```

## 上下文与性能

```jsonc
{
  "freesek.contextBudget": 32000,     // Layer 7 上下文预算（token 估算）
  "freesek.maxWallClockMs": 600000,   // 单回合墙钟上限（毫秒）
  "freesek.offloadThreshold": 50000,  // 工具输出落盘阈值（字符）
  "freesek.commandTimeout": 120000    // run_command 硬超时（毫秒）
}
```
