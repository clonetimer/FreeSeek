/**
 * Tool Registry：模型 schema、Runtime 策略与执行器的单一运行时注册表。
 *
 * 声明数据仍可来自内置 defs、MCP 或 Connector，但一旦进入 Agent，必须先注册成
 * ToolRegistration；ToolRuntime 只认 Registry，不再自行按名字寻找 body/spec。
 * 这样新增工具若只加 schema、忘记执行策略/执行器，会在注册阶段直接失败。
 */
import type { ToolDefinition } from "./provider";
import type { ToolContext } from "./tools";
import { executeToolBody } from "./tools";
import { getBuiltinToolRuntimeSpec, getToolRuntimeSpec, type ToolRuntimeSpec } from "./tool-runtime-spec";

export type ToolSource = "builtin" | "mcp" | "connector" | "agent" | "unknown";

export type RegisteredToolExecutor = (
  args: any,
  ctx: ToolContext
) => Promise<string>;

export interface ToolRegistration {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly runtime: ToolRuntimeSpec;
  readonly source: ToolSource;
  readonly execute: RegisteredToolExecutor;
}

export type ToolExecutorOverrides = Record<string, RegisteredToolExecutor | undefined>;

function inferSource(name: string): ToolSource {
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return "mcp";
  if (name.startsWith("conn__")) return "connector";
  if (["spawn_agent", "spawn_agents", "send_message"].includes(name)) return "agent";
  return "builtin";
}


function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function snapshotDefinition(definition: ToolDefinition): ToolDefinition {
  return deepFreeze(JSON.parse(JSON.stringify(definition)) as ToolDefinition);
}

function assertDefinition(definition: ToolDefinition): string {
  const name = definition?.function?.name?.trim();
  if (!name) throw new Error("ToolRegistry: 工具定义缺少 function.name");
  if (definition.type !== "function") {
    throw new Error(`ToolRegistry: ${name} 不是 function tool`);
  }
  return name;
}

/**
 * 每个 Agent run 拥有一个不可变视角的 Registry。动态 MCP/Connector 的定义在 run 开始时
 * 快照进来，避免执行到一半注册表悄然改变导致 provider schema 与实际可执行能力漂移。
 */
export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistration>();

  register(registration: ToolRegistration): void {
    const name = assertDefinition(registration.definition);
    if (name !== registration.name || registration.runtime.name !== name) {
      throw new Error(`ToolRegistry: 注册名/schema/runtime 名称不一致：${registration.name}/${name}/${registration.runtime.name}`);
    }
    if (this.entries.has(name)) {
      throw new Error(`ToolRegistry: 工具名重复注册：${name}`);
    }
    const frozenDefinition = snapshotDefinition(registration.definition);
    const frozenRuntime = deepFreeze({ ...registration.runtime });
    this.entries.set(name, Object.freeze({
      ...registration,
      definition: frozenDefinition,
      runtime: frozenRuntime,
    }));
  }

  get(name: string): ToolRegistration | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.entries.values()].map((r) => r.definition);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  runtimeSpec(name: string): ToolRuntimeSpec | undefined {
    return this.entries.get(name)?.runtime;
  }

  isConcurrencySafe(name: string): boolean {
    return this.entries.get(name)?.runtime.concurrency === "parallel";
  }

  async executeBody(name: string, args: any, ctx: ToolContext): Promise<string> {
    const registration = this.entries.get(name);
    if (!registration) {
      throw new Error(`ToolRegistry: 未注册工具「${name}」不能执行`);
    }
    return registration.execute(args, ctx);
  }

  /**
   * 把 Provider ToolDefinition 快照升级成完整注册项。默认 body 统一落到内置 dispatcher；
   * Agent-native 等特殊编排工具必须通过 overrides 显式覆盖执行器。
   */
  static fromDefinitions(
    definitions: readonly ToolDefinition[],
    overrides: ToolExecutorOverrides = {}
  ): ToolRegistry {
    const registry = new ToolRegistry();
    for (const definition of definitions) {
      const name = assertDefinition(definition);
      const override = overrides[name];
      const source = inferSource(name);
      const builtinRuntime = getBuiltinToolRuntimeSpec(name);
      if ((source === "builtin" || source === "agent") && !builtinRuntime) {
        throw new Error(`ToolRegistry: 内置工具「${name}」缺少显式 Runtime spec`);
      }
      if (source === "agent" && !override) {
        throw new Error(`ToolRegistry: Agent-native 工具「${name}」缺少显式 executor`);
      }
      registry.register({
        name,
        definition,
        runtime: builtinRuntime ?? getToolRuntimeSpec(name),
        source,
        execute: override ?? ((args, ctx) => executeToolBody(name, args, ctx)),
      });
    }
    return registry;
  }
}
