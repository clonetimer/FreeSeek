# Remote Sandbox Seam（0.25.0 落地）

`src/remote-sandbox.ts` 是 CommandRunner seam 的远端 provider。0.25.0 落地三态 transport：
**Docker（本地容器）、SSH（远端主机）、E2B（云沙箱）**，并接入 headless 的 `--sandbox remote:*`。

设计要点：只定义**执行协议与明确的 workspace mapping**，不偷偷实现文件同步。
本地 `cwd=/Users/a/repo` 并不意味着远端存在相同目录。调用方必须把本地 workspace
预先 provision 到远端，再提供 transport + mapCwd。

## CLI 用法（推荐）

headless 统一入口 `--sandbox`：

```bash
# Docker 容器隔离执行
freeseek run --workspace ./my-project --prompt "..." \
  --sandbox remote:docker@my-container

# SSH 远端执行（user@host）
freeseek run --workspace ./my-project --prompt "..." \
  --sandbox remote:ssh@user@my-host

# E2B 云沙箱（需要 E2B_API_KEY 环境变量）
export E2B_API_KEY=...
freeseek run --workspace ./my-project --prompt "..." \
  --sandbox remote:e2b@<sandbox-id>
```

`sandbox` 取值：`off | readonly | sandbox | remote:docker@<c> | remote:ssh@<user@host> | remote:e2b@<id>`。
前三个是既有本地模式；`remote:*` 为 0.25.0 新增，只影响 `run_command` 的执行位置，
权限、审批、ExecPolicy 等仍统一由 Runtime 处理。

## SDK 用法（编程式）

通过 SDK 的 `sandboxes` 命名空间构造远端 runner。`mapCwd` 需要 workspace mapper：
SDK 默认实例导出 `createRemoteCommandRunner` 与三种 transport；mapper 构造器
`createStaticRemoteWorkspaceMapper(localRoot, workspaceId, remoteRoot)` 位于
`src/remote-sandbox.ts`，使用 SDK 时从源码模块引入：

```ts
import { freeseek } from "freeseek";
import { createStaticRemoteWorkspaceMapper } from "./src/remote-sandbox"; // 或从包源码对应模块

const runner = freeseek.sandboxes.createRemoteCommandRunner({
  transport: freeseek.sandboxes.docker({ container: "my-container" }),
  mapCwd: createStaticRemoteWorkspaceMapper(process.cwd(), "docker:my-container", "/workspace"),
});
setCommandRunner(runner);
```

三种 transport 构造器：

| transport | 构造器 | 参数 |
| --- | --- | --- |
| Docker | `createLocalDockerRemoteSandboxTransport` | `{ container, docker? }` |
| SSH | `createSshRemoteSandboxTransport` | `{ host, ssh?, sshArgs? }` |
| E2B | `createE2BRemoteSandboxTransport` | `{ sandboxId, apiKey, baseUrl? }` |

## 执行协议

远端执行接收 `RemoteSandboxRequest v1`：workspace id、remote cwd、command/argv、timeout、
stdin、network mode 与 restricted intent；返回 exitCode/stdout/stderr/timedOut/cancelled。

## 安全约束

- `cwd` 必须位于映射的 local root；存在路径会 realpath 后再做 containment；
- remote token 对非 loopback HTTP endpoint 禁止发送，必须 HTTPS；
- AbortSignal 会传播到远端执行；
- provider 不接管 ToolRuntime 的 approval/policy；远端执行仍然发生在统一 Runtime 之后；
- 当前没有 workspace upload/sync/download。下一阶段应把 filesystem/subprocess 收成同一个
  `ExecutionWorld` capability，而不是把同步逻辑塞进 CommandRunner。
