/**
 * FreeSeek MCP SDK v2 adapter.
 *
 * The SDK owns JSON-RPC framing, protocol negotiation, pagination, cancellation,
 * Streamable HTTP/SSE transports and stdio child-process lifecycle. FreeSeek
 * keeps its existing ToolRegistry-facing contract and applies its own
 * environment allowlist and per-request timeout policy here.
 */

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

interface McpToolRecord {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface McpResourceRecord {
  uri: string;
  name?: string;
  description?: string;
}

interface McpPromptRecord {
  name: string;
  description?: string;
  arguments?: any[];
}

interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface McpPromptMessage {
  role: string;
  content: any;
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
export function isLegacySseFallbackError(error: unknown): error is { name: "SdkHttpError"; status: number } {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; status?: number };
  return candidate.name === "SdkHttpError" && typeof candidate.status === "number"
    && [404, 405, 406, 415].includes(candidate.status);
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
  private client: any = null;
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

  private createClient(ClientConstructor: any, mode: "auto" | "legacy"): any {
    return new ClientConstructor(
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
            onChanged: (error: unknown, tools: readonly McpToolRecord[] | undefined) => {
              if (error) {
                this.log.warn?.(`[FreeSeek MCP] ${this.name} tools/list_changed refresh failed: ${describeError(error)}`);
                return;
              }
              this.tools = (tools ?? []).map((tool: McpToolRecord) => ({
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
              }));
            },
          },
          resources: {
            onChanged: (error: unknown, resources: readonly McpResourceRecord[] | undefined) => {
              if (error) {
                this.log.warn?.(`[FreeSeek MCP] ${this.name} resources/list_changed refresh failed: ${describeError(error)}`);
                return;
              }
              this.resources = (resources ?? []).map((resource: McpResourceRecord) => ({
                uri: resource.uri,
                name: resource.name ?? resource.uri,
                description: resource.description ?? undefined,
              }));
            },
          },
          prompts: {
            onChanged: (error: unknown, prompts: readonly McpPromptRecord[] | undefined) => {
              if (error) {
                this.log.warn?.(`[FreeSeek MCP] ${this.name} prompts/list_changed refresh failed: ${describeError(error)}`);
                return;
              }
              this.prompts = (prompts ?? []).map((prompt: McpPromptRecord) => ({
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
    const toolsSignal = AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS);
    // SDK v2 correctly honors server capability declarations. A number of
    // existing legacy servers omit capabilities.tools/resources/prompts while
    // still implementing the corresponding list methods. Preserve FreeSeek's
    // previous best-effort behavior only for negotiated legacy connections.
    const tools = (client.getProtocolEra() === "legacy" && !client.getServerCapabilities()?.tools
      ? await client.request({ method: "tools/list" }, { signal: toolsSignal })
      : await client.listTools(undefined, { signal: toolsSignal })) as { tools?: McpToolRecord[] };
    this.tools = (tools.tools ?? []).map((tool: McpToolRecord) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
    try {
      const signal = AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS);
      const result = (client.getProtocolEra() === "legacy" && !client.getServerCapabilities()?.resources
        ? await client.request({ method: "resources/list" }, { signal })
        : await client.listResources(undefined, { signal })) as { resources?: McpResourceRecord[] };
      this.resources = (result.resources ?? []).map((resource: McpResourceRecord) => ({
        uri: resource.uri,
        name: resource.name ?? resource.uri,
        description: resource.description ?? undefined,
      }));
    } catch (error) {
      this.log.warn?.(`[FreeSeek MCP] ${this.name} resources/list unavailable: ${describeError(error)}`);
    }
    try {
      const signal = AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS);
      const result = (client.getProtocolEra() === "legacy" && !client.getServerCapabilities()?.prompts
        ? await client.request({ method: "prompts/list" }, { signal })
        : await client.listPrompts(undefined, { signal })) as { prompts?: McpPromptRecord[] };
      this.prompts = (result.prompts ?? []).map((prompt: McpPromptRecord) => ({
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
    const [clientSdk, stdioSdk] = await Promise.all([
      import("@modelcontextprotocol/client"),
      import("@modelcontextprotocol/client/stdio"),
    ]);
    const transport = new stdioSdk.StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args ?? [],
      env: buildMcpEnv(this.cfg.env),
      stderr: "pipe",
    });
    // Preserve the previous policy: MCP child stderr must never contaminate
    // the host protocol stream or expose arbitrary child output in normal logs.
    transport.stderr?.on("data", () => undefined);
    const client = this.createClient(clientSdk.Client, "auto");
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

    const clientSdk = await import("@modelcontextprotocol/client");
    const modernClient = this.createClient(clientSdk.Client, "auto");
    const modernTransport = new clientSdk.StreamableHTTPClientTransport(url, {
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

    const legacyClient = this.createClient(clientSdk.Client, "legacy");
    const legacyTransport = new clientSdk.SSEClientTransport(url, {
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

  private requireClient(): any {
    if (!this.client) throw new Error(`MCP server "${this.name}" 未连接`);
    return this.client;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.requireClient().readResource({ uri }, { signal: requestSignal(signal) }) as { contents?: McpResourceContent[] };
      return (result.contents ?? []).map((item: McpResourceContent) => {
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
      ) as { messages?: McpPromptMessage[] };
      return (result.messages ?? []).map((message: McpPromptMessage) => {
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

    const options = { signal: requestSignal(signal) };
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

  async close(): Promise<void> {
    this.connected = false;
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
  }

  dispose(): void {
    void this.close();
  }
}
