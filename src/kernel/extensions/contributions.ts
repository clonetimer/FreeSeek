import type { ToolDefinition } from "../../provider";
import type { ToolRegistration } from "../../tool-registry";
import { getToolRuntimeSpec, type ToolRuntimeSpec } from "../../tool-runtime-spec";
import type {
  ExtensionActivationContext,
  ExtensionCapabilities,
  ExtensionConnectorContribution,
  ExtensionDisposer,
  ExtensionHookContribution,
  ExtensionMcpContribution,
  ExtensionManifest,
  ExtensionPolicyContribution,
  ExtensionSkillContribution,
  ExtensionToolContribution,
} from "./contracts";

const ID_RE = /^[a-z][a-z0-9._-]{1,31}$/;
const LOCAL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_TOOL_NAME = 64;

export function assertExtensionId(id: string, label = "extension id"): string {
  const value = String(id ?? "").trim();
  if (!ID_RE.test(value)) throw new Error(`${label} 非法：${value || "<empty>"}`);
  return value;
}

function assertLocalName(name: string, label: string): string {
  const value = String(name ?? "").trim();
  if (!LOCAL_RE.test(value)) throw new Error(`${label} 非法：${value || "<empty>"}`);
  return value;
}

function namespace(id: string): string {
  return id.replace(/[.-]/g, "_");
}

export function extensionToolName(extensionId: string, localName: string): string {
  const id = namespace(assertExtensionId(extensionId));
  const local = assertLocalName(localName, "tool name");
  const name = `ext__${id}__${local}`;
  if (name.length > MAX_TOOL_NAME) throw new Error(`extension tool name 超过 ${MAX_TOOL_NAME} 字符：${name}`);
  return name;
}

export function extensionConnectorToolName(extensionId: string, connectorId: string, localName: string): string {
  const id = namespace(assertExtensionId(extensionId));
  const connector = assertLocalName(connectorId, "connector id");
  const local = assertLocalName(localName, "connector tool name");
  const name = `conn__ext_${id}_${connector}__${local}`;
  if (name.length > MAX_TOOL_NAME) throw new Error(`extension connector tool name 超过 ${MAX_TOOL_NAME} 字符：${name}`);
  return name;
}

export function extensionMcpToolName(extensionId: string, serverId: string, localName: string): string {
  const id = namespace(assertExtensionId(extensionId));
  const server = assertLocalName(serverId, "MCP server id");
  const local = assertLocalName(localName, "MCP tool name");
  const name = `mcp__ext_${id}_${server}__${local}`;
  if (name.length > MAX_TOOL_NAME) throw new Error(`extension MCP tool name 超过 ${MAX_TOOL_NAME} 字符：${name}`);
  return name;
}

function requireCapability(manifest: Readonly<ExtensionManifest>, key: keyof ExtensionCapabilities, message: string): void {
  if (!manifest.capabilities?.[key]) throw new Error(`extension ${manifest.id}: ${message} 需要声明 capabilities.${key}=true`);
}

function validateToolRuntime(manifest: Readonly<ExtensionManifest>, runtime: Omit<ToolRuntimeSpec, "name">): void {
  if (!runtime || typeof runtime !== "object") throw new Error(`extension ${manifest.id}: tool runtime metadata 缺失`);
  const effects = ["read", "state", "write", "execute", "external", "destructive", "persistent", "interactive"];
  if (!effects.includes(runtime.effect)) throw new Error(`extension ${manifest.id}: tool effect 非法`);
  if (runtime.concurrency !== "parallel" && runtime.concurrency !== "exclusive") {
    throw new Error(`extension ${manifest.id}: tool concurrency 非法`);
  }
  if (!["auto", "always", "confirm-write", "user-scope"].includes(runtime.approval)) {
    throw new Error(`extension ${manifest.id}: tool approval 非法`);
  }
  if (typeof runtime.readOnlyAllowed !== "boolean") {
    throw new Error(`extension ${manifest.id}: tool readOnlyAllowed 必须是 boolean`);
  }
  for (const key of ["requiresNetwork", "requiresShell", "mcpApproval"] as const) {
    const value = runtime[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`extension ${manifest.id}: tool ${key} 必须是 boolean`);
    }
  }
  if (runtime.timeoutMs !== undefined && (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs <= 0)) {
    throw new Error(`extension ${manifest.id}: tool timeoutMs 必须是正数`);
  }
  if (runtime.requiresNetwork) requireCapability(manifest, "network", "requiresNetwork");
  if (runtime.requiresShell) requireCapability(manifest, "shell", "requiresShell");
  if (["write", "destructive"].includes(runtime.effect) && manifest.capabilities?.filesystem !== "write") {
    throw new Error(`extension ${manifest.id}: ${runtime.effect} tool 需要 capabilities.filesystem=write`);
  }
}

export interface GenerationContributions {
  context: ExtensionActivationContext;
  registrations: ToolRegistration[];
  skills: ExtensionSkillContribution[];
  policies: ExtensionPolicyContribution[];
  hooks: ExtensionHookContribution[];
}

export function createGenerationContributions(
  manifest: Readonly<ExtensionManifest>,
  generation: number,
  addEffect: (disposer: ExtensionDisposer, label?: string) => void
): GenerationContributions {
  const registrations: ToolRegistration[] = [];
  const skills: ExtensionSkillContribution[] = [];
  const policies: ExtensionPolicyContribution[] = [];
  const hooks: ExtensionHookContribution[] = [];
  const names = new Set<string>();
  const skillNames = new Set<string>();
  const policyNames = new Set<string>();
  const hookNames = new Set<string>();

  const registerBatch = (rows: readonly ToolRegistration[]): void => {
    const batchNames = new Set<string>();
    for (const row of rows) {
      if (names.has(row.name) || batchNames.has(row.name)) {
        throw new Error(`extension ${manifest.id}: duplicate contribution ${row.name}`);
      }
      batchNames.add(row.name);
    }
    for (const row of rows) {
      names.add(row.name);
      registrations.push(row);
    }
  };

  const context: ExtensionActivationContext = Object.freeze({
    manifest,
    generation,
    effect: addEffect,
    registerTool: (contribution: ExtensionToolContribution) => {
      requireCapability(manifest, "tools", "registerTool");
      validateToolRuntime(manifest, contribution.runtime);
      const name = extensionToolName(manifest.id, contribution.name);
      const definition: ToolDefinition = { type: "function", function: {
        name, description: String(contribution.description ?? "").trim(), parameters: contribution.parameters ?? {},
      }};
      registerBatch([{ name, definition, runtime: { ...contribution.runtime, name }, source: "extension", execute: contribution.execute }]);
      return name;
    },
    registerConnector: (contribution: ExtensionConnectorContribution) => {
      requireCapability(manifest, "connectors", "registerConnector");
      if (manifest.capabilities?.network !== true) {
        throw new Error(`extension ${manifest.id}: connector contribution 需要 capabilities.network=true`);
      }
      const connectorId = assertLocalName(contribution.id, "connector id");
      const rows = (contribution.tools ?? []).map((tool) => {
        const name = extensionConnectorToolName(manifest.id, connectorId, tool.name);
        const definition: ToolDefinition = { type: "function", function: {
          name, description: tool.description, parameters: tool.parameters ?? {},
        }};
        return {
          name, definition, runtime: getToolRuntimeSpec(name), source: "connector" as const,
          execute: (args: any, ctx: any) => contribution.execute(tool.name, args, ctx),
        };
      });
      registerBatch(rows);
      if (contribution.dispose) addEffect(contribution.dispose, `connector:${connectorId}`);
      return Object.freeze(rows.map((row) => row.name));
    },
    registerSkill: (contribution: ExtensionSkillContribution) => {
      requireCapability(manifest, "skills", "registerSkill");
      const name = String(contribution.name ?? "").trim();
      if (!name || name.length > 96) throw new Error(`extension ${manifest.id}: skill name 非法`);
      if (skillNames.has(name)) throw new Error(`extension ${manifest.id}: duplicate skill contribution ${name}`);
      const markdown = String(contribution.markdown ?? "");
      if (!markdown.trim()) throw new Error(`extension ${manifest.id}: skill ${name} markdown 为空`);
      if (markdown.length > 512 * 1024) throw new Error(`extension ${manifest.id}: skill ${name} 超过 512KiB`);
      skillNames.add(name);
      skills.push(Object.freeze({ name, markdown, ...(contribution.source ? { source: String(contribution.source) } : {}) }));
      return name;
    },
    registerPolicy: (contribution: ExtensionPolicyContribution) => {
      requireCapability(manifest, "hooks", "registerPolicy");
      const name = assertLocalName(contribution.name, "policy name");
      if (policyNames.has(name)) throw new Error(`extension ${manifest.id}: duplicate policy contribution ${name}`);
      if (typeof contribution.evaluate !== "function") throw new Error(`extension ${manifest.id}: policy ${name} evaluate 缺失`);
      policyNames.add(name);
      policies.push(Object.freeze({ name, evaluate: contribution.evaluate }));
      return name;
    },
    registerHook: (contribution: ExtensionHookContribution) => {
      requireCapability(manifest, "hooks", "registerHook");
      const name = assertLocalName(contribution.name, "hook name");
      if (hookNames.has(name)) throw new Error(`extension ${manifest.id}: duplicate hook contribution ${name}`);
      if (contribution.event !== "pre-tool" && contribution.event !== "post-tool") {
        throw new Error(`extension ${manifest.id}: hook ${name} event 非法`);
      }
      if (typeof contribution.run !== "function") throw new Error(`extension ${manifest.id}: hook ${name} run 缺失`);
      hookNames.add(name);
      hooks.push(Object.freeze({ name, event: contribution.event, run: contribution.run }));
      return name;
    },
    registerMcp: (contribution: ExtensionMcpContribution) => {
      requireCapability(manifest, "mcp", "registerMcp");
      const serverId = assertLocalName(contribution.id, "MCP server id");
      const rows = (contribution.tools ?? []).map((tool) => {
        const name = extensionMcpToolName(manifest.id, serverId, tool.name);
        const definition: ToolDefinition = { type: "function", function: {
          name, description: String(tool.description ?? ""), parameters: tool.parameters ?? {},
        }};
        return {
          name, definition, runtime: getToolRuntimeSpec(name), source: "mcp" as const,
          execute: (args: any, ctx: any) => contribution.execute(tool.name, args, ctx),
        };
      });
      registerBatch(rows);
      if (contribution.dispose) addEffect(contribution.dispose, `mcp:${serverId}`);
      return Object.freeze(rows.map((row) => row.name));
    },
  });

  return { context, registrations, skills, policies, hooks };
}
