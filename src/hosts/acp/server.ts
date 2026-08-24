import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { runAgent } from "../../agent";
import type { AgentCallbacks } from "../../agent-types";
import {
  deriveConversationAtSeq,
  endSessionEventLog,
  ensureEventLog,
  type SessionEventLog,
} from "../../eventlog";
import type { McpServerConfig } from "../../mcp";
import type { ChatMessage, ToolCall, ToolDefinition } from "../../provider";
import type { AskRequest, ToolContext } from "../../tools";
import { createCliRuntimeServices, type CliRuntimeServices } from "../cli/runtime-services";
import { createAcpHostCapabilities } from "./capabilities";
import { createAcpFileEvidenceCollector, loadPersistedAcpFileEvidence } from "./file-evidence-store";
import { AcpRpcError, NdJsonRpcPeer } from "./protocol";
import { acpToolArgs, acpToolKind, acpToolResultFailed, acpToolResultFields, replayAcpHistory } from "./presentation";
import { AcpSessionStore, type AcpSessionMetadata } from "./session-store";
import { modeState, normalizeAcpCwd, parseAcpMcpServers, parseAdditionalDirectories, parseAgentMode, sameStringSet } from "./session-config";
import { createAcpExtensionServices, type AcpExtensionServices } from "./extensions";
import { handleAcpExtensionManagement } from "./extension-management";
import type { ExtensionSandboxPolicy } from "../../kernel/extensions/sandbox-policy";
export interface AcpAgentServerOptions {
  sessionDir: string;
  agentVersion: string;
  allowShell?: boolean;
  allowNetwork?: boolean;
  autoApprove?: boolean;
  enableMultiAgent?: boolean;
  enableSkills?: boolean;
  skillDirs?: string[];
  extensionDirs?: string[];
  extensionSandboxPolicy?: ExtensionSandboxPolicy;
  contextPlanner?: "off" | "v1" | "v1.1" | "v1.2";
  contextPlannerBudget?: number;
  verbose?: boolean;
  log?: (message: string) => void;
}
interface ActiveAcpSession {
  metadata: AcpSessionMetadata;
  messages: ChatMessage[];
  services: CliRuntimeServices;
  log: SessionEventLog;
  abort?: AbortController;
  promptTask?: Promise<unknown>;
}
interface AcpContentBlock {
  type?: unknown;
  text?: unknown;
  uri?: unknown;
  name?: unknown;
  mimeType?: unknown;
  [key: string]: unknown;
}

interface AcpClientCapabilities {
  elicitation?: {
    form?: unknown;
    url?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const SYSTEM_PROMPT: ChatMessage = {
  role: "system",
  content:
    "You are FreeSeek, a local-first coding agent. Inspect the workspace with tools before making claims. " +
    "Respect runtime permissions, make minimal changes, verify work when execution is allowed, and summarize changed files and validation at the end.",
};

const ACP_PROTOCOL_VERSION = 1;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw AcpRpcError.invalidParams(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw AcpRpcError.invalidParams(`${label}.${key} must be a non-empty string`);
  return value;
}

function promptToText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) throw AcpRpcError.invalidParams("prompt must be a non-empty content block array");
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const block = record(value[index], `prompt[${index}]`) as AcpContentBlock;
    if (block.type === "text") {
      if (typeof block.text !== "string") throw AcpRpcError.invalidParams(`prompt[${index}].text must be a string`);
      chunks.push(block.text);
      continue;
    }
    if (block.type === "resource_link") {
      const uri = typeof block.uri === "string" ? block.uri : "";
      if (!uri) throw AcpRpcError.invalidParams(`prompt[${index}].uri is required for resource_link`);
      const label = typeof block.name === "string" && block.name.trim() ? block.name.trim() : uri;
      chunks.push(`[Resource link: ${label} (${uri})]`);
      continue;
    }
    throw AcpRpcError.invalidParams(`unsupported prompt content type: ${String(block.type)}`);
  }
  const text = chunks.join("\n\n").trim();
  if (!text) throw AcpRpcError.invalidParams("prompt resolves to empty text");
  return text;
}

function titleFromPrompt(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= 80 ? single : single.slice(0, 79) + "…";
}

function availableToolsForAcp(
  tools: readonly ToolDefinition[],
  options: { interactive: boolean; skills: boolean; multiAgent: boolean }
): ToolDefinition[] {
  return tools.filter((tool) => {
    const name = tool.function.name;
    if (name === "lsp") return false;
    if (!options.interactive && name === "ask_user") return false;
    if (!options.skills && name === "load_skill") return false;
    if (!options.multiAgent && ["spawn_agent", "spawn_agents", "send_message"].includes(name)) return false;
    return true;
  });
}

function systemPromptForSession(metadata: AcpSessionMetadata): ChatMessage {
  const roots = metadata.additionalDirectories ?? [];
  if (!roots.length) return { ...SYSTEM_PROMPT };
  return {
    role: "system",
    content: `${SYSTEM_PROMPT.content}\n\nACP workspace scope: primary=${metadata.cwd}; additional authorized roots=${roots.join(", ")}. ` +
      "Relative paths resolve under the primary workspace. Use absolute paths to access an additional authorized root.",
  };
}

/** Stable ACP v1 stdio host. All execution still routes through FreeSeek runAgent/ToolRuntime/EventLog. */
export class AcpAgentServer {
  private readonly store: AcpSessionStore;
  private readonly active = new Map<string, ActiveAcpSession>();
  private initialized = false; private clientCapabilities: AcpClientCapabilities = {};
  private formElicitation = false;
  private readonly extensions: AcpExtensionServices;
  constructor(
    private readonly peer: NdJsonRpcPeer,
    private readonly options: AcpAgentServerOptions
  ) {
    this.store = new AcpSessionStore(path.resolve(options.sessionDir));
    fs.mkdirSync(this.store.eventsDir, { recursive: true });
    this.extensions = createAcpExtensionServices(options.extensionDirs, path.resolve(options.sessionDir), (message) => this.log(message), options.extensionSandboxPolicy);
  }

  start(): void { this.peer.start((method, params, requestId) => this.handle(method, params, requestId)); }

  async close(reason = "acp-server-close"): Promise<void> {
    for (const session of [...this.active.values()]) await this.disposeActive(session, reason);
    this.active.clear();
    await this.extensions.dispose();
    this.peer.close(reason);
  }

  private async handle(method: string, params: unknown, _requestId?: string | number | null): Promise<unknown> {
    if (method === "initialize") return this.initialize(params);
    // ACP v1 generic request cancellation is optional; FreeSeek supports session/cancel.
    if (method === "$/cancel_request") return {};
    if (!this.initialized) throw new AcpRpcError(-32001, "ACP connection must be initialized before session methods");
    if (method.startsWith("freesek/extensions/")) await this.extensions.ready;
    const extensionManagement = await handleAcpExtensionManagement(method, params, this.extensions.management);
    if (extensionManagement.handled) return extensionManagement.value;
    switch (method) {
      case "session/new": return this.newSession(params);
      case "session/prompt": return this.prompt(params);
      case "session/cancel": return this.cancel(params);
      case "session/list": return this.listSessions(params);
      case "session/resume": return this.resumeSession(params);
      case "session/load": return this.loadSession(params);
      case "session/close": return this.closeSession(params);
      case "session/set_mode": return this.setMode(params);
      default: throw AcpRpcError.methodNotFound(method);
    }
  }

  private initialize(params: unknown): unknown {
    const row = record(params ?? {}, "initialize params");
    const requested = row.protocolVersion;
    if (!Number.isInteger(requested)) throw AcpRpcError.invalidParams("protocolVersion must be an integer");
    const rawCaps = row.clientCapabilities;
    this.clientCapabilities = rawCaps && typeof rawCaps === "object" && !Array.isArray(rawCaps)
      ? rawCaps as AcpClientCapabilities
      : {};
    this.formElicitation = this.clientCapabilities.elicitation?.form != null;
    this.initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: { name: "FreeSeek", title: "FreeSeek", version: this.options.agentVersion },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {}, close: {}, additionalDirectories: {} },
      },
      authMethods: [],
    };
  }

  private async newSession(params: unknown): Promise<unknown> {
    const row = record(params, "session/new params");
    const cwd = normalizeAcpCwd(row.cwd);
    const additionalDirectories = parseAdditionalDirectories(row.additionalDirectories, cwd);
    const mcpServers = parseAcpMcpServers(row.mcpServers);
    const sessionId = `acp-${crypto.randomUUID()}`;
    const metadata = this.store.create(
      sessionId, cwd, mcpServers.map((server) => server.name), additionalDirectories, "coder"
    );
    const active = await this.createActive(metadata, mcpServers, false);
    this.active.set(sessionId, active);
    this.log(`ACP session/new ${sessionId} cwd=${cwd} extra=${additionalDirectories.length} mcp=${mcpServers.length}`);
    return { sessionId, modes: modeState(metadata.agentMode ?? "coder") };
  }

  private async resumeSession(params: unknown): Promise<unknown> {
    return this.openStoredSession(params, "session/resume", false);
  }

  private async loadSession(params: unknown): Promise<unknown> {
    return this.openStoredSession(params, "session/load", true);
  }

  private async openStoredSession(params: unknown, method: "session/resume" | "session/load", replayHistory: boolean): Promise<unknown> {
    const row = record(params, `${method} params`);
    const sessionId = stringField(row, "sessionId", `${method} params`);
    const metadata = this.requireMetadata(sessionId);
    const cwd = normalizeAcpCwd(row.cwd);
    if (cwd !== metadata.cwd) throw AcpRpcError.invalidParams(`${method} cwd does not match stored session cwd: ${metadata.cwd}`);
    const storedDirectories = metadata.additionalDirectories ?? [];
    const resumedDirectories = row.additionalDirectories === undefined
      ? []
      : parseAdditionalDirectories(row.additionalDirectories, cwd);
    if (storedDirectories.length && row.additionalDirectories === undefined) {
      throw AcpRpcError.invalidParams(
        `session ${sessionId} used additionalDirectories; ${method} must re-supply the same authorized roots`
      );
    }
    if (!sameStringSet(storedDirectories, resumedDirectories)) {
      throw AcpRpcError.invalidParams(
        `${method} additionalDirectories must match the original roots: ${storedDirectories.join(", ") || "(none)"}`
      );
    }
    const storedMcpNames = [...(metadata.mcpServerNames ?? [])].sort();
    if (storedMcpNames.length && row.mcpServers === undefined) {
      throw AcpRpcError.invalidParams(
        `session ${sessionId} used MCP servers (${storedMcpNames.join(", ")}); ${method} must re-supply mcpServers because commands/env/secrets are not persisted`
      );
    }
    const mcpServers = row.mcpServers === undefined ? [] : parseAcpMcpServers(row.mcpServers);
    const resumedMcpNames = mcpServers.map((server) => server.name).sort();
    if (storedMcpNames.join("\u0000") !== resumedMcpNames.join("\u0000")) {
      throw AcpRpcError.invalidParams(
        `${method} mcpServers must match the original server names: ${storedMcpNames.join(", ") || "(none)"}`
      );
    }
    const prior = this.active.get(sessionId);
    if (prior) await this.disposeActive(prior, "acp-resume-reopen", false);
    const active = await this.createActive({ ...metadata, closedAt: undefined }, mcpServers, true);
    this.active.set(sessionId, active);
    this.store.update(sessionId, { closedAt: undefined });
    if (replayHistory) {
      replayAcpHistory(
        sessionId,
        active.messages,
        metadata.agentMode ?? "coder",
        (id, update) => this.update(id, update),
        loadPersistedAcpFileEvidence(this.store.eventsDir, sessionId)
      );
    }
    this.log(`ACP ${method} ${sessionId}`);
    return { modes: modeState(metadata.agentMode ?? "coder") };
  }

  private listSessions(params: unknown): unknown {
    const row = params === undefined || params === null ? {} : record(params, "session/list params");
    let cwd: string | undefined;
    if (row.cwd !== undefined) cwd = normalizeAcpCwd(row.cwd);
    if (row.cursor !== undefined && typeof row.cursor !== "string") throw AcpRpcError.invalidParams("cursor must be a string");
    let listed;
    try {
      listed = this.store.list({ cwd, cursor: row.cursor as string | undefined });
    } catch (error: any) {
      throw AcpRpcError.invalidParams(error?.message ?? "invalid session/list cursor");
    }
    return {
      sessions: listed.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        ...(session.title ? { title: session.title } : {}),
        ...(session.additionalDirectories?.length ? { additionalDirectories: session.additionalDirectories } : {}),
        updatedAt: session.updatedAt,
      })),
      ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
    };
  }

  private async closeSession(params: unknown): Promise<unknown> {
    const row = record(params, "session/close params");
    const sessionId = stringField(row, "sessionId", "session/close params");
    this.requireMetadata(sessionId);
    const active = this.active.get(sessionId);
    if (active) await this.disposeActive(active, "acp-session-close");
    this.active.delete(sessionId);
    this.store.update(sessionId, { closedAt: new Date().toISOString() });
    this.log(`ACP session/close ${sessionId}`);
    return {};
  }

  private setMode(params: unknown): unknown {
    const row = record(params, "session/set_mode params");
    const sessionId = stringField(row, "sessionId", "session/set_mode params");
    const metadata = this.requireMetadata(sessionId);
    const mode = parseAgentMode(row.modeId, metadata.agentMode ?? "coder");
    const updated = this.store.update(sessionId, { agentMode: mode });
    const active = this.active.get(sessionId);
    if (active) active.metadata = updated;
    this.update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
    this.log(`ACP session/set_mode ${sessionId} mode=${mode}`);
    return {};
  }

  private cancel(params: unknown): void {
    const row = record(params, "session/cancel params");
    const sessionId = stringField(row, "sessionId", "session/cancel params");
    const active = this.active.get(sessionId);
    if (!active) return;
    active.abort?.abort(new Error("ACP session/cancel"));
  }

  private async prompt(params: unknown): Promise<unknown> {
    const row = record(params, "session/prompt params");
    const sessionId = stringField(row, "sessionId", "session/prompt params");
    const active = this.active.get(sessionId);
    if (!active) {
      if (this.store.read(sessionId)) throw AcpRpcError.invalidParams(`session ${sessionId} is not active; call session/resume first`);
      throw AcpRpcError.invalidParams(`session not found: ${sessionId}`);
    }
    if (active.promptTask) throw AcpRpcError.invalidRequest(`session is busy: ${sessionId}`);
    const text = promptToText(row.prompt);
    const user: ChatMessage = { role: "user", content: text };
    active.messages.push(user);
    active.log.append("user/message", { ...active.log.persistMessage(user) }, "main");
    if (!active.metadata.title) {
      const title = titleFromPrompt(text);
      active.metadata = this.store.update(sessionId, { title });
      active.log.append("session_title", { title }, "main");
    } else {
      active.metadata = this.store.touch(sessionId);
    }

    const abort = new AbortController();
    active.abort = abort;
    const task = this.runPrompt(active, abort.signal);
    active.promptTask = task;
    try {
      await task;
      return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
    } catch (error: any) {
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw AcpRpcError.internal(error?.message ?? String(error));
    } finally {
      if (active.abort === abort) active.abort = undefined;
      if (active.promptTask === task) active.promptTask = undefined;
      try { active.metadata = this.store.touch(sessionId); } catch { /* metadata persistence is best effort after a completed turn */ }
    }
  }

  private async runPrompt(active: ActiveAcpSession, signal: AbortSignal): Promise<void> {
    await this.extensions.ready;
    const capabilities = createAcpHostCapabilities({
      mcp: true,
      skills: this.options.enableSkills !== false,
      multiAgent: !!this.options.enableMultiAgent,
      interactive: this.formElicitation,
    });
    const tools = availableToolsForAcp(active.services.toolDefinitions, {
      interactive: capabilities.interactiveInput,
      skills: capabilities.skills,
      multiAgent: capabilities.multiAgent,
    });
    const permission = (toolName: string, input: unknown, callId?: string) =>
      this.requestPermission(active.metadata.sessionId, toolName, input, callId, signal);
    const fileEvidence = createAcpFileEvidenceCollector(active.log);
    const ctx: ToolContext = {
      workspaceRoot: active.metadata.cwd,
      additionalWorkspaceRoots: active.metadata.additionalDirectories,
      runtime: {
        maxSteps: 25,
        contextBudget: 32000,
        contextPlanner: this.options.contextPlanner ?? "off",
        contextPlannerBudget: this.options.contextPlannerBudget ?? 3500,
        maxWallClockMs: 10 * 60 * 1000,
        autoCheckpoint: true,
        offloadThreshold: 50000,
        autoFormat: false,
      },
      allowShell: !!this.options.allowShell,
      confirmFileWrites: !this.options.autoApprove,
      allowNetwork: this.options.allowNetwork !== false,
      askUser: (request) => this.requestElicitation(active.metadata.sessionId, request, signal),
      skillManager: capabilities.skills ? active.services.skillManager : undefined,
      promoteSkill: capabilities.skills
        ? (name) => active.services.skillManager.setStatus(name, "active").message
        : undefined,
      requestMCPApproval: async (toolName, description, callId) => {
        if (this.options.autoApprove) return "allow";
        const decision = await permission(toolName, { description }, callId);
        if (!decision.allow) return "";
        return decision.persist === "allow" ? "allow" : "once";
      },
      todoState: { items: [] },
      toolDefinitions: tools,
      mcpManager: active.services.mcpManager,
      extensionRuntime: this.extensions.runtime,
      canSpawn: capabilities.multiAgent,
      planMode: active.metadata.agentMode === "plan",
      agentMode: active.metadata.agentMode ?? "coder",
      sandboxMode: this.options.allowShell ? "sandbox" : "off",
      commandTimeout: 120000,
      allowRules: [],
      denyRules: [],
      allowCommandHooks: false,
      offloadDir: path.join(this.options.sessionDir, "offload", active.metadata.sessionId),
      checkpointDir: path.join(this.options.sessionDir, "checkpoints", active.metadata.sessionId),
      userMemoryPath: path.join(this.options.sessionDir, "memory"),
      signal,
      eventLog: active.log,
      eventActor: "main",
      onFileRead: fileEvidence.onFileRead,
      onFileDiff: fileEvidence.onFileDiff,
    };
    const cb: AgentCallbacks = {
      onAssistantText: (delta) => this.update(active.metadata.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: delta },
      }),
      onReasoning: this.options.verbose ? (delta) => this.update(active.metadata.sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: delta },
      }) : undefined,
      onToolStart: (call) => this.update(active.metadata.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: call.id,
        title: call.function.name,
        kind: acpToolKind(call.function.name),
        status: "in_progress",
        rawInput: acpToolArgs(call),
      }),
      onToolResult: (call, result) => {
        this.update(active.metadata.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: call.id,
          status: acpToolResultFailed(result) ? "failed" : "completed",
          ...acpToolResultFields(result, fileEvidence.take(call.id)),
        });
      },
      onStep: () => undefined,
      onContextStatus: this.options.verbose ? (text) => this.log(`[${active.metadata.sessionId}] ${text}`) : undefined,
      onPermissionRequest: async (toolName, input, callId) => {
        if (this.options.autoApprove) return { allow: true, reason: "ACP --yes" };
        return permission(toolName, input, callId);
      },
      signal,
    };
    const result = await runAgent(active.messages, tools, ctx, cb);
    active.messages.splice(0, active.messages.length, ...result);
  }

  private async requestElicitation(sessionId: string, request: AskRequest, signal: AbortSignal): Promise<string> {
    if (!this.formElicitation) {
      throw new Error("ACP client did not advertise clientCapabilities.elicitation.form");
    }
    const options = request.options ?? [];
    const descriptions = options
      .filter((option) => option.description?.trim())
      .map((option) => `- ${option.label}: ${option.description}`);
    const message = descriptions.length ? `${request.question}\n\n${descriptions.join("\n")}` : request.question;
    const property: Record<string, unknown> = options.length
      ? request.multiSelect
        ? { type: "array", items: { type: "string", enum: options.map((option) => option.label) } }
        : { type: "string", enum: options.map((option) => option.label) }
      : { type: "string" };
    const response = await this.peer.request("elicitation/create", {
      mode: "form",
      sessionId,
      message,
      requestedSchema: {
        type: "object",
        properties: { value: property },
        required: ["value"],
      },
    }, signal) as any;
    if (response?.action !== "accept" || !response.content || !("value" in response.content)) return "";
    const value = response.content.value;
    if (Array.isArray(value)) return value.map(String).join(", ");
    if (value === undefined || value === null) return "";
    return String(value);
  }

  private async requestPermission(
    sessionId: string,
    toolName: string,
    input: unknown,
    callId: string | undefined,
    signal: AbortSignal
  ): Promise<{ allow: boolean; persist?: "allow" | "deny"; reason?: string }> {
    const permissionId = callId || `permission-${crypto.randomUUID()}`;
    const response = await this.peer.request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: permissionId,
        title: `Approve ${toolName}?`,
        kind: acpToolKind(toolName),
        status: "pending",
        rawInput: input,
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
      ],
    }, signal) as any;
    const outcome = response?.outcome;
    if (!outcome || outcome.outcome === "cancelled") return { allow: false, reason: "ACP permission cancelled" };
    if (outcome.outcome !== "selected" || typeof outcome.optionId !== "string") return { allow: false, reason: "Invalid ACP permission response" };
    switch (outcome.optionId) {
      case "allow-once": return { allow: true };
      case "allow-always": return { allow: true, persist: "allow" };
      case "reject-always": return { allow: false, persist: "deny", reason: "User rejected this tool permanently" };
      default: return { allow: false, reason: "User rejected this tool" };
    }
  }

  private update(sessionId: string, update: Record<string, unknown>): void {
    this.peer.notify("session/update", { sessionId, update });
  }

  private async createActive(metadata: AcpSessionMetadata, mcpServers: McpServerConfig[], resumed: boolean): Promise<ActiveAcpSession> {
    const services = await createCliRuntimeServices({
      workspace: metadata.cwd,
      additionalWorkspaces: metadata.additionalDirectories ?? [],
      mcpServers,
      skillDirs: this.options.skillDirs ?? [],
      mcpLog: {
        info: (message) => this.log(message),
        warn: (message) => this.log(message),
      },
    });
    const log = ensureEventLog(this.store.eventsDir, metadata.sessionId);
    let messages: ChatMessage[];
    if (resumed) {
      const recovered = deriveConversationAtSeq(this.store.eventsDir, metadata.sessionId);
      if (!recovered.complete) {
        services.dispose();
        throw AcpRpcError.internal(`session ${metadata.sessionId} cannot be losslessly resumed from EventLog`);
      }
      messages = recovered.messages.length ? recovered.messages : [systemPromptForSession(metadata)];
    } else {
      const systemPrompt = systemPromptForSession(metadata);
      messages = [systemPrompt];
      log.append("system/message", { message: systemPrompt }, "main");
    }
    return { metadata, messages, services, log };
  }

  private requireMetadata(sessionId: string): AcpSessionMetadata {
    const metadata = this.store.read(sessionId);
    if (!metadata) throw AcpRpcError.invalidParams(`session not found: ${sessionId}`);
    return metadata;
  }

  private async disposeActive(active: ActiveAcpSession, reason: string, endLog = true): Promise<void> {
    active.abort?.abort(new Error(reason));
    if (active.promptTask) {
      await Promise.race([
        active.promptTask.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    active.services.dispose();
    if (endLog) endSessionEventLog(active.metadata.sessionId, reason);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
