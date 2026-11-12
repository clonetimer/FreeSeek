import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { NdJsonRpcPeer } from "../acp/protocol";
import type { AuthType, ProviderFormat } from "../../providers";

/** Provider/runtime launch options used by the Desktop Host to start FreeSeek ACP. */
export interface DesktopAcpLaunchOptions {
  readonly nodeCommand?: string;
  readonly agentEntry: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly format?: ProviderFormat;
  readonly toolMode?: "native" | "react";
  readonly authType?: AuthType;
  readonly sessionDir: string;
  readonly allowShell?: boolean;
  readonly allowNetwork?: boolean;
  readonly enableMultiAgent?: boolean;
  readonly enableSkills?: boolean;
  readonly skillDirs?: readonly string[];
  readonly extensionDirs?: readonly string[];
  readonly extensionSandboxPolicyFile?: string;
  readonly contextPlanner?: "off" | "v1" | "v1.1" | "v1.2";
  readonly contextPlanBudget?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Interactive callbacks implemented by a concrete desktop shell/UI. */
export interface DesktopAcpHandlers {
  onSessionUpdate?(params: unknown): void;
  onDiagnostic?(message: string): void;
  requestPermission?(params: unknown): Promise<string | null> | string | null;
  requestElicitation?(params: unknown): Promise<unknown> | unknown;
}

/** Minimal MCP descriptor accepted by ACP session/new, session/resume and session/load. */
export interface DesktopAcpMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: readonly { name: string; value: string }[];
}

/** Host-neutral ACP client used by the standalone Desktop Host. */
export class DesktopAcpConnection {
  private readonly peer: NdJsonRpcPeer;
  private initialized = false;

  constructor(
    input: Readable,
    output: Writable,
    private readonly handlers: DesktopAcpHandlers = {},
    onProtocolError: (message: string) => void = () => undefined
  ) {
    this.peer = new NdJsonRpcPeer(input, output, onProtocolError);
    this.peer.start((method, params) => this.handleServerRequest(method, params));
  }

  /** Negotiate ACP v1 and advertise desktop form-elicitation support. */
  async initialize(clientVersion: string): Promise<unknown> {
    const result = await this.peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: "FreeSeek Desktop", version: clientVersion },
    });
    this.initialized = true;
    return result;
  }

  /** Create a durable FreeSeek ACP session rooted at the chosen workspace. */
  async newSession(
    cwd: string,
    options: { additionalDirectories?: readonly string[]; mcpServers?: readonly DesktopAcpMcpServer[] } = {}
  ): Promise<{ sessionId: string; modes?: unknown }> {
    this.requireInitialized();
    return await this.peer.request("session/new", {
      cwd,
      mcpServers: options.mcpServers ?? [],
      additionalDirectories: options.additionalDirectories ?? [],
    }) as { sessionId: string; modes?: unknown };
  }

  /** Submit one text prompt and resolve when the Agent turn completes. */
  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<{ stopReason?: string }> {
    this.requireInitialized();
    return await this.peer.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    }, signal) as { stopReason?: string };
  }

  /** List durable ACP sessions available to the Desktop Host. */
  async listSessions(options: { cwd?: string; cursor?: string } = {}): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("session/list", {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
  }

  /** Resume a previously closed durable session with the same authorization scope. */
  async resumeSession(
    sessionId: string,
    cwd: string,
    options: { additionalDirectories?: readonly string[]; mcpServers?: readonly DesktopAcpMcpServer[] } = {}
  ): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("session/resume", {
      sessionId,
      cwd,
      mcpServers: options.mcpServers ?? [],
      additionalDirectories: options.additionalDirectories ?? [],
    });
  }

  /** Load a durable session and request ACP history replay through session/update. */
  async loadSession(
    sessionId: string,
    cwd: string,
    options: { additionalDirectories?: readonly string[]; mcpServers?: readonly DesktopAcpMcpServer[] } = {}
  ): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("session/load", {
      sessionId,
      cwd,
      mcpServers: options.mcpServers ?? [],
      additionalDirectories: options.additionalDirectories ?? [],
    });
  }

  /** Close one active session while retaining durable history for future resume. */
  async closeSession(sessionId: string): Promise<void> {
    this.requireInitialized();
    await this.peer.request("session/close", { sessionId });
  }

  /** Switch the host-neutral FreeSeek Agent mode. */
  async setMode(sessionId: string, modeId: "coder" | "craft" | "plan" | "ask"): Promise<void> {
    this.requireInitialized();
    await this.peer.request("session/set_mode", { sessionId, modeId });
  }

  /** FreeSeek namespaced H3 extension management methods; ACP-compatible clients may ignore them. */
  extensionsList(): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("freesek/extensions/list", {});
  }

  extensionStatus(id: string): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("freesek/extensions/status", { id });
  }

  extensionReload(id: string): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("freesek/extensions/reload", { id });
  }

  extensionRemove(id: string): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("freesek/extensions/remove", { id });
  }

  extensionsReconcile(): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("freesek/extensions/reconcile", {});
  }

  extensionConfigure(id: string, enabled: boolean): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("freesek/extensions/config", { id, enabled });
  }

  extensionAudit(id?: string, limit = 100): Promise<unknown> {
    this.requireInitialized();
    return this.peer.request("freesek/extensions/audit", { ...(id ? { id } : {}), limit });
  }

  /** Cancel the active turn for a session without tearing down the ACP process. */
  cancel(sessionId: string): void {
    this.requireInitialized();
    this.peer.notify("session/cancel", { sessionId });
  }

  /** Close the transport and reject outstanding requests. */
  close(reason = "desktop-acp-client-close"): void {
    this.peer.close(reason);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("FreeSeek Desktop ACP client is not initialized");
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/update") {
      this.handlers.onSessionUpdate?.(params);
      return {};
    }
    if (method === "session/request_permission") {
      const selected = await this.handlers.requestPermission?.(params);
      if (!selected) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: selected } };
    }
    if (method === "elicitation/create") {
      if (!this.handlers.requestElicitation) return { action: "cancel" };
      const value = await this.handlers.requestElicitation(params);
      if (value === undefined || value === null) return { action: "cancel" };
      return { action: "accept", content: { value } };
    }
    this.handlers.onDiagnostic?.(`Unsupported ACP client method: ${method}`);
    return {};
  }
}

/** Spawn a FreeSeek ACP child process and bind the desktop protocol client to its stdio. */
export function spawnDesktopAcpConnection(
  options: DesktopAcpLaunchOptions,
  handlers: DesktopAcpHandlers = {},
  spawnImpl: typeof spawn = spawn
): { child: ChildProcessWithoutNullStreams; connection: DesktopAcpConnection } {
  const args = buildDesktopAcpArgs(options);
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: buildDesktopAcpEnv(options),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  const child = spawnImpl(options.nodeCommand || "node", [options.agentEntry, ...args], spawnOptions) as ChildProcessWithoutNullStreams;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string | Buffer) => handlers.onDiagnostic?.(String(chunk)));
  const connection = new DesktopAcpConnection(
    child.stdout,
    child.stdin,
    handlers,
    (message) => handlers.onDiagnostic?.(message)
  );
  return { child, connection };
}


/** Build the ACP child environment without inheriting or exposing stale provider credentials. */
export function buildDesktopAcpEnv(options: DesktopAcpLaunchOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.FREESEEK_API_KEY;
  if (options.apiKey) env.FREESEEK_API_KEY = options.apiKey;
  return env;
}

/** Convert desktop launch configuration to the stable freeseek-acp CLI contract. */
export function buildDesktopAcpArgs(options: DesktopAcpLaunchOptions): string[] {
  const args = [
    "--base-url", options.baseUrl,
    "--model", options.model,
    "--format", options.format ?? "openai",
    "--tool-mode", options.toolMode ?? "native",
    "--auth-type", options.authType ?? (options.apiKey ? "bearer" : "none"),
    "--session-dir", options.sessionDir,
    "--context-planner", options.contextPlanner ?? "off",
    "--context-plan-budget", String(options.contextPlanBudget ?? 3500),
  ];
  if (options.allowShell) args.push("--allow-shell");
  if (options.allowNetwork === false) args.push("--no-network");
  if (options.enableMultiAgent) args.push("--enable-multi-agent");
  if (options.enableSkills === false) args.push("--no-skills");
  for (const directory of options.skillDirs ?? []) args.push("--skills-dir", directory);
  for (const directory of options.extensionDirs ?? []) args.push("--extension-dir", directory);
  if (options.extensionSandboxPolicyFile) args.push("--extension-sandbox-policy", options.extensionSandboxPolicyFile);
  return args;
}
