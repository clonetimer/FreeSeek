// check:max-lines 680 (略超 600，纳入后续拆分)
/**
 * Layer 4：外部 MCP（Model Context Protocol）接入。
 *
 * 设计要点（对齐 Claude Code 的 MCP 扩展点 + 文档 §10 三层护栏）：
 *  - 通过 freesek.mcpServers 配置连接外部 MCP server（stdio 或 http/streamable）。
 *  - 启动期 list_tools 发现工具，以动态 ToolDefinition 注入 L4 工具注册表，
 *    工具名统一加前缀 `mcp__<server>__<tool>`（避免与内置工具冲突，亦便于路由）。
 *  - 动态 `mcp__` 工具通过统一 ToolRegistry/ToolRuntime 路由到外部 server。
 *  - 连接/调用 best-effort：单个 server 失败不影响内置工具或其它 server。
 */

import { ToolDefinition } from "./provider";
import { McpConnection } from "./mcp-sdk";
export { buildMcpEnv } from "./mcp-sdk";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /** stdio：要执行的命令 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http：端点 URL（Streamable HTTP / legacy SSE） */
  url?: string;
}

/** MCP 日志出口。ACP stdio host 会把诊断信息送到 stderr，避免污染协议 stdout。 */
export interface McpLogSink {
  info?(message: string): void;
  warn?(message: string): void;
}

/** MCP 管理器：维护一组 server 连接与聚合工具表。宿主可按 session 创建独立实例。 */
export class McpManager {
  private conns = new Map<string, McpConnection>();
  private connecting: Promise<void> | null = null;
  private connected = false;

  constructor(private readonly log: McpLogSink = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
  }) {}

  /** 按配置连接所有 server（best-effort，单次去重）。 */
  async connectAll(servers: McpServerConfig[]): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      for (const s of servers || []) {
        const conn = new McpConnection(s.name, s, this.log);
        try {
          await conn.connect();
          this.conns.set(s.name, conn);
          this.log.info?.(`[FreeSeek MCP] 已连接 server: ${s.name}（${conn.tools.length} 个工具）`);
        } catch (e: any) {
          conn.dispose();
          this.log.warn?.(`[FreeSeek MCP] server "${s.name}" 连接失败：${e?.message ?? e}`);
        }
      }
      this.connected = true;
    })();
    return this.connecting;
  }

  /** vscode 激活时调用：读取配置并连接。 */
  async connectFromConfig(getConfig: () => McpServerConfig[]): Promise<void> {
    try {
      await this.connectAll(getConfig());
    } catch {
      /* 静默 */
    }
  }

  /** 聚合所有已连接 server 的工具为 ToolDefinition[]（带 mcp__ 前缀）。 */
  getToolDefinitions(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const [server, conn] of this.conns) {
      if (!conn.ready) continue;
      for (const t of conn.tools) {
        out.push({
          type: "function",
          function: {
            name: `mcp__${server}__${t.name}`,
            description: `[MCP:${server}] ${t.description}`,
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
        });
      }
    }
    // 通用：MCP resources / prompts（有任一连接具备时暴露）
    if (this.hasResources() || this.hasPrompts()) {
      out.push({
        type: "function",
        function: {
          name: "mcp_read_resource",
          description: "读取一个 MCP resource 的内容（如配置、文档、schema 等数据资源）。",
          parameters: {
            type: "object",
            properties: {
              uri: { type: "string", description: "resource 的 uri" },
            },
            required: ["uri"],
          },
        },
      });
      out.push({
        type: "function",
        function: {
          name: "mcp_get_prompt",
          description: "获取并渲染一个 MCP prompt 模板（可复用提示词）。",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "prompt 名" },
              arguments: { type: "object", description: "可选：prompt 参数" },
            },
            required: ["name"],
          },
        },
      });
      // 外部知识库接线（FreeSeek 只做工具接线，不内置知识库）：若任一连接的 server
      // 暴露了 search/query/retrieve/kb 等检索类工具，则暴露统一知识库检索工具。
      if (this.knowledgeToolCount() > 0) {
        out.push({
          type: "function",
          function: {
            name: "mcp_list_kb",
            description:
              "列出已连接的 MCP 知识库来源（含各 server 的检索类工具名）。调用 mcp_kb_search 前先了解有哪些可检索源。",
            parameters: { type: "object", properties: {} },
          },
        });
        out.push({
          type: "function",
          function: {
            name: "mcp_kb_search",
            description:
              "向 MCP 知识库（外部，FreeSeek 仅做工具接线）发起检索：把 query 路由到匹配的 server 的检索类工具（search/query/retrieve/kb…）。用于检索文档、API、内部知识。",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "检索问题/关键词" },
                server: { type: "string", description: "可选：指定 server 名（mcp_list_kb 给出的名字）；不填则自动选第一个含检索工具的 server" },
                max: { type: "number", description: "可选：返回结果条数上限，默认 5" },
              },
              required: ["query"],
            },
          },
        });
      }
    }
    return out;
  }

  /** 统计所有已连接 server 的"知识检索类"工具总数。 */
  knowledgeToolCount(): number {
    let n = 0;
    for (const conn of this.conns.values()) {
      if (!conn.ready) continue;
      for (const t of conn.tools) if (McpConnection.isKnowledgeTool(t.name)) n++;
    }
    return n;
  }

  /** 列出知识库来源摘要（server 名 + 其检索类工具 + resource）。 */
  knowledgeSummary(): string {
    const lines: string[] = [];
    for (const [server, conn] of this.conns) {
      if (!conn.ready) continue;
      const kbTools = conn.tools.filter((t) => McpConnection.isKnowledgeTool(t.name)).map((t) => t.name);
      const parts: string[] = [];
      if (kbTools.length) parts.push(`检索工具: ${kbTools.join(", ")}`);
      if (conn.resources.length) parts.push(`资源: ${conn.resources.length} 个`);
      if (parts.length) lines.push(`- ${server}: ${parts.join("；")}`);
    }
    return lines.length ? `MCP 知识库来源：\n${lines.join("\n")}` : "";
  }

  /** 是否有任一连接的 resources。 */
  hasResources(): boolean {
    return [...this.conns.values()].some((c) => c.ready && c.resources.length > 0);
  }
  /** 是否有任一连接的 prompts。 */
  hasPrompts(): boolean {
    return [...this.conns.values()].some((c) => c.ready && c.prompts.length > 0);
  }

  /** resources 摘要（供系统提示词）。 */
  resourceSummary(): string {
    const lines: string[] = [];
    for (const [server, conn] of this.conns) {
      if (!conn.ready || !conn.resources.length) continue;
      lines.push(`- ${server}: ${conn.resources.map((r) => `${r.name} (${r.uri})`).join(", ")}`);
    }
    return lines.length ? `MCP resources：\n${lines.join("\n")}` : "";
  }

  /** prompts 摘要（供系统提示词）。 */
  promptSummary(): string {
    const lines: string[] = [];
    for (const [server, conn] of this.conns) {
      if (!conn.ready || !conn.prompts.length) continue;
      lines.push(`- ${server}: ${conn.prompts.map((p) => p.name).join(", ")}`);
    }
    return lines.length ? `MCP prompts：\n${lines.join("\n")}` : "";
  }
  /** 读取 resource（路由到第一个包含该 uri 的连接）。 */
  async callResource(uri: string, signal?: AbortSignal): Promise<string> {
    for (const conn of this.conns.values()) {
      if (conn.ready && conn.resources.some((r) => r.uri === uri)) {
        return conn.readResource(uri, signal);
      }
    }
    return `未找到 uri 为 "${uri}" 的 MCP resource。可用资源见系统提示词。`;
  }
  /** 获取 prompt（路由到第一个包含该名字的连接）。 */
  async callPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
    for (const conn of this.conns.values()) {
      if (conn.ready && conn.prompts.some((p) => p.name === name)) {
        return conn.getPrompt(name, args, signal);
      }
    }
    return `未找到名为 "${name}" 的 MCP prompt。可用 prompts 见系统提示词。`;
  }

  /**
   * 知识库检索（FreeSeek 只做工具接线，不内置知识库）：把 query 路由到匹配 server 的检索类工具。
   * server 指定则限定该 server；否则选第一个含检索工具的连接。best-effort，失败返回友好文本。
   */
  async searchKnowledge(
    query: string,
    server?: string,
    max = 5,
    signal?: AbortSignal
  ): Promise<string> {
    const candidates: Array<{ server: string; conn: McpConnection; tool: string }> = [];
    for (const [sname, conn] of this.conns) {
      if (!conn.ready) continue;
      if (server && sname !== server) continue;
      for (const t of conn.tools) {
        if (McpConnection.isKnowledgeTool(t.name)) candidates.push({ server: sname, conn, tool: t.name });
      }
    }
    if (!candidates.length) {
      return server
        ? `⚠️ MCP server「${server}」未连接或未暴露检索类工具（search/query/retrieve/kb…）。`
        : `⚠️ 当前没有已连接的 MCP server 暴露知识库检索工具。请先在 freesek.mcpServers 配置并连接知识库 server。`;
    }
    const target = candidates[0];
    try {
      const res = await target.conn.callTool(`mcp__${target.server}__${target.tool}`, {
        query,
        limit: max,
        max: max,
        top_k: max,
        q: query,
      }, signal);
      return `MCP 知识库检索（${target.server} / ${target.tool}）「${query}」：\n\n${res}`;
    } catch (e: any) {
      return `⚠️ MCP 知识库检索失败：${e?.message ?? String(e)}`;
    }
  }
  /** 返回已连接 server 的摘要（供前端展示）。 */
  statusSummary(): string {
    const lines = [...this.conns.values()].map(
      (c) => `- ${c.name}: ${c.ready ? `${c.tools.length} 个工具` : "未就绪"}`
    );
    return lines.length ? `已连接 MCP server：\n${lines.join("\n")}` : "未配置/未连接任何 MCP server。";
  }

  /**
   * 返回所有 server 的管理信息（含配置、连接状态、工具清单），供 MCP 管理面板展示。
   * servers 为当前配置（用于展示未连接 server 的配置信息）。
   */
  listServers(servers: McpServerConfig[]): Array<{
    name: string;
    transport: string;
    target: string;
    status: "connected" | "disconnected" | "error";
    tools: string[];
  }> {
    const out: Array<{ name: string; transport: string; target: string; status: "connected" | "disconnected" | "error"; tools: string[] }> = [];
    for (const s of servers || []) {
      const conn = this.conns.get(s.name);
      out.push({
        name: s.name,
        transport: s.transport,
        target: s.transport === "stdio" ? (s.command || "") + (s.args?.length ? " " + s.args.join(" ") : "") : s.url || "",
        status: conn?.ready ? "connected" : conn ? "error" : "disconnected",
        tools: conn?.ready ? conn.tools.map((t) => t.name) : [],
      });
    }
    return out;
  }
  /** 重新加载 MCP 连接：断开所有后按新配置重连（用于管理面板「重连」）。 */
  async reconnect(servers: McpServerConfig[]): Promise<void> {
    this.dispose();
    await this.connectAll(servers || []);
  }
  /** 断开并清空所有连接（释放子进程）。 */
  dispose(): void {
    for (const conn of this.conns.values()) conn.dispose();
    this.conns.clear();
    this.connected = false;
    this.connecting = null;
  }
  /** 调用 MCP 工具（best-effort，失败返回友好文本）。 */
  async callTool(name: string, args: any, signal?: AbortSignal): Promise<string> {
    const server = name.slice("mcp__".length).split("__")[0];
    const conn = this.conns.get(server);
    if (!conn || !conn.ready) return `⚠️ MCP server "${server}" 未连接，无法调用 ${name}。`;
    try {
      return await conn.callTool(name, args, signal);
    } catch (e: any) {
      return `⚠️ MCP 工具 ${name} 调用失败：${e?.message ?? String(e)}`;
    }
  }
}

/** 全局单例：extension.ts 激活时 connectFromConfig，agent.ts 路由调用。 */
export const mcpManager = new McpManager();
