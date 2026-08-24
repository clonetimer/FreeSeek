# FreeSeek SDK（0.25.0 新增）

FreeSeek SDK 是面向第三方（CI / 脚本 / 嵌入式应用）的官方 TypeScript 入口。它将内核能力整理为
一组与 VS Code 扩展宿主解耦的稳定 API，提供两条消费路径：

1. **库入口**：`import { freeseek } from "freeseek"`（或 `const { freeseek } = require("freeseek")`）；
2. **CLI 入口**：`freeseek-sdk <run|acp|version>`。

两者共享同一导出面（`src/sdk.ts`）。纯 Node 环境（`>=18`）下可安全加载：含 VS Code 宿主代码的
模块（如 ACP server）一律延迟 `require`，不触碰 `vscode`。

## 安装

源码构建：

```bash
npm ci
npm run compile
# 库入口：dist 内已生成 sdk 模块；CLI 入口：
node dist/freeseek-sdk.js version
```

使用 npm tarball 全局安装：

```bash
npm install -g ./freeseek-copilot-0.26.0.tgz
freeseek-sdk version
```

## CLI 用法

```text
freeseek-sdk run   --prompt "..." [--cwd dir] [--mode coder|plan|ask]
                   [--sandbox off|remote:docker@c] [--tui] [--yes] [--allow-shell]
freeseek-sdk acp   [--serve] [--port N] [--host 127.0.0.1] [--token t]
freeseek-sdk version
```

说明：`--cwd` 在 SDK CLI 层映射为 headless 的 `--workspace`；`--mode coder|plan|ask` 透传给
headless（0.25.0 起 headless 原生支持；`plan`/`ask` 为只读模式，非只读工具被拦截）。

示例：

```bash
# 一次 Agent 回合（底层复用 headless 运行时，无 VS Code 依赖）
freeseek-sdk run --prompt "修复测试失败并运行验证" --cwd ./my-project --allow-shell

# 启动 ACP v1 stdio Agent Server
freeseek-sdk acp --serve --port 4177

# 版本
freeseek-sdk version
```

## 库 API（`import { freeseek } from "freeseek"`）

`freeseek` 是默认 SDK 实例（`createFreeSeekSdk()` 的便捷单例），导出面如下：

| 命名空间 | 成员 | 说明 |
| --- | --- | --- |
| 顶层 | `runAgent` | 运行一次 Agent 回合：`runAgent(messages, tools, toolCtx, cb)`，返回最终消息数组 |
| 顶层 | `createToolRegistry(defs)` | 从工具定义构造注册表（`getByQualifier` / `execute`） |
| 顶层 | `createToolRuntime(ctx, registry)` | 工具运行时：preToolUse 审批、沙箱参数、权限回调编排 |
| 顶层 | `toolDefinitions` | 内置工具定义（read / run_command / glob / grep / edit / write 等） |
| `sandboxes` | `createRemoteCommandRunner({ transport, mapCwd })` | 构造远端 CommandRunner |
| `sandboxes` | `docker({ container, docker? })` | Docker 容器 transport |
| `sandboxes` | `ssh({ host, ssh?, sshArgs? })` | SSH 远端 transport |
| `sandboxes` | `e2b({ sandboxId, apiKey, baseUrl? })` | E2B 云沙箱 transport |
| `policy` | `compile(doc)` | 编译 ExecPolicy DSL 文档，返回 `(ctx: PolicyContext) => PolicyDecision` 判定函数 |
| `policy` | `load(raw)` | 校验并加载 ExecPolicy 文档（`version` 必填） |
| `policy` | `apply(base, decision)` | 把策略决策并入现有 ExecPolicy（`sandbox` 档强制 `sandboxMode=sandbox`；`deny`/`readonly` 经 `blocked` 硬拦截） |
| `acp` | `startServerCli(argv, io?)` | 启动 ACP server（stdio JSON-RPC，延迟装载） |

类型再导出：`ToolContext`、`CommandRunner`、`ToolDefinition`、`ExecPolicyDocument`、
`PolicyDecision`、`PolicyContext`、`ToolRegistryType`、`ToolRuntimeType`、`RemoteSandboxTransport`。

### 编程示例

```ts
import { freeseek, type ToolContext } from "freeseek";

// 1) 构造工具注册表与运行时
const registry = freeseek.createToolRegistry(freeseek.toolDefinitions);
const ctx: ToolContext = { workspaceRoot: process.cwd(), allowShell: true };
const runtime = freeseek.createToolRuntime(ctx, registry);

// 2) 运行一次 Agent 回合（runAgent 为位置参数：messages / tools / toolCtx / cb）
await freeseek.runAgent(
  [{ role: "user", content: "检查仓库结构并生成摘要" }],
  freeseek.toolDefinitions,
  { ...ctx, runtime, registry },
  {
    onAssistantText: (d) => process.stdout.write(d),
    onToolStart: (call) => console.log(`\n[tool] ${call.name}`),
    onToolResult: (call, result) => console.log(`[done] ${call.name}: ${result.slice(0, 80)}`),
    onStep: (step) => console.log(`[step ${step}]`),
  }
);

// 3) 声明式执行策略：compile 得判定函数 → 按上下文裁决 → apply 并入基础策略
const decide = freeseek.policy.compile({
  version: 1,
  default: "deny",
  rules: [
    { when: { cmd: "npm test" }, tier: "allow" },
    { when: { effect: ["destructive"] }, tier: "deny" },
  ],
});
const decision = decide({ command: "npm test", effect: "neutral", network: "allow" });
const base = { sandboxMode: "readonly", allowShell: false, network: { mode: "off" } } as const;
const { policy, blocked } = freeseek.policy.apply(base, decision);
```

### 远程沙箱示例

```ts
import { freeseek } from "freeseek";
import { createStaticRemoteWorkspaceMapper } from "./src/remote-sandbox";

const runner = freeseek.sandboxes.createRemoteCommandRunner({
  transport: freeseek.sandboxes.docker({ container: "my-container" }),
  mapCwd: createStaticRemoteWorkspaceMapper(process.cwd(), "docker:my-container", "/workspace"),
});
```

详见 `docs/remote-sandbox.md`。

## 与既有入口的关系

- `freeseek-sdk run` 复用 `src/headless.ts` 的 `runHeadless`，因此权限、审批、沙箱、checkpoint、
  durable session 语义与 `freeseek run` 一致；
- `freeseek-sdk acp` 复用 ACP server 入口，与 `freeseek acp` / `freeseek-acp` 同一宿主；
- SDK 库入口**只做再导出 + 轻量包装**，不实现第二套 Agent；运行时与扩展/headless 共享
  `agent → tool-registry → tool-runtime → event-log` 链路。
