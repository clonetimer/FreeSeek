# Tool Registry & Runtime Pipeline

FreeSeek 的模型工具能力由两个互补层负责：

- `src/tool-registry.ts`：把 **Provider schema + Runtime policy + executor** 冻结成一次 Agent run 的能力快照；
- `src/tool-runtime.ts`：只执行 Registry 中已注册的能力，并统一处理权限、审批、hook、取消、超时和结果收尾。

`agent.ts` 只负责模型循环、工具调度与结果回灌。它不能直接调用 raw tool body，也不能绕过 Registry 构造另一份可执行能力集合。

## 单一运行时注册源

每次 `runAgent()` 开始时：

```text
ToolDefinition[]
      +
RuntimeSpec
      +
explicit executor overrides (Agent-native)
      |
      v
  ToolRegistry  -- frozen per run --> Provider tool schemas
      |
      +-----------------------------> concurrency metadata
      |
      `-----------------------------> ToolRuntime execution
```

因此同一次 run 内：

1. Provider 看到的 tool schema 来自 `toolRegistry.definitions()`；
2. 调度器的并发判断来自同一个 Registry；
3. Runtime 的 capability / approval / timeout 元数据来自同一个 Registry；
4. 实际 body executor 也只能由同一个 Registry 分派。

一个名字没有进入 Registry，就算模型幻觉出了合法 JSON，也不能执行。

## 执行顺序

```text
model tool call
  -> ToolRegistry registration lookup
  -> capability / mode admission
  -> deny / allow rules
  -> generic approval policy
  -> MCP dedicated approval (when applicable)
  -> pre-tool hooks / dangerous-text guard
  -> cancellation + timeout wrapper
  -> ToolRegistry executor dispatch
  -> post-tool hooks
  -> offload + result truncation
  -> durable tool/result event
  -> agent protocol replay
```

核心不变量：

1. **所有模型工具都进 Registry + Runtime**：普通内置工具、动态 MCP、Connector、`spawn_agent` / `spawn_agents` / `send_message` 都不能绕开。
2. **模型 schema 与宿主策略分离**：`src/tools/defs.ts` 只描述模型可见名称、说明和 JSON 参数；`effect`、`approval`、`concurrency`、`timeoutMs` 等只属于 Runtime spec。
3. **Provider schema 与 executor 同源**：Agent 不再把原始 `effectiveTools` 直接发送给 Provider；只发送 Registry 冻结快照。
4. **未知/未注册工具 fail-closed**：Runtime 返回 capability denial，不做 raw dispatcher 猜测。
5. **内置 schema 漂移在注册阶段失败**：普通内置工具缺显式 Runtime spec 会抛错；Agent-native 工具缺显式 executor 也会抛错。
6. **审批不可用即拒绝**：声明需要通用审批的工具若没有 approval handler，不执行；MCP 独立 approval 缺失时同样拒绝。
7. **allowRules 不越过独立信任边界**：`denyRules` 始终优先；MCP 专用审批不会被普通 allow rule 静默取消。
8. **取消贯穿 body**：Runtime 向 Registry executor 传递子 `AbortSignal`；声明 `timeoutMs` 时通过同一守卫协作式取消。
9. **审计属于 Runtime**：`tool/call`、`approval/*`、`tool/result`、`tool_timeout` 在 Runtime 内写入 Session Event Log，未来 CLI/Headless 复用 Runtime 时不会丢审计。
10. **raw body 不是公共入口**：`executeToolBody` 只允许被 ToolRegistry 持有；Registry 的 `executeBody()` 只允许 ToolRuntime 调用。

## 新增工具

### 普通内置工具

至少同时完成：

- `src/tools/defs.ts`：增加模型可见 `ToolDefinition`；
- `src/tool-runtime-spec.ts`：在 `BUILTIN_TOOL_RUNTIME_SPECS` 增加同名策略；
- `src/tools.ts` / 对应工具模块：提供 raw body dispatcher 能执行的实现。

Registry 会在 run 启动时验证 schema/spec 映射；漏登记会直接失败。

### Agent-native 工具

像 `spawn_agent` 这类需要 Agent 活对象的编排能力，除 schema/spec 外还必须通过 `ToolExecutorOverrides` 显式注入 executor。不能回落到通用 raw dispatcher。

### 动态工具

- `mcp__*` / `mcp_*`：外部能力、串行、MCP 独立审批；
- `conn__*`：联网外部能力、串行、通用审批；
- 其它未知前缀：保守 spec，但如果没有进入 Registry 仍不可执行。

## Runtime Spec

示例：

```ts
{
  name: "run_command",
  effect: "execute",
  concurrency: "exclusive",
  readOnlyAllowed: false,
  approval: "always",
  requiresShell: true,
}
```

`approval`：

- `auto`：不要求通用审批；仍可能叠加领域审批；
- `always`：除非显式 allow rule，否则必须有人类 approval handler 放行；
- `confirm-write`：仅 `ToolContext.confirmFileWrites=true` 时要求通用审批；
- `user-scope`：参数 `scope=user` 时审批，用于用户级持久化。

## ToolContext 与 Extension 边界

`ToolContext` 携带本次 run 的有效策略，如 `allowShell`、`allowNetwork`、`confirmFileWrites`、allow/deny rules、sandbox 和 signal。子 Agent 必须从父 Context 派生，不得重新读取 VS Code settings 扩权。

Extension 的 `onPermissionRequest` 只负责展示审批 UI 和回传决定。**哪些工具需要审批，只由 Registry 中的 Runtime spec 决定。**

## 工程门禁

`npm run check` 会硬性检查：

- `executeToolBody` 只能在 `src/tools.ts` 定义并由 `src/tool-registry.ts` 持有；
- `ToolRegistry.executeBody()` 只能在 `src/tool-runtime.ts` 执行；
- source 与 tests 都必须 strict typecheck；
- 新增内置 schema/spec 的完整映射由 Runtime/Registry 测试覆盖。

对应回归位于 `tests/tool-runtime.test.ts`。
