# FreeSeek 0.20.0 使用指南

## 1. 产品选择

| 产品 | 适用场景 | 入口 |
| --- | --- | --- |
| VS Code Extension | 编辑器内对话、代码修改、工具调用 | VS Code 扩展 |
| CLI | 终端、脚本、自动化、远程环境 | `freeseek` |
| ACP Host | 接入外部 ACP Client | `freeseek-acp` |
| Desktop | 不依赖 VS Code 的独立桌面 Agent UI | `FreeSeek.exe` |
| Eval / Bench | 回归评估和基准测试 | `freeseek-eval`, `freeseek-bench` |

## 2. CLI

Node.js >= 18。解压 CLI 包后：

```bash
node freeseek.js --help
node freeseek.js --version
```

Provider 可通过命令参数或环境变量配置，API Key 优先放环境变量，不建议写入脚本参数历史。

## 3. ACP Host

```bash
node freeseek-acp.js --base-url <provider-url> --model <model-id>
```

ACP Host 使用 NDJSON stdio，对外复用同一 FreeSeek Kernel，不是第二套 Agent。

## 4. Desktop

Windows x64：解压 Desktop ZIP，运行 `FreeSeek.exe`。Desktop 使用内置 ACP sidecar，不依赖系统 Node。

首次使用在 Settings 中配置 Provider。Windows Provider Secret 使用 DPAPI；配置文件本身不会持久化明文 Key。

## 5. 会话与恢复

Desktop 支持 durable session、history/load、resume。若 Agent 运行中进程被强制终止，下一次启动会根据 recovery marker 恢复同一 durable ACP session。

## 6. 安全边界

- Desktop Renderer 不直接读取 EventLog 或 ToolRuntime。
- Desktop 仅通过 preload IPC → DesktopRuntime → ACP sidecar → shared Kernel。
- Provider Key 不放 ACP argv，不长期保留在 Renderer/Main active state。
- 本套件未执行公共发布签名；不要把“unsigned local stable”误认为公开可信发行签名。
