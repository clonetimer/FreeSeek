# FreeSeek 产品形态部署与使用总览

FreeSeek 是**单 Kernel 多宿主**平台：所有形态共享 `runAgent → ToolRegistry → ToolRuntime → EventLog`，
权限/沙箱/会话语义一致，只是交互入口不同。本目录按形态给出**部署**（环境要求、构建、启动、配置、安全默认）与**使用说明**（操作、命令、边界）。

## 形态矩阵

| 形态 | 定位 | 入口 | 部署文档 | 使用场景 |
| --- | --- | --- | --- | --- |
| Core（嵌入） | Agent/Kernel 库 | 源码嵌入 | [core-embedded.md](core-embedded.md) | 二次开发 / 自建宿主 |
| CLI / Headless | 终端 / CI / 自动化 | `freeseek run/eval/bench/acp/web/doctor/sessions/replay` | [cli-headless.md](cli-headless.md) | 脚本、CI、长任务 |
| ACP Agent Server | 标准 ACP v1 stdio 协议宿主 | `freeseek acp` / `freeseek-acp` | [acp.md](acp.md) | 第三方客户端 / 桌面壳 |
| Web Console | 本地回环 HTTP + 浏览器端 | `freeseek web` / `freeseek-web` | [web-console.md](web-console.md) | 浏览器即开即用（0.24+） |
| VS Code | 编辑器原生宿主（旗舰交互） | VSIX / 源码调试（F5） | [vscode.md](vscode.md) | 交互式编码、diff/审批/LSP |
| Desktop | Electron 壳 → ACP → Kernel | Desktop app | [desktop.md](desktop.md) | 桌面窗口、无编辑器场景 |
| Eval / Bench | 评测/回归基准 | `freeseek eval` / `freeseek bench` | [eval-bench.md](eval-bench.md) | CI 回归、模型对比 |

## 通用前提

- Node.js >= 18（H4 Linux untrusted sandbox 需 Node >= 22 且 Linux namespace/chroot 可用）。
- 源码构建：`npm ci && npm run compile`（需可写 npm cache 目录）。
- Provider 凭据：环境变量 `FREESEEK_BASE_URL` / `FREESEEK_API_KEY` / `FREESEEK_MODEL`，或各形态的参数/配置入口；
  不要放进 shell history 或进程 argv（可读性优先用环境变量）。
- 安全默认（所有形态一致）：shell/代码执行默认关闭（`--allow-shell` 或对应配置才开启）；
  写入与高风险能力默认自动放行或需审批；网络默认开启（`--no-network` 关闭）；
  H4 untrusted sandbox 仅 Linux，其它平台 fail-closed。

## 会话与持久化

所有宿主共用 durable EventLog（`events-<session-id>.jsonl` + 内容寻址 blob + 可重建索引）：
- CLI：`freeseek sessions` / `freeseek replay <id>` / `--resume <id>` / `--fork <id> --at <seq>`
- ACP：`session/list` / `session/resume` / `session/load` / `session/close`
- Web Console：UI 侧栏会话列表，点击即恢复历史
- Desktop：会话历史侧栏 + resume
- VS Code：历史会话树、恢复历史会话命令、分叉当前对话

## 选用建议

- 追求编辑体验、diff 审查、LSP：VS Code。
- 自动化 / CI / 无头：CLI/Headless。
- 自研客户端/壳：ACP（协议固定）。
- 想最快上手且偏好浏览器：Web Console（0.24 起）。
- 独立桌面应用：Desktop。
- 评测与版本回归：Eval/Bench。