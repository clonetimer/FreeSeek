import * as fs from "fs";
import * as path from "path";
import { McpManager, type McpServerConfig } from "../../mcp";
import { parseFrontmatter } from "../../frontmatter";
import type { ExtensionActivationContext } from "./contracts";

const MAX_SKILLS = 128;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;

export interface ExtensionPackageContributions {
  /** Relative package directories containing immediate child <skill>/SKILL.md assets. */
  skillRoots?: string[];
  /** Generation-owned MCP server configs. Connections are disposed with the generation. */
  mcpServers?: McpServerConfig[];
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveContainedDirectory(packageDir: string, relativeInput: string, label: string): string {
  const relative = String(relativeInput ?? "").trim();
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} 必须是 package 内相对目录`);
  const unresolved = path.resolve(packageDir, relative);
  if (!inside(packageDir, unresolved)) throw new Error(`${label} 路径逃逸 package：${relative}`);
  if (fs.lstatSync(unresolved).isSymbolicLink()) throw new Error(`${label} 不允许 symlink：${relative}`);
  const real = fs.realpathSync(unresolved);
  if (!inside(packageDir, real)) throw new Error(`${label} realpath 逃逸 package：${relative}`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} 不是目录：${relative}`);
  return real;
}

function snapshotSkillRoots(packageDir: string, roots: readonly string[]): Array<{ name: string; markdown: string; source: string }> {
  const out: Array<{ name: string; markdown: string; source: string }> = [];
  let totalBytes = 0;
  for (const relative of roots) {
    const root = resolveContainedDirectory(packageDir, relative, "skillRoot");
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillDir = path.join(root, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      if (fs.lstatSync(skillFile).isSymbolicLink()) throw new Error(`skill asset 不允许 symlink：${skillFile}`);
      const realFile = fs.realpathSync(skillFile);
      if (!inside(packageDir, realFile)) throw new Error(`skill asset 逃逸 package：${skillFile}`);
      const stat = fs.statSync(realFile);
      if (!stat.isFile()) continue;
      totalBytes += stat.size;
      if (out.length >= MAX_SKILLS) throw new Error(`extension skill assets 超过 ${MAX_SKILLS}`);
      if (totalBytes > MAX_SKILL_BYTES) throw new Error(`extension skill assets 超过 ${MAX_SKILL_BYTES} bytes`);
      const markdown = fs.readFileSync(realFile, "utf8");
      const { fm } = parseFrontmatter(markdown);
      const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : entry.name;
      out.push({ name, markdown, source: path.relative(packageDir, realFile).replace(/\\/g, "/") });
    }
  }
  return out;
}

function validateMcpConfig(input: McpServerConfig): McpServerConfig {
  if (!input || typeof input !== "object") throw new Error("mcpServers row 必须是 object");
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("mcpServers row 缺少 name");
  if (input.transport !== "stdio" && input.transport !== "http") throw new Error(`MCP ${name}: transport 必须是 stdio|http`);
  if (input.transport === "stdio" && !String(input.command ?? "").trim()) throw new Error(`MCP ${name}: stdio 缺少 command`);
  if (input.transport === "http" && !/^https?:\/\//i.test(String(input.url ?? ""))) throw new Error(`MCP ${name}: http 缺少 http(s) url`);
  return {
    name,
    transport: input.transport,
    ...(input.command ? { command: String(input.command) } : {}),
    ...(input.args ? { args: input.args.map(String) } : {}),
    ...(input.env ? { env: Object.fromEntries(Object.entries(input.env).map(([key, value]) => [key, String(value)])) } : {}),
    ...(input.url ? { url: String(input.url) } : {}),
  };
}

async function mountMcpServer(ctx: ExtensionActivationContext, configInput: McpServerConfig): Promise<void> {
  const config = validateMcpConfig(configInput);
  if (config.transport === "stdio" && ctx.manifest.capabilities?.shell !== true) {
    throw new Error(`extension ${ctx.manifest.id}: stdio MCP ${config.name} 需要 capabilities.shell=true`);
  }
  if (config.transport === "http" && ctx.manifest.capabilities?.network !== true) {
    throw new Error(`extension ${ctx.manifest.id}: HTTP MCP ${config.name} 需要 capabilities.network=true`);
  }
  const manager = new McpManager({ info: () => undefined, warn: () => undefined });
  try {
    await manager.connectAll([config]);
    const prefix = `mcp__${config.name}__`;
    const tools = manager.getToolDefinitions()
      .filter((definition) => definition.function.name.startsWith(prefix))
      .map((definition) => ({
        name: definition.function.name.slice(prefix.length),
        description: definition.function.description,
        parameters: definition.function.parameters as Record<string, unknown>,
      }));
    if (!tools.length) throw new Error(`MCP ${config.name} 未暴露 tools；H2 adapter 当前仅投影 MCP tools`);
    ctx.registerMcp({
      id: config.name,
      name: config.name,
      tools,
      execute: (name, args, toolCtx) => manager.callTool(`mcp__${config.name}__${name}`, args, toolCtx.signal),
      dispose: () => manager.dispose(),
    });
  } catch (error) {
    manager.dispose();
    throw error;
  }
}

/** Mount declarative package assets into the same candidate effect scope as executable activation. */
export async function mountPackageContributions(
  ctx: ExtensionActivationContext,
  packageDir: string,
  contributions: ExtensionPackageContributions | undefined
): Promise<void> {
  if (!contributions) return;
  if (typeof contributions !== "object" || Array.isArray(contributions)) {
    throw new Error(`extension ${ctx.manifest.id}: contributions 必须是 object`);
  }
  if (contributions.skillRoots !== undefined && !Array.isArray(contributions.skillRoots)) {
    throw new Error(`extension ${ctx.manifest.id}: contributions.skillRoots 必须是 array`);
  }
  if (contributions.mcpServers !== undefined && !Array.isArray(contributions.mcpServers)) {
    throw new Error(`extension ${ctx.manifest.id}: contributions.mcpServers 必须是 array`);
  }
  const skillRoots = (contributions.skillRoots ?? []).map(String);
  for (const asset of snapshotSkillRoots(packageDir, skillRoots)) ctx.registerSkill(asset);
  for (const config of contributions.mcpServers ?? []) await mountMcpServer(ctx, config);
}
