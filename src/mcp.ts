// check:max-lines 680 (略超 600，纳入后续拆分)
/**
 * Layer 4：外部 MCP（Model Context Protocol）接入。
 *
 * 设计要点（对齐 Claude Code 的 MCP 扩展点 + 文档 §10 三层护栏）：
 *  - 通过 freesek.mcpServers 配置连接外部 MCP server（stdio 或 http/streamable）。
 *  - 启动期 list_tools 发现工具，以动态 ToolDefinition 注入 L4 工具注册表，
 *    工具名统一加前缀 `mcp__<server>__<tool>`（避免与内置工具冲突，亦便于路由）。
 *  - agent.ts 在工具执行循环里识别 `mcp__` 前缀，把调用经 MCP 客户端转发给外部 server。
 *  - 所有连接/调用均为 best-effort：server 未安装/启动失败，仅缺该 server 的工具，
 *    不影响内置工具与其它 server。
 *
 * 这是 v0.6.0 对文档 v2.2「Plugins（MCP 接入）仍待做」的落地。
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { ToolDefinition } from "./provider";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /** stdio：要执行的命令 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http：端点 URL（Streamable HTTP / SSE） */
  url?: string;
}
interface JsonRpcReq {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}
interface JsonRpcResp {
  jsonrpc?: "2.0";
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}
const MCP_REQUEST_TIMEOUT_MS = 120_000;
const MCP_ENV_ALLOWLIST = [
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "WINDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TMP", "TEMP", "TMPDIR",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "APPDATA", "LOCALAPPDATA",
];

/** MCP server 默认只继承运行所需 env；凭据必须通过 cfg.env 显式注入。 */
export function buildMcpEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of MCP_ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(extra || {})) env[k] = v;
  return env;
}
/** 单个 MCP server 连接（stdio / http 抽象）。 */
class McpConnection {
  private seq = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout; signal?: AbortSignal; onAbort?: () => void }>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private httpUrl: string | null = null;
  private initialized = false;
  tools: { name: string; description: string; inputSchema: any }[] = [];
  /** MCP resources（data 资源，支持 read_resource 读取） */
  resources: { uri: string; name: string; description?: string }[] = [];
  /** MCP prompts（可复用提示词模板） */
  prompts: { name: string; description?: string; arguments?: any[] }[] = [];

  /** 判断某工具名是否像"知识库检索"类（search/query/retrieve/kb/find/lookup/semantic/vector...）。 */
  static isKnowledgeTool(name: string): boolean {
    return /search|query|retriev|kb|knowledge|find|lookup|semantic|vector|rag/i.test(name);
  }
  constructor(public readonly name: string, private cfg: McpServerConfig) {}

  async connect(): Promise<void> {
    if (this.cfg.transport === "stdio") {
      await this.connectStdio();
    } else {
      this.httpUrl = this.cfg.url ?? null;
      if (!this.httpUrl) throw new Error("http transport 需要 url");
    }
    await this.initialize();
    this.tools = await this.listTools();
    this.resources = await this.listResources();
    this.prompts = await this.listPrompts();
    this.initialized = true;
  }
  get ready(): boolean {
    return this.initialized;
  }
  // ---------------- stdio 传输 ----------------
  private connectStdio(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.cfg.command) return reject(new Error("stdio 需要 command"));
      const env = buildMcpEnv(this.cfg.env);
      try {
        this.child = spawn(this.cfg.command, this.cfg.args || [], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e: any) {
        return reject(e);
      }
      this.child.on("error", (e) => reject(e));
      this.child.stdout?.on("data", (d: Buffer) => this.onChunk(d.toString()));
      // stderr 透传到扩展输出，便于排查 server 自身问题
      this.child.stderr?.on("data", (_d: Buffer) => {
        // 静默：避免噪音；如需调试可取消注释 console.error
        // console.error(`[mcp:${this.name}]`, d.toString());
      });
      this.child.on("exit", (code) => {
        const wasInitialized = this.initialized;
        const err = new Error(`MCP server "${this.name}" 已退出（code=${code ?? "?"}）`);
        this.rejectPending(err);
        this.initialized = false;
        if (!wasInitialized && code !== 0) reject(err);
      });
      // 给 server 一点启动时间；initialize 后 resolve
      resolve();
    });
  }
  private onChunk(text: string): void {
    this.buf += text;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResp;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }
  private dispatch(msg: JsonRpcResp): void {
    if (msg.id === undefined) return; // 通知，忽略
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ---------------- JSON-RPC 发送 ----------------
  private send(req: JsonRpcReq, signal?: AbortSignal): Promise<any> {
    if (this.httpUrl) return this.sendHttp(req, signal);
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin) return reject(new Error("stdio 未连接"));
      if (signal?.aborted) return reject(new Error(`MCP 请求已取消：${req.method}`));
      const cleanup = () => {
        const p = this.pending.get(req.id);
        if (!p) return undefined;
        this.pending.delete(req.id);
        clearTimeout(p.timer);
        if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
        return p;
      };
      const timer = setTimeout(() => {
        const p = cleanup();
        p?.reject(new Error(`MCP stdio 请求超时（${MCP_REQUEST_TIMEOUT_MS}ms）：${req.method}`));
      }, MCP_REQUEST_TIMEOUT_MS);
      const pending = { resolve, reject, timer, signal } as {
        resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout;
        signal?: AbortSignal; onAbort?: () => void;
      };
      if (signal) {
        pending.onAbort = () => {
          const p = cleanup();
          p?.reject(new Error(`MCP 请求已取消：${req.method}`));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(req.id, pending);
      this.child.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (!err) return;
        const p = cleanup();
        p?.reject(err);
      });
    });
  }

  private async sendHttp(req: JsonRpcReq, signal?: AbortSignal): Promise<any> {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), MCP_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.httpUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      const ctype = res.headers.get("content-type") || "";
      if (ctype.includes("text/event-stream")) {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let last: any = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data && data !== "[DONE]") {
                try { last = JSON.parse(data); } catch { /* ignore */ }
              }
            }
          }
        }
        if (last?.error) throw new Error(last.error.message);
        return last?.result;
      }
      const j = await res.json();
      if (j?.error) throw new Error(j.error.message);
      return j?.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async initialize(): Promise<void> {
    await this.send({
      jsonrpc: "2.0",
      id: this.seq++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "freeseek-coder", version: "0.6.0" },
      },
    });
    // 发送 initialized 通知（无需响应，fire-and-forget）
    this.sendNotify("notifications/initialized", {});
  }

  /**
   * 发送 JSON-RPC 通知（无 id、无响应，fire-and-forget）。
   * 之前实现带 id 走 send() 导致 pending 永不 resolve：通知类消息 server 不回响应，
   * pending Map 永久残留、seq 单调增长（内存泄漏）。通知必须不带 id。
   */
  private sendNotify(method: string, params: any): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    if (this.httpUrl) {
      // Streamable HTTP：通知同样 POST，但不等响应，失败忽略
      fetch(this.httpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body,
      }).catch(() => {
        /* 通知失败忽略 */
      });
    } else if (this.child?.stdin) {
      this.child.stdin.write(body + "\n");
    }
  }

  private async listTools(): Promise<{ name: string; description: string; inputSchema: any }[]> {
    const res = (await this.send({
      jsonrpc: "2.0",
      id: this.seq++,
      method: "tools/list",
    })) as any;
    return (res?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  /** 列出 MCP resources（best-effort：server 不支持时返回空，不阻塞连接）。 */
  private async listResources(): Promise<{ uri: string; name: string; description?: string }[]> {
    try {
      const res = (await this.send({ jsonrpc: "2.0", id: this.seq++, method: "resources/list" })) as any;
      return (res?.resources || []).map((r: any) => ({
        uri: r.uri || "",
        name: r.name || r.uri || "",
        description: r.description || undefined,
      }));
    } catch {
      return [];
    }
  }

  /** 列出 MCP prompts（best-effort）。 */
  private async listPrompts(): Promise<{ name: string; description?: string; arguments?: any[] }[]> {
    try {
      const res = (await this.send({ jsonrpc: "2.0", id: this.seq++, method: "prompts/list" })) as any;
      return (res?.prompts || []).map((p: any) => ({
        name: p.name || "",
        description: p.description || undefined,
        arguments: p.arguments || undefined,
      }));
    } catch {
      return [];
    }
  }

  /** 读取指定 resource 内容（best-effort，失败返回错误文本）。 */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    try {
      const res = (await this.send({
        jsonrpc: "2.0",
        id: this.seq++,
        method: "resources/read",
        params: { uri },
      }, signal)) as any;
      const contents = res?.contents || [];
      return contents
        .map((c: any) => c?.text ?? c?.blob ?? JSON.stringify(c))
        .join("\n---\n");
    } catch (e: any) {
      return `读取 resource 失败：${e?.message ?? String(e)}`;
    }
  }

  /** 获取指定 prompt 模板并渲染参数（best-effort）。 */
  async getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
    try {
      const res = (await this.send({
        jsonrpc: "2.0",
        id: this.seq++,
        method: "prompts/get",
        params: { name, arguments: args },
      }, signal)) as any;
      return (res?.messages || [])
        .map((m: any) => `[${m.role}] ${m.content?.text ?? ""}`)
        .join("\n");
    } catch (e: any) {
      return `获取 prompt 失败：${e?.message ?? String(e)}`;
    }
  }

  async callTool(fullName: string, args: any, signal?: AbortSignal): Promise<string> {
    // fullName 形如 mcp__<server>__<tool>；server 名可含下划线，故剥离前缀后取剩余段
    const toolName = fullName.slice("mcp__".length).split("__").slice(1).join("__");
    const res = (await this.send({
      jsonrpc: "2.0",
      id: this.seq++,
      method: "tools/call",
      params: { name: toolName, arguments: args || {} },
    }, signal)) as any;
    const parts: string[] = [];
    for (const c of res?.content || []) {
      if (c.type === "text") parts.push(c.text || "");
      else if (c.type === "resource") parts.push(JSON.stringify(c.resource || c));
    }
    const text = parts.join("\n").trim() || "(空结果)";
    if (res?.isError) return `⚠️ MCP 工具 ${fullName} 返回错误：\n${text}`;
    return text;
  }

  dispose(): void {
    this.rejectPending(new Error(`MCP server "${this.name}" 已断开`));
    this.initialized = false;
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
  }
}

/** MCP 管理器（单例）：维护所有 server 连接与聚合工具表。 */
export class McpManager {
  private conns = new Map<string, McpConnection>();
  private connecting: Promise<void> | null = null;
  private connected = false;

  /** 按配置连接所有 server（best-effort，单次去重）。 */
  async connectAll(servers: McpServerConfig[]): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      for (const s of servers || []) {
        const conn = new McpConnection(s.name, s);
        try {
          await conn.connect();
          this.conns.set(s.name, conn);
          console.log(`[FreeSeek MCP] 已连接 server: ${s.name}（${conn.tools.length} 个工具）`);
        } catch (e: any) {
          console.warn(`[FreeSeek MCP] server "${s.name}" 连接失败：${e?.message ?? e}`);
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
    const server = name.slice(6).split("__")[0];
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
