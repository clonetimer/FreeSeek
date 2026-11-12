#!/usr/bin/env node
/**
 * FreeSeek Headless runner：复用同一 Agent/ToolRegistry/ToolRuntime/EventLog 内核，
 * 不依赖 VS Code ExtensionContext。0.18 起作为正式 CLI run host，默认 fail-closed。
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createInterface } from "node:readline/promises";
declare const __FREESEEK_CLI_ENTRY__: string | undefined;
import { runAgent } from "./agent";
import type { ToolContext } from "./tools";
import type { AgentCallbacks } from "./agent-types";
import type { ChatMessage, ToolCall } from "./provider";
import { type ProviderFormat, type AuthType } from "./providers";
import { configureDebugHost } from "./debug";
import {
  deriveConversationAtSeq,
  endSessionEventLog,
  ensureEventLog,
  forkSessionEventLog,
  assertSafeSessionId,
} from "./eventlog";
import { materializeCheckpoint } from "./checkpoints";
import { createCliHostCapabilities } from "./hosts/cli/capabilities";
import { createCliInteractionService, type CliInteractionService } from "./hosts/cli/interaction";
import { createCliRuntimeServices, type CliRuntimeServices } from "./hosts/cli/runtime-services";
import { configureStandaloneProvider } from "./hosts/standalone-provider";
import { FileExtensionHost } from "./kernel/extensions/package-host";
import type { ExtensionRuntime } from "./kernel/extensions/runtime";
import { loadExtensionSandboxPolicyFile } from "./kernel/extensions/sandbox-policy";
import {
  createRemoteCommandRunner,
  createStaticRemoteWorkspaceMapper,
  createLocalDockerRemoteSandboxTransport,
  createSshRemoteSandboxTransport,
  createE2BRemoteSandboxTransport,
} from "./remote-sandbox";
import { setCommandRunner } from "./seam";
import { type SandboxMode, loadExecPolicyDocument } from "./sandbox";
import { createTuiSession, type TuiHandle } from "./tui";


export interface HeadlessIO {
  stdout(text: string): void;
  stderr(text: string): void;
  prompt?(text: string): Promise<string>;
}

const PROCESS_IO: HeadlessIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  prompt: async (text) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return await rl.question(text); } finally { rl.close(); }
  },
};

interface HeadlessArgs {
  workspace: string;
  prompt: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ProviderFormat;
  toolMode: "native" | "react";
  mode: "coder" | "plan" | "ask";
  authType: AuthType;
  sessionDir: string;
  sessionId: string;
  resume?: string;
  fork?: string;
  at?: number;
  yes: boolean;
  interactive: boolean;
  enableMultiAgent: boolean;
  mcpConfig?: string;
  skillsDir: string[];
  extensionDirs: string[];
  extensionSandboxPolicyFile?: string;
  extensionManage?: "list" | "status" | "reload" | "remove" | "reconcile" | "audit" | "enable" | "disable";
  extensionId?: string;
  allowShell: boolean;
  allowNetwork: boolean;
  /** 沙箱模式：off|readonly|sandbox|remote:<docker|ssh|e2b>@<target>（缺口3 远程沙箱接入）。 */
  sandbox: string;
  /** 缺口1：全交互式 TUI（实时流式渲染 + 键盘审批）。 */
  tui: boolean;
  /** 缺口2：声明式执行策略文件路径（JSON，ExecPolicyDocument）。 */
  execPolicy?: string;
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
    "  --mode <m>              运行模式：coder|plan|ask（默认 coder；plan/ask 只读，非只读工具被拦截）",
    "  --auth-type <a>         认证头：none|bearer|x-api-key|x-goog-api-key",
    "  --session-dir <dir>     durable session 目录，默认 ~/.freesek/headless",
    "  --session-id <id>       当前 session id，默认自动生成",
    "  --resume <id>           从完整 EventLog 恢复后继续",
    "  --fork <id> --at <seq>  从指定 session/event seq 分叉到隔离工作区",
    "  --yes                   自动批准 Runtime 要求的人类审批",
    "  --interactive           允许 ask_user / 权限请求在终端询问（CI 默认关闭）",
    "  --enable-multi-agent    显式开放 spawn_agent/spawn_agents（默认关闭以控制成本）",
    "  --mcp-config <file>     加载 MCP server JSON 配置；首次外部调用仍独立审批",
    "  --skills-dir <dir>      追加技能目录（可重复；默认已含项目/用户技能目录）",
    "  --extension-dir <dir>   显式信任并热加载 General HMR extension 目录（可重复）",
    "  --extension-sandbox-policy <file>  H4 untrusted capability grants（启动时只读 JSON）",
    "  --extension-manage <op> H3 管理：list|status|reload|remove|reconcile|audit|enable|disable",
    "  --extension-id <id>     status/reload/remove/audit/enable/disable 的 extension id",
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
    format: (["openai", "responses", "claude", "gemini"] as const).includes(process.env.FREESEEK_FORMAT as any) ? process.env.FREESEEK_FORMAT as ProviderFormat : "openai",
    toolMode: (["native", "react"] as const).includes(process.env.FREESEEK_TOOL_MODE as any) ? process.env.FREESEEK_TOOL_MODE as "native" | "react" : "native",
    mode: (["coder", "plan", "ask"] as const).includes(process.env.FREESEEK_MODE as any) ? process.env.FREESEEK_MODE as "coder" | "plan" | "ask" : "coder",
    authType: (["none", "bearer", "x-api-key", "x-goog-api-key"] as const).includes(process.env.FREESEEK_AUTH_TYPE as any) ? process.env.FREESEEK_AUTH_TYPE as AuthType : "bearer",
    yes: false,
    interactive: false,
    enableMultiAgent: false,
    skillsDir: [],
    extensionDirs: [],
    allowShell: false,
    allowNetwork: true,
    sandbox: "off",
    tui: false,
    execPolicy: undefined,
    verbose: false,
    contextPlanner: (["v1", "v1.1", "v1.2"] as const).includes(process.env.FREESEEK_CONTEXT_PLANNER as any) ? process.env.FREESEEK_CONTEXT_PLANNER as "v1" | "v1.1" | "v1.2" : "off",
    contextPlanBudget: 3500,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(0); }
    if (arg === "--yes") { opts.yes = true; continue; }
    if (arg === "--interactive") { opts.interactive = true; continue; }
    if (arg === "--enable-multi-agent") { opts.enableMultiAgent = true; continue; }
    if (arg === "--skills-dir" || arg === "--extension-dir") {
      const dir = nextValue(argv, i, arg); i++;
      if (arg === "--skills-dir") (opts.skillsDir ??= []).push(dir);
      else (opts.extensionDirs ??= []).push(dir);
      continue;
    }
    if (arg === "--allow-shell") { opts.allowShell = true; continue; }
    if (arg === "--no-network") { opts.allowNetwork = false; continue; }
    if (arg === "--verbose") { opts.verbose = true; continue; }
    if (arg === "--tui") { opts.tui = true; continue; }
    if (arg === "--sandbox") { const v = nextValue(argv, i, arg); i++; opts.sandbox = v; continue; }
    if (arg === "--exec-policy") { const v = nextValue(argv, i, arg); i++; opts.execPolicy = v; continue; }
    if (["--workspace", "--prompt", "--base-url", "--api-key", "--model", "--format", "--tool-mode", "--mode", "--auth-type", "--session-dir", "--session-id", "--resume", "--fork", "--at", "--mcp-config", "--context-planner", "--context-plan-budget", "--extension-manage", "--extension-id", "--extension-sandbox-policy"].includes(arg)) {
      const value = nextValue(argv, i, arg); i++;
      if (arg === "--at") opts.at = Number(value);
      else if (arg === "--context-plan-budget") opts.contextPlanBudget = Number(value);
      else if (arg === "--context-planner") opts.contextPlanner = value as "off" | "v1" | "v1.1" | "v1.2";
      else if (arg === "--extension-manage") opts.extensionManage = value as HeadlessArgs["extensionManage"];
      else if (arg === "--extension-id") opts.extensionId = value;
      else if (arg === "--extension-sandbox-policy") opts.extensionSandboxPolicyFile = path.resolve(value);
      else (opts as Record<string, unknown>)[arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  const managementOps = ["list", "status", "reload", "remove", "reconcile", "audit", "enable", "disable"];
  if (opts.extensionManage && !managementOps.includes(String(opts.extensionManage))) throw new Error("--extension-manage 非法");
  if (opts.extensionManage && !(opts.extensionDirs ?? []).length) throw new Error("--extension-manage 需要至少一个 --extension-dir 显式 trust root");
  if (opts.extensionManage && ["status", "reload", "remove", "enable", "disable"].includes(opts.extensionManage) && !opts.extensionId?.trim()) {
    throw new Error(`--extension-manage ${opts.extensionManage} 需要 --extension-id`);
  }
  if (!opts.extensionManage) {
    if (opts.interactive && opts.prompt === "-") throw new Error("--interactive 不能与 --prompt - 共用 stdin；请直接传 --prompt 文本");
    if (opts.prompt === "-") opts.prompt = fs.readFileSync(0, "utf8");
    if (!opts.prompt?.trim()) throw new Error("缺少 --prompt（或使用 --prompt - 从 stdin 读取）");
    if (!opts.baseUrl?.trim()) throw new Error("缺少 --base-url / FREESEEK_BASE_URL");
    if (!opts.model?.trim()) throw new Error("缺少 --model / FREESEEK_MODEL");
  }
  if (!["openai", "claude", "gemini"].includes(String(opts.format))) throw new Error("--format 必须是 openai|claude|gemini");
  if (!["native", "react"].includes(String(opts.toolMode))) throw new Error("--tool-mode 必须是 native|react");
  if (!["coder", "plan", "ask"].includes(String(opts.mode))) throw new Error("--mode 必须是 coder|plan|ask");
  if (!["none", "bearer", "x-api-key", "x-goog-api-key"].includes(String(opts.authType))) throw new Error("--auth-type 必须是 none|bearer|x-api-key|x-goog-api-key");
  if (opts.fork && (!Number.isInteger(opts.at) || Number(opts.at) < 1)) throw new Error("--fork 必须同时提供正整数 --at");
  if (!['off', 'v1', 'v1.1', 'v1.2'].includes(String(opts.contextPlanner))) throw new Error("--context-planner 必须是 off|v1|v1.1|v1.2");
  if (!Number.isFinite(opts.contextPlanBudget) || Number(opts.contextPlanBudget) < 256 || Number(opts.contextPlanBudget) > 12000) throw new Error("--context-plan-budget 必须在 256..12000");
  opts.workspace = path.resolve(String(opts.workspace));
  opts.sessionDir = path.resolve(String(opts.sessionDir));
  if (opts.mcpConfig) opts.mcpConfig = path.resolve(String(opts.mcpConfig));
  opts.skillsDir = (opts.skillsDir ?? []).map((dir) => path.resolve(String(dir)));
  opts.extensionDirs = (opts.extensionDirs ?? []).map((dir) => path.resolve(String(dir)));
  if (opts.extensionSandboxPolicyFile) opts.extensionSandboxPolicyFile = path.resolve(String(opts.extensionSandboxPolicyFile));
  assertSafeSessionId(String(opts.sessionId));
  if (opts.resume) assertSafeSessionId(String(opts.resume));
  if (opts.fork) assertSafeSessionId(String(opts.fork));
  return opts as HeadlessArgs;
}

function configureHeadlessProvider(args: HeadlessArgs): void {
  configureStandaloneProvider({
    id: "headless",
    name: `Headless ${args.format}`,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    format: args.format,
    toolMode: args.toolMode,
    authType: args.authType,
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

function toolContext(
  args: HeadlessArgs,
  signal: AbortSignal,
  interaction: CliInteractionService,
  services: CliRuntimeServices,
  canSpawn: boolean,
  extensionRuntime?: ExtensionRuntime
): ToolContext {
  // 缺口2：加载声明式执行策略文档（若存在）。文件缺失/非法直接抛错，fail-fast。
  let execPolicyDocument: ToolContext["execPolicyDocument"];
  if (args.execPolicy) {
    const raw = JSON.parse(fs.readFileSync(args.execPolicy, "utf8"));
    execPolicyDocument = loadExecPolicyDocument(raw);
  }
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
    askUser: interaction.askUser,
    skillManager: services.skillManager,
    promoteSkill: (name) => services.skillManager.setStatus(name, "active").message,
    ...(services.mcpEnabled ? {
      requestMCPApproval: async (toolName: string, description: string) => {
        if (args.yes) return "allow" as const;
        if (args.interactive) return interaction.requestMcpPermission(toolName, description);
        return "" as const;
      },
    } : {}),
    todoState: { items: [] },
    toolDefinitions: services.toolDefinitions,
    mcpManager: services.mcpManager,
    extensionRuntime,
    canSpawn,
    planMode: false,
    agentMode: args.mode,
    sandboxMode: resolveSandboxMode(args.sandbox),
    commandTimeout: 120000,
    allowRules: [],
    denyRules: [],
    ...(execPolicyDocument ? { execPolicyDocument } : {}),
    allowCommandHooks: false,
    offloadDir: path.join(args.sessionDir, "offload"),
    checkpointDir: path.join(args.sessionDir, "checkpoints"),
    userMemoryPath: path.join(args.sessionDir, "memory"),
    signal,
    eventLog: log,
    eventActor: "main",
  };
}

/**
 * 缺口3：解析 --sandbox 并注入对应 CommandRunner。
 *   off / readonly / sandbox  → 重置为内核默认本地 runner（由 RunCommand 接管档位）
 *   remote:docker@<container> → docker exec 隔离执行
 *   remote:ssh@<host>         → SSH 远端执行
 *   remote:e2b@<sandboxId>    → E2B 云沙箱（需要 E2B_API_KEY）
 * 远程 runner 通过 seam.setCommandRunner 注入，RunCommand 的工具执行链路无需改动。
 */
function configureSandboxRunner(spec: string, io: HeadlessIO, workspaceRoot: string): void {
  if (!spec.startsWith("remote:")) {
    // off / readonly / sandbox：回退到内核默认本地 runner，档位交由 toolContext.sandboxMode。
    setCommandRunner(null);
    return;
  }
  const rest = spec.slice("remote:".length);
  const at = rest.indexOf("@");
  const kind = at === -1 ? rest : rest.slice(0, at);
  const target = at === -1 ? "" : rest.slice(at + 1);
  switch (kind) {
    case "docker":
      if (!target) throw new Error("--sandbox remote:docker 需要 @<container>");
      setCommandRunner(createRemoteCommandRunner({
        transport: createLocalDockerRemoteSandboxTransport({ container: target }),
        mapCwd: createStaticRemoteWorkspaceMapper(workspaceRoot, `docker:${target}`),
      }));
      io.stderr(`[sandbox] 已切换为本地 Docker 隔离沙箱：容器 ${target}\n`);
      break;
    case "ssh": {
      if (!target) throw new Error("--sandbox remote:ssh 需要 @<user@host>");
      const [apiKey, host] = (() => {
        const key = process.env.FREESEEK_SSH_KEY;
        return [key, target];
      })();
      void apiKey;
      setCommandRunner(createRemoteCommandRunner({
        transport: createSshRemoteSandboxTransport({ host }),
        mapCwd: createStaticRemoteWorkspaceMapper(workspaceRoot, `ssh:${target}`),
      }));
      io.stderr(`[sandbox] 已切换为 SSH 远端沙箱：${target}\n`);
      break;
    }
    case "e2b": {
      if (!target) throw new Error("--sandbox remote:e2b 需要 @<sandboxId>");
      const apiKey = process.env.E2B_API_KEY;
      if (!apiKey) throw new Error("--sandbox remote:e2b 需要环境变量 E2B_API_KEY");
      setCommandRunner(createRemoteCommandRunner({
        transport: createE2BRemoteSandboxTransport({ sandboxId: target, apiKey }),
        mapCwd: createStaticRemoteWorkspaceMapper(workspaceRoot, `e2b:${target}`),
      }));
      io.stderr(`[sandbox] 已切换为 E2B 云沙箱：${target}\n`);
      break;
    }
    default:
      throw new Error(`--sandbox 未知远端类型：${kind}（支持 docker/ssh/e2b）`);
  }
}

/** 把 --sandbox 字符串解析为 RunCommand 使用的 sandboxMode（远程走 off，由远端 transport 隔离）。 */
function resolveSandboxMode(spec: string): SandboxMode {
  if (spec.startsWith("remote:")) return "off";
  if (spec === "readonly" || spec === "sandbox" || spec === "off") return spec as SandboxMode;
  return "off";
}

function callbacks(args: HeadlessArgs, signal: AbortSignal, io: HeadlessIO, interaction: CliInteractionService, tui?: TuiHandle): AgentCallbacks {
  return {
    onAssistantText: (delta) => tui ? tui.assistant(delta) : io.stdout(delta),
    onReasoning: args.verbose ? (delta) => io.stderr(`[reasoning] ${delta}`) : undefined,
    onToolStart: (call: ToolCall) => tui ? tui.toolStart(call) : io.stderr(`\n[tool:start] ${call.function.name}\n`),
    onToolResult: (call: ToolCall, result: string) => tui ? tui.toolResult(call, result) : io.stderr(`[tool:end] ${call.function.name}: ${result.slice(0, 500)}\n`),
    onStep: (step, text) => { if (args.verbose) io.stderr(`[step ${step}] ${text}\n`); },
    onContextStatus: (text) => io.stderr(`[status] ${text}\n`),
    onPermissionRequest: async (toolName) => {
      if (args.yes) return { allow: true, reason: "headless --yes" };
      if (tui && tui.isTty) return tui.requestApproval(toolName);
      if (args.interactive) return interaction.requestPermission(toolName);
      return { allow: false, reason: "headless 默认拒绝；传 --tui/--interactive 人工审批或 --yes 自动批准" };
    },
    signal,
  };
}

async function runExtensionManagement(args: HeadlessArgs, io: HeadlessIO): Promise<number> {
  const host = new FileExtensionHost({
    roots: args.extensionDirs,
    stateDir: path.join(args.sessionDir, "extensions"),
    runtime: { onAudit: (event) => { if (args.verbose) io.stderr(`[hmr:${event.kind}] ${event.extensionId ?? event.leaseId ?? "runtime"}\n`); } },
    ...(args.extensionSandboxPolicyFile ? { sandboxPolicy: loadExtensionSandboxPolicyFile(args.extensionSandboxPolicyFile) } : {}),
  });
  try {
    await host.start();
    const manager = host.management;
    let result: unknown;
    switch (args.extensionManage) {
      case "list": result = manager.snapshot(); break;
      case "status": result = manager.status(args.extensionId!); break;
      case "reload": result = await manager.reload(args.extensionId!); break;
      case "remove": result = await manager.remove(args.extensionId!); break;
      case "reconcile": result = await manager.reconcile(); break;
      case "audit": result = { events: manager.audit({ ...(args.extensionId ? { extensionId: args.extensionId } : {}), limit: 200 }) }; break;
      case "enable": result = await manager.configure(args.extensionId!, { enabled: true }); break;
      case "disable": result = await manager.configure(args.extensionId!, { enabled: false }); break;
      default: throw new Error("缺少 extension management operation");
    }
    io.stdout(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error: any) {
    io.stderr(`FreeSeek Extension Management failed: ${error?.message ?? String(error)}\n`);
    return 2;
  } finally {
    await host.dispose();
  }
}

/** CLI 主入口；导出便于 smoke/unit test。 */
export async function runHeadless(argv = process.argv.slice(2), io: HeadlessIO = PROCESS_IO): Promise<number> {
  let args: HeadlessArgs;
  try { args = parseArgs(argv); } catch (e: any) { io.stderr(`${e?.message ?? e}\n\n${usage()}\n`); return 2; }
  fs.mkdirSync(args.sessionDir, { recursive: true });
  if (args.extensionManage) return runExtensionManagement(args, io);
  if (!fs.existsSync(args.workspace) || !fs.statSync(args.workspace).isDirectory()) {
    io.stderr(`workspace 不存在：${args.workspace}\n`); return 2;
  }
  if (args.interactive && !io.prompt) {
    io.stderr("--interactive 需要可交互的终端 prompt host\n");
    return 2;
  }
  configureHeadlessProvider(args);
  let services: CliRuntimeServices;
  try {
    services = await createCliRuntimeServices({
      workspace: args.workspace,
      ...(args.mcpConfig ? { mcpConfig: args.mcpConfig } : {}),
      skillDirs: args.skillsDir,
    });
  } catch (error: any) {
    io.stderr(`FreeSeek CLI service setup failed: ${error?.message ?? String(error)}\n`);
    return 2;
  }
  let extensionHost: FileExtensionHost | undefined;
  try {
    if (args.extensionDirs.length) {
      extensionHost = new FileExtensionHost({
        roots: args.extensionDirs,
        stateDir: path.join(args.sessionDir, "extensions"),
        runtime: { onAudit: (event) => io.stderr(`[hmr:${event.kind}] ${event.extensionId ?? event.leaseId ?? "runtime"}\n`) },
        watcher: { onEvent: (event) => io.stderr(`[hmr:${event.kind}] ${event.extensionId ?? event.packageDir ?? "watcher"}${event.error ? `: ${event.error}` : ""}\n`) },
        ...(args.extensionSandboxPolicyFile ? { sandboxPolicy: loadExtensionSandboxPolicyFile(args.extensionSandboxPolicyFile) } : {}),
      });
      await extensionHost.start();
    }
  } catch (error: any) {
    io.stderr(`FreeSeek HMR setup failed: ${error?.message ?? String(error)}\n`);
    services.dispose();
    return 2;
  }
  const hostCapabilities = createCliHostCapabilities({
    interactive: args.interactive,
    mcp: services.mcpEnabled,
    skills: true,
    multiAgent: args.enableMultiAgent,
  });
  const interaction = createCliInteractionService(hostCapabilities, {
    prompt: async (text) => io.prompt ? io.prompt(text) : Promise.reject(new Error("CLI prompt host unavailable")),
  });
  configureDebugHost({ verbose: args.verbose, channel: { appendLine: (line) => io.stderr(`[debug] ${line}\n`) } });
  // 缺口3：解析 --sandbox 并注入远程/云沙箱 transport；off/readonly/sandbox 由 toolContext 处理。
  configureSandboxRunner(args.sandbox, io, args.workspace);
  const abort = new AbortController();
  const onSigint = () => abort.abort(new Error("SIGINT"));
  process.once("SIGINT", onSigint);
  // 缺口1：TUI 模式创建全交互会话视图（非 TTY 自动降级为朴素流式）。
  const tui = args.tui ? createTuiSession(io) : undefined;
  tui?.start();
  try {
    const messages = initialConversation(args, io);
    const user: ChatMessage = { role: "user", content: args.prompt.trim() };
    messages.push(user);
    const log = ensureEventLog(args.sessionDir, args.sessionId);
    log.append("user/message", { ...log.persistMessage(user) }, "main");
    await runAgent(
      messages,
      services.toolDefinitions,
      toolContext(args, abort.signal, interaction, services, hostCapabilities.multiAgent, extensionHost?.runtime),
      callbacks(args, abort.signal, io, interaction, tui)
    );
    io.stdout("\n");
    endSessionEventLog(args.sessionId, "headless-complete");
    return 0;
  } catch (e: any) {
    io.stderr(`\nFreeSeek Headless 失败：${e?.message ?? String(e)}\n`);
    endSessionEventLog(args.sessionId, abort.signal.aborted ? "headless-aborted" : "headless-error");
    return abort.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    tui?.stop();
    await extensionHost?.dispose();
    services.dispose();
  }
}

if (typeof __FREESEEK_CLI_ENTRY__ !== "undefined" && __FREESEEK_CLI_ENTRY__ === "headless") {
  void runHeadless().then((code) => { process.exitCode = code; });
}
