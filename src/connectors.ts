import { ToolDefinition } from "./provider";
import { ToolContext } from "./tools";

/**
 * 连接器（Connector）插件机制——对齐 Claude Code 的连接器思路，但做成第三方可扩展的规范。
 *
 * 一个连接器 = 一组可插拔的工具（ToolDefinition）+ 对应执行器。任何外部服务（GitHub、
 * Slack、HTTP、数据库、内部 API 等）都可以实现一个 Connector 接入 FreeSeek，让 Agent
 * 在对话中直接调用其工具。
 *
 * 使用方式（示例见内置 connectors/ 目录）：
 *   import { registerConnector } from "./connectors";
 *   registerConnector({
 *     id: "github",
 *     name: "GitHub",
 *     description: "GitHub 仓库与 PR 操作",
 *     tools: [...],
 *     async execute(name, args, ctx) { ... },
 *   });
 */
export interface Connector {
  /** 唯一 id（工具命名前缀，如 "conn__github__"） */
  id: string;
  /** 展示名 */
  name: string;
  /** 一句话说明（进系统提示词「可用连接器」） */
  description: string;
  /** 该连接器提供的工具定义（工具名最终为 conn__<id>__<toolName>） */
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** 执行入口：name 为连接器内工具名（不含前缀），args 为入参，ctx 为共享工具上下文 */
  execute: (name: string, args: any, ctx: ToolContext) => Promise<string>;
  /** 可选的清理钩子（扩展停用时释放资源） */
  dispose?: () => void;
}

export type ConnectorRegistry = Map<string, Connector>;

/** 全局连接器注册表（进程级单例）。 */
const registry: ConnectorRegistry = new Map();

/** 注册一个连接器。重复 id 覆盖。 */
export function registerConnector(c: Connector): void {
  registry.set(c.id, c);
}

/** 注销一个连接器（返回是否成功）。 */
export function unregisterConnector(id: string): boolean {
  const c = registry.get(id);
  if (!c) return false;
  c.dispose?.();
  return registry.delete(id);
}

/** 获取全部已注册连接器。 */
export function listConnectors(): Connector[] {
  return [...registry.values()];
}

/** 获取某个连接器的全部工具定义（加 conn__<id>__ 前缀）。 */
export function connectorToolDefinitions(): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const c of registry.values()) {
    for (const t of c.tools) {
      out.push({
        type: "function",
        function: {
          name: `conn__${c.id}__${t.name}`,
          description: t.description,
          parameters: t.parameters as any,
        },
      });
    }
  }
  return out;
}

/** 从完整工具名解析连接器 id 与内部工具名；非连接器工具返回 null。 */
function resolveConnector(name: string): { id: string; toolName: string } | null {
  if (!name.startsWith("conn__")) return null;
  const rest = name.slice("conn__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return null;
  return { id: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

/**
 * 尝试路由到连接器执行。若该工具名属于某个已注册连接器，调用其 execute。
 * 返回 { handled: true, result } 表示已由连接器处理；否则 handled: false。
 */
export async function dispatchConnectorTool(
  name: string,
  args: any,
  ctx: ToolContext
): Promise<{ handled: boolean; result: string }> {
  const r = resolveConnector(name);
  if (!r) return { handled: false, result: "" };
  const c = registry.get(r.id);
  if (!c) {
    return { handled: true, result: `连接器「${r.id}」未注册或已被移除。` };
  }
  try {
    const result = await c.execute(r.toolName, args, ctx);
    return { handled: true, result };
  } catch (e: any) {
    return { handled: true, result: `连接器 ${c.id} 执行 ${r.toolName} 出错：${e?.message ?? String(e)}` };
  }
}

/** 构建「可用连接器」清单文本（进系统提示词）。 */
export function connectorSummary(): string {
  const cs = listConnectors();
  if (!cs.length) return "";
  return cs
    .map((c) => `- **${c.id}**: ${c.description}（${c.tools.length} 个工具，工具名前缀 conn__${c.id}__）`)
    .join("\n");
}

/** 销毁所有连接器（扩展停用时调用）。 */
export function disposeConnectors(): void {
  for (const c of registry.values()) c.dispose?.();
  registry.clear();
}
