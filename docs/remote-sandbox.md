# Remote Sandbox Seam

`src/remote-sandbox.ts` 是 CommandRunner seam 的远端 provider。当前阶段只定义**执行协议与明确的
workspace mapping**，不偷偷实现文件同步。

这是刻意的：本地 `cwd=/Users/a/repo` 并不意味着远端存在相同目录。调用方必须把本地 workspace
预先 provision 到远端，再提供：

```ts
const runner = createRemoteCommandRunner({
  transport: createHttpRemoteSandboxTransport({
    endpoint: "https://sandbox.example/v1/execute",
    token: process.env.SANDBOX_TOKEN,
  }),
  mapCwd: createStaticRemoteWorkspaceMapper(
    localWorkspace,
    remoteWorkspaceId,
    "/workspace"
  ),
});
setCommandRunner(runner);
```

HTTP endpoint 接收 `RemoteSandboxRequest v1`：workspace id、remote cwd、command/argv、timeout、
stdin、network mode 与 restricted intent；返回 exitCode/stdout/stderr/timedOut/cancelled。

安全约束：

- `cwd` 必须位于映射的 local root；存在路径会 realpath 后再做 containment；
- remote token 对非 loopback HTTP endpoint 禁止发送，必须 HTTPS；
- AbortSignal 会传播到 HTTP 请求；
- provider 不接管 ToolRuntime 的 approval/policy；远端执行仍然发生在统一 Runtime 之后；
- 当前没有 workspace upload/sync/download。下一阶段应把 filesystem/subprocess 收成同一个
  `ExecutionWorld` capability，而不是把同步逻辑塞进 CommandRunner。
