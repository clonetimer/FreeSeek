#!/usr/bin/env node
/**
 * FreeSeek ACP v1 stdio Agent Server.
 *
 * Stdout is reserved exclusively for newline-delimited JSON-RPC. Diagnostics,
 * provider traces and MCP logs are emitted to stderr.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
declare const __FREESEEK_CLI_ENTRY__: string | undefined;
import { configureDebugHost } from "./debug";
import { AcpAgentServer } from "./hosts/acp/server";
import { NdJsonRpcPeer } from "./hosts/acp/protocol";
import { configureStandaloneProvider } from "./hosts/standalone-provider";
import type { AuthType, ProviderFormat } from "./providers";
import { loadExtensionSandboxPolicyFile } from "./kernel/extensions/sandbox-policy";

export interface AcpCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const PROCESS_IO: AcpCliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

interface AcpCliArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ProviderFormat;
  toolMode: "native" | "react";
  authType: AuthType;
  sessionDir: string;
  yes: boolean;
  enableMultiAgent: boolean;
  enableSkills: boolean;
  skillsDir: string[];
  extensionDirs: string[];
  extensionSandboxPolicyFile?: string;
  allowShell: boolean;
  allowNetwork: boolean;
  contextPlanner: "off" | "v1" | "v1.1" | "v1.2";
  contextPlanBudget: number;
  verbose: boolean;
}

function usage(): string {
  return [
    "FreeSeek ACP v1 stdio Agent Server",
    "",
    "用法：",
    "  freeseek acp --base-url <url> --model <id> [options]",
    "  freeseek-acp --base-url <url> --model <id> [options]",
    "",
    "Provider：",
    "  --base-url <url>        Provider API 根（也可 FREESEEK_BASE_URL）",
    "  --model <id>            模型 id（也可 FREESEEK_MODEL）",
    "  --api-key <key>         API Key（也可 FREESEEK_API_KEY）",
    "  --format <f>            openai|claude|gemini（默认 openai）",
    "  --tool-mode <m>         native|react（默认 native）",
    "  --auth-type <a>         none|bearer|x-api-key|x-goog-api-key",
    "",
    "Host：",
    "  --session-dir <dir>     durable ACP session 目录，默认 ~/.freesek/acp",
    "  --yes                   自动批准工具权限；默认由 ACP Client 请求用户批准",
    "  --enable-multi-agent    开放 spawn_agent/spawn_agents/send_message（默认关闭）",
    "  --no-skills             禁用 load_skill/项目技能（默认开启）",
    "  --skills-dir <dir>      追加技能目录（可重复）",
    "  --extension-dir <dir>   显式信任并热加载 General HMR extension 目录（可重复）",
    "  --extension-sandbox-policy <file>  H4 untrusted capability grants（启动时只读 JSON）",
    "  --allow-shell           开启 shell / code execution",
    "  --no-network            禁止网络工具",
    "  --context-planner <m>   off|v1|v1.1|v1.2（默认 off）",
    "  --context-plan-budget <n> Planner token 预算，默认 3500",
    "  --verbose               将 Provider/ACP 诊断写到 stderr",
    "",
    "协议 stdout 只输出 ACP NDJSON JSON-RPC；所有诊断固定写 stderr。",
  ].join("\n");
}

function nextValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return value;
}

function parseArgs(argv: string[]): AcpCliArgs | { help: true } {
  const opts: Partial<AcpCliArgs> = {
    baseUrl: process.env.FREESEEK_BASE_URL ?? "",
    apiKey: process.env.FREESEEK_API_KEY ?? "",
    model: process.env.FREESEEK_MODEL ?? "",
    format: (["openai", "claude", "gemini"] as const).includes(process.env.FREESEEK_FORMAT as any)
      ? process.env.FREESEEK_FORMAT as ProviderFormat : "openai",
    toolMode: (["native", "react"] as const).includes(process.env.FREESEEK_TOOL_MODE as any)
      ? process.env.FREESEEK_TOOL_MODE as "native" | "react" : "native",
    authType: (["none", "bearer", "x-api-key", "x-goog-api-key"] as const).includes(process.env.FREESEEK_AUTH_TYPE as any)
      ? process.env.FREESEEK_AUTH_TYPE as AuthType : "bearer",
    sessionDir: path.join(os.homedir(), ".freesek", "acp"),
    yes: false,
    enableMultiAgent: false,
    enableSkills: true,
    skillsDir: [],
    extensionDirs: [],
    allowShell: false,
    allowNetwork: true,
    contextPlanner: (["v1", "v1.1", "v1.2"] as const).includes(process.env.FREESEEK_CONTEXT_PLANNER as any)
      ? process.env.FREESEEK_CONTEXT_PLANNER as "v1" | "v1.1" | "v1.2" : "off",
    contextPlanBudget: 3500,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--yes") { opts.yes = true; continue; }
    if (arg === "--enable-multi-agent") { opts.enableMultiAgent = true; continue; }
    if (arg === "--no-skills") { opts.enableSkills = false; continue; }
    if (arg === "--allow-shell") { opts.allowShell = true; continue; }
    if (arg === "--no-network") { opts.allowNetwork = false; continue; }
    if (arg === "--verbose") { opts.verbose = true; continue; }
    if (arg === "--skills-dir" || arg === "--extension-dir") {
      const directory = path.resolve(nextValue(argv, i, arg)); i++;
      if (arg === "--skills-dir") (opts.skillsDir ??= []).push(directory);
      else (opts.extensionDirs ??= []).push(directory);
      continue;
    }
    if (["--base-url", "--api-key", "--model", "--format", "--tool-mode", "--auth-type", "--session-dir", "--context-planner", "--context-plan-budget", "--extension-sandbox-policy"].includes(arg)) {
      const value = nextValue(argv, i, arg); i++;
      if (arg === "--context-plan-budget") opts.contextPlanBudget = Number(value);
      else if (arg === "--session-dir") opts.sessionDir = path.resolve(value);
      else if (arg === "--extension-sandbox-policy") opts.extensionSandboxPolicyFile = path.resolve(value);
      else if (arg === "--context-planner") opts.contextPlanner = value as AcpCliArgs["contextPlanner"];
      else (opts as Record<string, unknown>)[arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }

  if (!opts.baseUrl?.trim()) throw new Error("缺少 --base-url / FREESEEK_BASE_URL");
  if (!opts.model?.trim()) throw new Error("缺少 --model / FREESEEK_MODEL");
  if (!["openai", "claude", "gemini"].includes(String(opts.format))) throw new Error("--format 必须是 openai|claude|gemini");
  if (!["native", "react"].includes(String(opts.toolMode))) throw new Error("--tool-mode 必须是 native|react");
  if (!["none", "bearer", "x-api-key", "x-goog-api-key"].includes(String(opts.authType))) throw new Error("--auth-type 必须是 none|bearer|x-api-key|x-goog-api-key");
  if (!["off", "v1", "v1.1", "v1.2"].includes(String(opts.contextPlanner))) throw new Error("--context-planner 必须是 off|v1|v1.1|v1.2");
  if (!Number.isFinite(opts.contextPlanBudget) || Number(opts.contextPlanBudget) < 256 || Number(opts.contextPlanBudget) > 12000) {
    throw new Error("--context-plan-budget 必须在 256..12000");
  }
  opts.sessionDir = path.resolve(String(opts.sessionDir));
  opts.skillsDir = (opts.skillsDir ?? []).map((dir) => path.resolve(String(dir)));
  opts.extensionDirs = (opts.extensionDirs ?? []).map((dir) => path.resolve(String(dir)));
  return opts as AcpCliArgs;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/** Start the stable-v1 ACP stdio host. The promise resolves when the transport closes. */
/** 启动 ACP Server 的 CLI 入口（供 SDK 的 freeseek-sdk acp 子命令复用）。 */
export async function startAcpServerCli(argv: string[] = process.argv.slice(2), io: AcpCliIO = PROCESS_IO): Promise<number> {
  return runAcpCli(argv, io);
}

export async function runAcpCli(argv = process.argv.slice(2), io: AcpCliIO = PROCESS_IO): Promise<number> {
  let args: AcpCliArgs | { help: true };
  try { args = parseArgs(argv); }
  catch (error: any) { io.stderr(`${error?.message ?? error}\n\n${usage()}\n`); return 2; }
  if ("help" in args) { io.stdout(usage() + "\n"); return 0; }

  configureStandaloneProvider({
    id: "acp",
    name: `ACP ${args.format}`,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    format: args.format,
    toolMode: args.toolMode,
    authType: args.authType,
  });
  configureDebugHost({
    verbose: args.verbose,
    channel: { appendLine: (line) => io.stderr(`[debug] ${line}\n`) },
  });

  const log = (message: string) => io.stderr(`[acp] ${message}\n`);
  const peer = new NdJsonRpcPeer(process.stdin, process.stdout, (message) => log(message));
  const server = new AcpAgentServer(peer, {
    sessionDir: args.sessionDir,
    agentVersion: packageVersion(),
    allowShell: args.allowShell,
    allowNetwork: args.allowNetwork,
    autoApprove: args.yes,
    enableMultiAgent: args.enableMultiAgent,
    enableSkills: args.enableSkills,
    skillDirs: args.skillsDir,
    extensionDirs: args.extensionDirs,
    ...(args.extensionSandboxPolicyFile ? { extensionSandboxPolicy: loadExtensionSandboxPolicyFile(args.extensionSandboxPolicyFile) } : {}),
    contextPlanner: args.contextPlanner,
    contextPlannerBudget: args.contextPlanBudget,
    verbose: args.verbose,
    log,
  });

  const shutdown = () => { void server.close("signal"); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    server.start();
    await peer.waitForClose();
    await server.close("transport-closed");
    return 0;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

if (typeof __FREESEEK_CLI_ENTRY__ !== "undefined" && __FREESEEK_CLI_ENTRY__ === "acp") {
  void runAcpCli().then((code) => { process.exitCode = code; });
}
