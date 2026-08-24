import * as fs from "fs";
import * as path from "path";
import { McpManager, type McpLogSink, type McpServerConfig } from "../../mcp";
import { getAllToolDefinitions } from "../../tools";
import { SkillManager, defaultUserSkillsDir } from "../../skills";
import type { ToolDefinition } from "../../provider";

/** Optional host-neutral services mounted into a CLI/Headless run. */
export interface CliRuntimeServices {
  readonly toolDefinitions: ToolDefinition[];
  readonly skillManager: SkillManager;
  readonly mcpEnabled: boolean;
  readonly mcpManager: McpManager;
  dispose(): void;
}

/** Input for assembling CLI services without importing VS Code configuration APIs. */
export interface CliRuntimeServiceOptions {
  workspace: string;
  mcpConfig?: string;
  mcpServers?: McpServerConfig[];
  mcpLog?: McpLogSink;
  skillDirs?: string[];
  /** Additional authorized workspace roots whose project-local skills should be discoverable. */
  additionalWorkspaces?: string[];
}

function parseMcpConfig(file: string): McpServerConfig[] {
  const absolute = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).mcpServers)
      ? (raw as any).mcpServers
      : raw && typeof raw === "object" && Array.isArray((raw as any).servers)
        ? (raw as any).servers
        : null;
  if (!rows) throw new Error(`MCP config must be an array or { mcpServers: [...] }: ${absolute}`);

  return rows.map((value: any, index: number): McpServerConfig => {
    if (!value || typeof value !== "object") throw new Error(`MCP config row ${index + 1} must be an object`);
    const name = String(value.name ?? "").trim();
    const transport = value.transport;
    if (!name) throw new Error(`MCP config row ${index + 1} is missing name`);
    if (transport !== "stdio" && transport !== "http") {
      throw new Error(`MCP server ${name}: transport must be stdio|http`);
    }
    if (transport === "stdio" && !String(value.command ?? "").trim()) {
      throw new Error(`MCP server ${name}: stdio requires command`);
    }
    if (transport === "http" && !/^https?:\/\//i.test(String(value.url ?? ""))) {
      throw new Error(`MCP server ${name}: http requires an http(s) url`);
    }
    return {
      name,
      transport,
      ...(value.command ? { command: String(value.command) } : {}),
      ...(Array.isArray(value.args) ? { args: value.args.map(String) } : {}),
      ...(value.env && typeof value.env === "object"
        ? { env: Object.fromEntries(Object.entries(value.env).map(([k, v]) => [k, String(v)])) }
        : {}),
      ...(value.url ? { url: String(value.url) } : {}),
    };
  });
}

/** Assemble dynamic MCP schemas plus the same project/user skill roots used by the VS Code host. */
export async function createCliRuntimeServices(options: CliRuntimeServiceOptions): Promise<CliRuntimeServices> {
  if (options.mcpConfig && options.mcpServers) {
    throw new Error("mcpConfig and mcpServers cannot be used together");
  }
  const manager = new McpManager(options.mcpLog);
  const servers = options.mcpServers ?? (options.mcpConfig ? parseMcpConfig(options.mcpConfig) : []);
  if (servers.length) await manager.connectAll(servers);
  const mcpEnabled = servers.length > 0;

  const toolDefinitions = getAllToolDefinitions(manager);
  const workspaceRoots = [options.workspace, ...(options.additionalWorkspaces ?? [])].map((root) => path.resolve(root));
  const dirs = [
    ...workspaceRoots.flatMap((root) => [
      path.join(root, ".agent", "skills"),
      path.join(root, "skills"),
    ]),
    defaultUserSkillsDir(),
    ...(options.skillDirs ?? []).map((dir) => path.resolve(dir)),
  ];
  const skillManager = new SkillManager([...new Set(dirs)], {
    availableTools: toolDefinitions.map((tool) => tool.function.name),
  });

  return {
    toolDefinitions,
    skillManager,
    mcpEnabled,
    mcpManager: manager,
    dispose: () => manager.dispose(),
  };
}
