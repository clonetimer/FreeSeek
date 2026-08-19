/**
 * Tool Runtime 元数据：模型可见 schema 与宿主执行策略彻底分离。
 *
 * 这里的字段永远不会发送给模型；只供 ToolRuntime 做并发、模式守卫、
 * MCP 审批、超时和能力审计。新增内置工具必须在此登记，否则测试会失败。
 */
export type ToolEffect =
  | "read"
  | "state"
  | "write"
  | "execute"
  | "external"
  | "destructive"
  | "persistent"
  | "interactive";

export type ToolConcurrency = "parallel" | "exclusive";

/** 通用人类审批策略；MCP/Slash Command 等领域专用审批仍可叠加。 */
export type ToolApprovalPolicy = "auto" | "always" | "confirm-write" | "user-scope";

export interface ToolRuntimeSpec {
  name: string;
  effect: ToolEffect;
  concurrency: ToolConcurrency;
  /** plan/ask 与 sandbox=readonly 下是否仍允许。显式字段避免靠工具名散落判断。 */
  readOnlyAllowed: boolean;
  /** 是否需要通用用户审批。扩展层只负责渲染弹窗，不再维护工具名风险表。 */
  approval: ToolApprovalPolicy;
  /** 需要 freesek.allowShell=true。 */
  requiresShell?: boolean;
  /** 需要 freesek.allowNetwork=true。 */
  requiresNetwork?: boolean;
  /** 外部 MCP 能力：除通用权限规则外，还走 MCP 独立审批并支持会话级 allow。 */
  mcpApproval?: boolean;
  /** Runtime 外层硬超时；工具内部可有更短的参数化超时。 */
  timeoutMs?: number;
}

const p = (name: string): ToolRuntimeSpec => ({
  name, effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto",
});
const x = (
  name: string,
  effect: ToolEffect,
  readOnlyAllowed = false,
  approval: ToolApprovalPolicy = "auto"
): ToolRuntimeSpec => ({ name, effect, concurrency: "exclusive", readOnlyAllowed, approval });

/** 内置工具宿主元数据。不要把这些字段塞回 provider ToolDefinition。 */
export const BUILTIN_TOOL_RUNTIME_SPECS: readonly ToolRuntimeSpec[] = [
  p("read_file"), p("list_directory"), p("search_files"), p("grep"), p("glob"),
  p("todo_read"), p("load_skill"), p("list_worktrees"), p("list_checkpoints"),
  p("web_search"), p("web_fetch"), p("lsp"), p("goal_view"), p("job_list"), p("job_output"),

  x("ask_user", "interactive", true),
  x("todo_write", "state", true), x("goal", "state", true), x("job_kill", "state", true),
  x("remember", "persistent", true, "user-scope"),
  x("promote_skill", "persistent", true, "always"),
  x("spawn_agent", "state", true), x("spawn_agents", "state", true), x("send_message", "state", true),

  x("write_file", "write", false, "confirm-write"),
  x("edit_file", "write", false, "confirm-write"),
  x("delete_file", "destructive", false, "always"),
  x("create_worktree", "write"), x("remove_worktree", "destructive", false, "always"),
  x("checkpoint", "write"), x("rewind", "destructive", false, "always"),
  // slash_command 在 body 内使用 confirmCommand 展示命令说明，避免重复弹两次通用 approval。
  x("slash_command", "execute"),
  { ...x("run_command", "execute", false, "always"), requiresShell: true },
  { ...x("verify", "execute", false, "always"), requiresShell: true },
  { ...x("run_python", "execute", false, "always"), requiresShell: true },
  { ...x("run_code", "execute", false, "always"), requiresShell: true, timeoutMs: 300_000 },
  { ...x("browser", "external", false, "always"), requiresNetwork: true },
];

const BUILTIN_BY_NAME = new Map(BUILTIN_TOOL_RUNTIME_SPECS.map((s) => [s.name, s] as const));

/** 返回显式登记的内置 Runtime spec；用于 Registry 在启动时阻止 schema/spec 漂移。 */
export function getBuiltinToolRuntimeSpec(name: string): ToolRuntimeSpec | undefined {
  return BUILTIN_BY_NAME.get(name);
}

/**
 * 动态工具也必须有保守策略：MCP / connector 默认串行、外部、需审批。
 * 未知工具 fail-closed 为 exclusive + readOnly 禁止，避免“新增工具忘记登记”自动越权。
 */
export function getToolRuntimeSpec(name: string): ToolRuntimeSpec {
  const builtin = BUILTIN_BY_NAME.get(name);
  if (builtin) {
    if (name === "web_search" || name === "web_fetch") return { ...builtin, requiresNetwork: true };
    return builtin;
  }
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) {
    return {
      name,
      effect: "external",
      concurrency: "exclusive",
      readOnlyAllowed: name.startsWith("mcp_") && !name.startsWith("mcp__"),
      approval: "auto",
      mcpApproval: true,
      requiresNetwork: false,
    };
  }
  if (name.startsWith("conn__")) {
    return {
      name, effect: "external", concurrency: "exclusive", readOnlyAllowed: true,
      approval: "always", requiresNetwork: true,
    };
  }
  // 未知工具 fail-closed：只读拒绝、串行、并要求用户审批。
  return {
    name, effect: "external", concurrency: "exclusive", readOnlyAllowed: false, approval: "always",
  };
}

export function isRuntimeConcurrencySafe(name: string): boolean {
  return getToolRuntimeSpec(name).concurrency === "parallel";
}
