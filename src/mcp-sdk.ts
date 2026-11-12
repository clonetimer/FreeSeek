/**
 * FreeSeek MCP SDK v2 adapter.
 *
 * The SDK owns JSON-RPC framing, protocol negotiation, pagination, cancellation,
 * Streamable HTTP/SSE transports and stdio child-process lifecycle. FreeSeek
 * keeps its existing ToolRegistry-facing contract and applies its own
 * environment allowlist and per-request timeout policy here.
 */
import {
  Client,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolRequestOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface McpSdkServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpSdkLogSink {
  info?(message: string): void;
  warn?(message: string): void;
}

const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_REQUEST_TIMEOUT_MS = 120_000;
const MCP_ENV_ALLOWLIST = [
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "WINDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TMP", "TEMP", "TMPDIR",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "APPDATA", "LOCALAPPDATA",
];

/** MCP child processes inherit only the runtime allowlist plus explicit config.env. */
export function buildMcpEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) env[key] = value;
  return env;
}

/**
 * Only a narrow set of HTTP client errors indicate that the endpoint may be a
 * legacy SSE-only MCP server. Authentication, authorization, server errors,
 * timeouts and network failures must never trigger a transport downgrade.
 */
export function isLegacySseFallbackError(error: unknown): error is SdkHttpError {
  if (!(error instanceof SdkHttpError)) return false;
  return [404, 405, 406, 415].includes(error.status);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatContent(content: readonly any[] | undefined): string {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item?.type === "text") {
      if (item.text) parts.push(item.text);
    } else if (item?.type === "resource") {
      const resource = item.resource ?? item;
      if (typeof resource.text === "string") parts.push(resource.text);
      else if (typeof resource.blob === "string") {
        parts.push(`[resource ${resource.uri ?? "unknown"}: ${resource.mimeType ?? "binary"}, base64 ${resource.blob.length} chars]`);
      }
    } else if (item?.type === "image" || item?.type === "audio") {
      parts.push(`[${item.type} content omitted from text channel: ${item.mimeType ?? "unknown"}, base64 ${String(item.data ?? "").length} chars]`);
    } else if (item?.type === "resource_link") {
      parts.push(`[resource link: ${item.name ?? item.title ?? item.uri}]`);
    } else if (item !== undefined) {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join("\n---\n").trim();
}

/** One MCP server connection, backed entirely by the official TypeScript SDK v2. */
export class McpConnection {
  private client: Client | null = null;
  private connected = false;

  tools: { name: string; description: string; inputSchema: any }[] = [];
  resources: { uri: string; name: string; description?: string }[] = [];
  prompts: { name: string; description?: string; arguments?: any[] }[] = [];

  constructor(
    public readonly name: string,
    private readonly cfg: McpSdkServerConfig,
    private readonly log: McpSdkLogSink = {}
  ) {}

  static isKnowledgeTool(name: string): boolean {
    return /search|query|retriev|kb|knowledge|find|lookup|semantic|vector|rag/i.test(name);
  }

  get ready(): boolean {
    return this.connected;
  }

  private createClient(mode: "auto" | "legacy"): Client {
    return new Client(
      { name: "freeseek-coder", version: "0.26.0" },
      {
        versionNegotiation: mode === "auto"
          ? { mode: "auto", probe: { timeoutMs: MCP_CONNECT_TIMEOUT_MS } }
          : { mode: "legacy" },
        inputRequired: { autoFulfill: false },
        listMaxPages: 64,
        defaultCacheTtlMs: 0,
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error) {
                this.log.warn?.(`[FreeSeek MCP] ${this.name} tools/list_changed refresh failed: ${describeError(error)}`);
                return;
              }
              this.tools = (tools ?? []).map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
              }));
            },
          },
          resources: {
            onChanged: (error, resources) => {
              if (error) {
                this.log.warn?.(`[FreeSeek MCP] ${this.name} resources/list_changed refresh failed: ${describeError(error)}`);
                return;
              }
              this.resources = (resources ?? []).map((resource) => ({
                uri: resource.uri,
                name: resource.name ?? resource.uri,
                description: resource.description ?? undefined,
              }));
            },
          },
          prompts: {
            onChanged: (error, prompts) => {
              if (error) {
                this.log.warn?.(`[FreeSeek MCP] ${this.name} prompts/list_changed refresh failed: ${describeError(error)}`);
                return;
              }
              this.prompts = (prompts ?? []).map((prompt) => ({
                name: prompt.name,
                description: prompt.description ?? undefined,
                arguments: prompt.arguments ?? undefined,
              }));
            },
          },
        },
      }
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.cfg.transport === "stdio") {
      await this.connectStdio();
    } else {
      await this.connectHttp();
    }
    const client = this.requireClient();
    const signal = AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS);
    const tools = await client.listTools(undefined, { signal });
    this.tools = (tools.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
    try {
      const result = await client.listResources(undefined, { signal });
      this.resources = (result.resources ?? []).map((resource) => ({
        uri: resource.uri,
        name: resource.name ?? resource.uri,
        description: resource.description ?? undefined,
      }));
    } catch (error) {
      this.log.warn?.(`[FreeSeek MCP] ${this.name} resources/list unavailable: ${describeError(error)}`);
    }
    try {
      const result = await client.listPrompts(undefined, { signal });
      this.prompts = (result.prompts ?? []).map((prompt) => ({
        name: prompt.name,
        description: prompt.description ?? undefined,
        arguments: prompt.arguments ?? undefined,
      }));
    } catch (error) {
      this.log.warn?.(`[FreeSeek MCP] ${this.name} prompts/list unavailable: ${describeError(error)}`);
    }
    this.connected = true;
  }

  private async connectStdio(): Promise<void> {
    if (!this.cfg.command) throw new Error("stdio 需要 command");
    const transport = new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args ?? [],
      env: buildMcpEnv(this.cfg.env),
      stderr: "pipe",
    });
    // Preserve the previous policy: MCP child stderr must never contaminate
    // the host protocol stream or expose arbitrary child output in normal logs.
    transport.stderr?.on("data", () => undefined);
    const client = this.createClient("auto");
    this.client = client;
    try {
      await client.connect(transport, {
        timeout: MCP_CONNECT_TIMEOUT_MS,
        signal: AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      this.client = null;
      throw error;
    }
  }

  private async connectHttp(): Promise<void> {
    if (!this.cfg.url) throw new Error("http transport 需要 url");
    const url = new URL(this.cfg.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("MCP HTTP endpoint 仅支持 http:// 或 https://");
    }

    const modernClient = this.createClient("auto");
    const modernTransport = new StreamableHTTPClientTransport(url, {
      redirectPolicy: "same-origin",
    });
    this.client = modernClient;
    try {
      await modernClient.connect(modernTransport, {
        timeout: MCP_CONNECT_TIMEOUT_MS,
        signal: AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS),
      });
      return;
    } catch (error) {
      await modernClient.close().catch(() => undefined);
      this.client = null;
      if (!isLegacySseFallbackError(error)) throw error;
      this.log.info?.(`[FreeSeek MCP] ${this.name} Streamable HTTP returned HTTP ${error.status}; trying legacy SSE transport`);
    }

    const legacyClient = this.createClient("legacy");
    const legacyTransport = new SSEClientTransport(url, {
      redirectPolicy: "same-origin",
    });
    this.client = legacyClient;
    try {
      await legacyClient.connect(legacyTransport, {
        timeout: MCP_CONNECT_TIMEOUT_MS,
        signal: AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      await legacyClient.close().catch(() => undefined);
      this.client = null;
      const combined = new Error(
        `MCP Streamable HTTP is unavailable and legacy SSE fallback failed: ${describeError(error)}`
      );
      (combined as Error & { cause?: unknown }).cause = error;
      throw combined;
    }
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(`MCP server "${this.name}" 未连接`);
    return this.client;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.requireClient().readResource({ uri }, { signal: requestSignal(signal) });
      return (result.contents ?? []).map((item) => {
        if ("text" in item && typeof item.text === "string") return item.text;
        if ("blob" in item && typeof item.blob === "string") {
          return `[resource ${item.uri}: ${item.mimeType ?? "binary"}, base64 ${item.blob.length} chars]`;
        }
        return JSON.stringify(item);
      }).join("\n---\n");
    } catch (error) {
      return `读取 resource 失败：${describeError(error)}`;
    }
  }

  async getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.requireClient().getPrompt(
        { name, arguments: args },
        { signal: requestSignal(signal) }
      );
      return (result.messages ?? []).map((message) => {
        const content = message.content as any;
        return `[${message.role}] ${formatContent([content])}`;
      }).join("\n");
    } catch (error) {
      return `获取 prompt 失败：${describeError(error)}`;
    }
  }

  async callTool(fullName: string, args: any, signal?: AbortSignal): Promise<string> {
    const prefix = `mcp__${this.name}__`;
    if (!fullName.startsWith(prefix)) throw new Error(`MCP tool route mismatch: ${fullName}`);
    const toolName = fullName.slice(prefix.length);
    if (!toolName) throw new Error("MCP tool name 不能为空");

    const options: CallToolRequestOptions = { signal: requestSignal(signal) };
    const result = await this.requireClient().callTool(
      { name: toolName, arguments: args ?? {} },
      options
    );
    const parts = formatContent(result.content);
    const structured = result.structuredContent === undefined
      ? ""
      : `\n\nStructured content:\n${JSON.stringify(result.structuredContent)}`;
    const text = parts || (structured ? "" : "(空结果)");
    if (result.isError) return `⚠️ MCP 工具 ${fullName} 返回错误：\n${text}${structured}`;
    return `${text}${structured}`.trim() || "(空结果)";
  }

  dispose(): void {
    this.connected = false;
    const client = this.client;
    this.client = null;
    if (client) void client.close().catch(() => undefined);
  }
}
