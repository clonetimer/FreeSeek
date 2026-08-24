import * as fs from "fs";
import * as path from "path";
import type { McpServerConfig } from "../../mcp";
import { AcpRpcError } from "./protocol";

/** ACP operating modes mapped to FreeSeek's host-neutral AgentMode surface. */
export type AcpAgentMode = "coder" | "craft" | "plan" | "ask";

/** Modes exposed through ACP stable session mode state. */
export const ACP_AGENT_MODES: readonly AcpAgentMode[] = ["coder", "craft", "plan", "ask"];

interface AcpMcpServer {
  name?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  type?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw AcpRpcError.invalidParams(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw AcpRpcError.invalidParams(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

/** Validate and canonicalize the ACP primary working directory. */
export function normalizeAcpCwd(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw)) {
    throw AcpRpcError.invalidParams("cwd must be an absolute path");
  }
  const resolved = path.resolve(raw);
  try {
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
    return fs.realpathSync(resolved);
  } catch {
    throw AcpRpcError.invalidParams(`cwd does not exist or is not a directory: ${resolved}`);
  }
}

/** Validate, canonicalize and de-duplicate additional ACP workspace roots. */
export function parseAdditionalDirectories(value: unknown, cwd: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw AcpRpcError.invalidParams("additionalDirectories must be an array");
  if (value.length > 32) throw AcpRpcError.invalidParams("additionalDirectories supports at most 32 roots");
  const out: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw)) {
      throw AcpRpcError.invalidParams(`additionalDirectories[${index}] must be an absolute path`);
    }
    const resolved = path.resolve(raw);
    let real: string;
    try {
      if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
      real = fs.realpathSync(resolved);
    } catch {
      throw AcpRpcError.invalidParams(`additionalDirectories[${index}] does not exist or is not a directory: ${resolved}`);
    }
    if (real === cwd || out.includes(real)) continue;
    out.push(real);
  }
  return out;
}

/** Compare authorization-root sets independent of caller ordering. */
export function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

/** Convert ACP stdio MCP descriptors into FreeSeek MCP runtime configs. */
export function parseAcpMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) throw AcpRpcError.invalidParams("mcpServers must be an array");
  const names = new Set<string>();
  return value.map((raw, index) => {
    const row = record(raw, `mcpServers[${index}]`) as AcpMcpServer;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) throw AcpRpcError.invalidParams(`mcpServers[${index}].name is required`);
    if (names.has(name)) throw AcpRpcError.invalidParams(`duplicate MCP server name: ${name}`);
    names.add(name);
    if (row.type === "http" || row.type === "sse" || row.url !== undefined) {
      throw AcpRpcError.invalidParams(`MCP server ${name}: FreeSeek ACP currently supports stdio transport only`);
    }
    const command = typeof row.command === "string" ? row.command.trim() : "";
    if (!command) throw AcpRpcError.invalidParams(`MCP server ${name}: command is required`);
    const args = row.args === undefined
      ? []
      : Array.isArray(row.args)
        ? row.args.map((arg) => String(arg))
        : (() => { throw AcpRpcError.invalidParams(`MCP server ${name}: args must be an array`); })();
    const env: Record<string, string> = {};
    if (row.env !== undefined) {
      if (!Array.isArray(row.env)) throw AcpRpcError.invalidParams(`MCP server ${name}: env must be an array`);
      for (const [envIndex, envRaw] of row.env.entries()) {
        const entry = record(envRaw, `mcpServers[${index}].env[${envIndex}]`);
        const envName = stringField(entry, "name", `mcpServers[${index}].env[${envIndex}]`);
        if (typeof entry.value !== "string") throw AcpRpcError.invalidParams(`MCP server ${name}: env value must be a string`);
        env[envName] = entry.value;
      }
    }
    return { name, transport: "stdio", command, args, env };
  });
}

/** Validate an ACP mode id, retaining a supplied fallback when omitted. */
export function parseAgentMode(value: unknown, fallback: AcpAgentMode = "coder"): AcpAgentMode {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !ACP_AGENT_MODES.includes(value as AcpAgentMode)) {
    throw AcpRpcError.invalidParams(`modeId must be one of: ${ACP_AGENT_MODES.join(", ")}`);
  }
  return value as AcpAgentMode;
}

/** Build the ACP stable SessionModeState returned by session lifecycle methods. */
export function modeState(currentModeId: AcpAgentMode) {
  return {
    currentModeId,
    availableModes: [
      { id: "coder", name: "Coder", description: "Full coding mode with editing and execution subject to runtime permissions." },
      { id: "craft", name: "Craft", description: "Full implementation mode optimized for direct artifact construction." },
      { id: "plan", name: "Plan", description: "Read-only planning and analysis mode." },
      { id: "ask", name: "Ask", description: "Read-only question answering and repository analysis mode." },
    ],
  };
}
