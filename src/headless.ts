#!/usr/bin/env node
/**
 * FreeSeek Headless runner：复用同一 Agent/ToolRegistry/ToolRuntime/EventLog 内核，
 * 不依赖 VS Code ExtensionContext。0.18 起作为正式 CLI run host，默认 fail-closed。
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
declare const __FREESEEK_CLI_ENTRY__: string | undefined;
import { runAgent } from "./agent";
import { TOOL_DEFINITIONS, type ToolContext } from "./tools";
import type { AgentCallbacks } from "./agent-types";
import type { ChatMessage, ToolCall } from "./provider";
import {
  configureProviderSettingsHost,
  type ActiveSelection,
  type ProviderConfig,
  type ProviderFormat,
  type AuthType,
} from "./providers";
import { configureDebugHost } from "./debug";
import {
  deriveConversationAtSeq,
  endSessionEventLog,
  ensureEventLog,
  forkSessionEventLog,
  assertSafeSessionId,
} from "./eventlog";
import { materializeCheckpoint } from "./checkpoints";


export interface HeadlessIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const PROCESS_IO: HeadlessIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

interface HeadlessArgs {
  workspace: string;
  prompt: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ProviderFormat;
  toolMode: "native" | "react";
  authType: AuthType;
  sessionDir: string;
  sessionId: string;
  resume?: string;
  fork?: string;
  at?: number;
  yes: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
  verbose: boolean;
  contextPlanner: "off" | "v1" | "v1.1" | "v1.2";
  contextPlanBudget: number;
}

function usage(): string {
  return [
    "FreeSeek Headless",
    "",
    "必需：",
    "  --prompt <text|->        用户任务；传 - 时从 stdin 读取",
    "  --base-url <url>        Provider API 根（如 https://api.deepseek.com）",
    "  --model <id>             模型 id（也可 FREESEEK_MODEL）",
    "",
    "可选：",
    "  --api-key <key>         API Key（也可 FREESEEK_API_KEY；--auth-type none 时可省略）",
    "  --workspace <dir>       工作区，默认 cwd",
    "  --format <f>            协议：openai|claude|gemini（默认 openai）",
    "  --tool-mode <m>         工具协议：native|react（默认 native）",
    "  --auth-type <a>         认证头：none|bearer|x-api-key|x-goog-api-key",
    "  --session-dir <dir>     durable session 目录，默认 ~/.freesek/headless",
    "  --session-id <id>       当前 session id，默认自动生成",
    "  --resume <id>           从完整 EventLog 恢复后继续",
    "  --fork <id> --at <seq>  从指定 session/event seq 分叉到隔离工作区",
    "  --yes                   自动批准 Runtime 要求的人类审批",
    "  --allow-shell           开启命令/代码执行能力（仍受 Runtime policy/sandbox 约束）",
    "  --no-network            禁止网络工具/connector",
    "  --context-planner <m>  上下文规划：off|v1|v1.1|v1.2（默认 off，便于 A/B）",
    "  --context-plan-budget <n> Planner 注入 token 预算，默认 3500",
    "  --verbose               输出 debug 请求概要",
  ].join("\n");
}

function nextValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return value;
}

function parseArgs(argv: string[]): HeadlessArgs {
  const opts: Partial<HeadlessArgs> = {
    workspace: process.cwd(),
    sessionDir: path.join(os.homedir(), ".freesek", "headless"),
    sessionId: `headless-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    apiKey: process.env.FREESEEK_API_KEY ?? "",
    model: process.env.FREESEEK_MODEL ?? "",
    baseUrl: process.env.FREESEEK_BASE_URL ?? "",
    format: (["openai", "claude", "gemini"] as const).includes(process.env.FREESEEK_FORMAT as any) ? process.env.FREESEEK_FORMAT as ProviderFormat : "openai",
    toolMode: (["native", "react"] as const).includes(process.env.FREESEEK_TOOL_MODE as any) ? process.env.FREESEEK_TOOL_MODE as "native" | "react" : "native",
    authType: (["none", "bearer", "x-api-key", "x-goog-api-key"] as const).includes(process.env.FREESEEK_AUTH_TYPE as any) ? process.env.FREESEEK_AUTH_TYPE as AuthType : "bearer",
    yes: false,
    allowShell: false,
    allowNetwork: true,
    verbose: false,
    contextPlanner: (["v1", "v1.1", "v1.2"] as const).includes(process.env.FREESEEK_CONTEXT_PLANNER as any) ? process.env.FREESEEK_CONTEXT_PLANNER as "v1" | "v1.1" | "v1.2" : "off",
    contextPlanBudget: 3500,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(0); }
    if (arg === "--yes") { opts.yes = true; continue; }
    if (arg === "--allow-shell") { opts.allowShell = true; continue; }
    if (arg === "--no-network") { opts.allowNetwork = false; continue; }
    if (arg === "--verbose") { opts.verbose = true; continue; }
    if (["--workspace", "--prompt", "--base-url", "--api-key", "--model", "--format", "--tool-mode", "--auth-type", "--session-dir", "--session-id", "--resume", "--fork", "--at", "--context-planner", "--context-plan-budget"].includes(arg)) {
      const value = nextValue(argv, i, arg); i++;
      if (arg === "--at") opts.at = Number(value);
      else if (arg === "--context-plan-budget") opts.contextPlanBudget = Number(value);
      else if (arg === "--context-planner") opts.contextPlanner = value as "off" | "v1" | "v1.1" | "v1.2";
      else (opts as Record<string, unknown>)[arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (opts.prompt === "-") opts.prompt = fs.readFileSync(0, "utf8");
  if (!opts.prompt?.trim()) throw new Error("缺少 --prompt（或使用 --prompt - 从 stdin 读取）");
  if (!opts.baseUrl?.trim()) throw new Error("缺少 --base-url / FREESEEK_BASE_URL");
  if (!opts.model?.trim()) throw new Error("缺少 --model / FREESEEK_MODEL");
  if (!["openai", "claude", "gemini"].includes(String(opts.format))) throw new Error("--format 必须是 openai|claude|gemini");
  if (!["native", "react"].includes(String(opts.toolMode))) throw new Error("--tool-mode 必须是 native|react");
  if (!["none", "bearer", "x-api-key", "x-goog-api-key"].includes(String(opts.authType))) throw new Error("--auth-type 必须是 none|bearer|x-api-key|x-goog-api-key");
  if (opts.fork && (!Number.isInteger(opts.at) || Number(opts.at) < 1)) throw new Error("--fork 必须同时提供正整数 --at");
  if (!['off', 'v1', 'v1.1', 'v1.2'].includes(String(opts.contextPlanner))) throw new Error("--context-planner 必须是 off|v1|v1.1|v1.2");
  if (!Number.isFinite(opts.contextPlanBudget) || Number(opts.contextPlanBudget) < 256 || Number(opts.contextPlanBudget) > 12000) throw new Error("--context-plan-budget 必须在 256..12000");
  opts.workspace = path.resolve(String(opts.workspace));
  opts.sessionDir = path.resolve(String(opts.sessionDir));
  assertSafeSessionId(String(opts.sessionId));
  if (opts.resume) assertSafeSessionId(String(opts.resume));
  if (opts.fork) assertSafeSessionId(String(opts.fork));
  return opts as HeadlessArgs;
}

function configureHeadlessProvider(args: HeadlessArgs): void {
  const provider: ProviderConfig = {
    id: "headless",
    name: `Headless ${args.format}`,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    toolMode: args.toolMode,
    format: args.format,
    authType: args.authType,
    models: [{ id: args.model }],
  };
  const active: ActiveSelection = { providerId: provider.id, modelId: args.model };
  const values = new Map<string, unknown>([["providers", [provider]], ["activeModel", active]]);
  configureProviderSettingsHost({
    get: <T>(key: string, fallback: T) => (values.has(key) ? values.get(key) as T : fallback),
    getAbsolute: <T>(_key: string, fallback: T) => fallback,
    update: (key: string, value: unknown) => { values.set(key, value); },
  });
}

function initialConversation(args: HeadlessArgs, io: HeadlessIO): ChatMessage[] {
  if (args.fork) {
    const forked = forkSessionEventLog(args.sessionDir, args.fork, args.sessionId, Number(args.at));
    if (!forked.checkpoint) {
      throw new Error(
        `源会话 ${args.fork} 在 event #${args.at} 之前没有 workspace checkpoint，拒绝创建对话/代码状态不一致的 fork`
      );
    }
    const forkRoot = path.join(args.sessionDir, "fork-workspaces");
    fs.mkdirSync(forkRoot, { recursive: true });
    const sessionReal = fs.realpathSync(args.sessionDir);
    const forkRootReal = fs.realpathSync(forkRoot);
    const rel = path.relative(sessionReal, forkRootReal);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new Error("fork-workspaces 目录通过 symlink 逃逸 session-dir，已拒绝物化历史代码");
    }
    const forkWorkspace = path.join(forkRootReal, args.sessionId);
    materializeCheckpoint(
      forked.checkpoint.workspaceRoot,
      forked.checkpoint.hash,
      forkWorkspace,
      path.join(args.sessionDir, "checkpoints")
    );
    args.workspace = forkWorkspace;
    io.stderr(
      `[fork] ${args.fork}@${args.at} -> ${args.sessionId}; checkpoint ${forked.checkpoint.hash.slice(0, 10)}; workspace=${forkWorkspace}\n`
    );
    return forked.messages;
  }
  if (args.resume) {
    const recovered = deriveConversationAtSeq(args.sessionDir, args.resume);
    if (!recovered.complete || !recovered.messages.length) {
      throw new Error(`会话 ${args.resume} 无法从 EventLog 完整恢复`);
    }
    args.sessionId = args.resume;
    return recovered.messages;
  }
  return [{
    role: "system",
    content:
      "You are FreeSeek, a local-first coding agent. Inspect the workspace with tools before making claims. " +
      "Respect runtime permissions, make minimal changes, verify work when execution is allowed, and summarize changed files and validation at the end.",
  }];
}

function toolContext(args: HeadlessArgs, signal: AbortSignal): ToolContext {
  const log = ensureEventLog(args.sessionDir, args.sessionId);
  return {
    workspaceRoot: args.workspace,
    runtime: {
      maxSteps: 25,
      contextBudget: 32000,
      contextPlanner: args.contextPlanner,
      contextPlannerBudget: args.contextPlanBudget,
      maxWallClockMs: 10 * 60 * 1000,
      autoCheckpoint: true,
      offloadThreshold: 50000,
      autoFormat: false,
    },
    allowShell: args.allowShell,
    confirmFileWrites: !args.yes,
    allowNetwork: args.allowNetwork,
    askUser: async () => "",
    todoState: { items: [] },
    canSpawn: false,
    planMode: false,
    agentMode: "coder",
    sandboxMode: args.allowShell ? "sandbox" : "off",
    commandTimeout: 120000,
    allowRules: [],
    denyRules: [],
    allowCommandHooks: false,
    offloadDir: path.join(args.sessionDir, "offload"),
    checkpointDir: path.join(args.sessionDir, "checkpoints"),
    userMemoryPath: path.join(args.sessionDir, "memory"),
    signal,
    eventLog: log,
    eventActor: "main",
  };
}

function callbacks(args: HeadlessArgs, signal: AbortSignal, io: HeadlessIO): AgentCallbacks {
  return {
    onAssistantText: (delta) => io.stdout(delta),
    onReasoning: args.verbose ? (delta) => io.stderr(`[reasoning] ${delta}`) : undefined,
    onToolStart: (call: ToolCall) => io.stderr(`\n[tool:start] ${call.function.name}\n`),
    onToolResult: (call: ToolCall, result: string) => io.stderr(`[tool:end] ${call.function.name}: ${result.slice(0, 500)}\n`),
    onStep: (step, text) => { if (args.verbose) io.stderr(`[step ${step}] ${text}\n`); },
    onContextStatus: (text) => io.stderr(`[status] ${text}\n`),
    onPermissionRequest: async () => ({ allow: args.yes, reason: args.yes ? "headless --yes" : "headless 默认拒绝；传 --yes 才自动批准" }),
    signal,
  };
}

/** CLI 主入口；导出便于 smoke/unit test。 */
export async function runHeadless(argv = process.argv.slice(2), io: HeadlessIO = PROCESS_IO): Promise<number> {
  let args: HeadlessArgs;
  try { args = parseArgs(argv); } catch (e: any) { io.stderr(`${e?.message ?? e}\n\n${usage()}\n`); return 2; }
  if (!fs.existsSync(args.workspace) || !fs.statSync(args.workspace).isDirectory()) {
    io.stderr(`workspace 不存在：${args.workspace}\n`); return 2;
  }
  fs.mkdirSync(args.sessionDir, { recursive: true });
  configureHeadlessProvider(args);
  configureDebugHost({ verbose: args.verbose, channel: { appendLine: (line) => io.stderr(`[debug] ${line}\n`) } });
  const abort = new AbortController();
  const onSigint = () => abort.abort(new Error("SIGINT"));
  process.once("SIGINT", onSigint);
  try {
    const messages = initialConversation(args, io);
    const user: ChatMessage = { role: "user", content: args.prompt.trim() };
    messages.push(user);
    const log = ensureEventLog(args.sessionDir, args.sessionId);
    log.append("user/message", { ...log.persistMessage(user) }, "main");
    await runAgent(messages, TOOL_DEFINITIONS, toolContext(args, abort.signal), callbacks(args, abort.signal, io));
    io.stdout("\n");
    endSessionEventLog(args.sessionId, "headless-complete");
    return 0;
  } catch (e: any) {
    io.stderr(`\nFreeSeek Headless 失败：${e?.message ?? String(e)}\n`);
    endSessionEventLog(args.sessionId, abort.signal.aborted ? "headless-aborted" : "headless-error");
    return abort.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

if (typeof __FREESEEK_CLI_ENTRY__ !== "undefined" && __FREESEEK_CLI_ENTRY__ === "headless") {
  void runHeadless().then((code) => { process.exitCode = code; });
}
