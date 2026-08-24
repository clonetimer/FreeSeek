#!/usr/bin/env node
/**
 * FreeSeek Web Console 入口：本地回环 HTTP 服务 + 浏览器端。
 * 架构上只是 ACP 控制面的浏览器前端宿主（与 Desktop 同构），不复制 Kernel。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthType, ProviderFormat } from "./providers";
import { WebConsoleServer } from "./hosts/web/console";

declare const __FREESEEK_CLI_ENTRY__: string | undefined;

/** Web Console CLI 参数。 */
export interface WebCliArgs {
  host: string;
  port: number;
  workspace: string;
  sessionDir?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ProviderFormat;
  toolMode: "native" | "react";
  authType: AuthType;
  autoApprove: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
  enableMultiAgent: boolean;
  enableSkills: boolean;
  skillDirs: string[];
  extensionDirs: string[];
  extensionSandboxPolicyFile?: string;
  contextPlanner: "off" | "v1" | "v1.1" | "v1.2";
  contextPlanBudget: number;
  agentEntry?: string;
}

interface WebCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const PROCESS_IO: WebCliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function usage(): string {
  return [
    "FreeSeek Web Console（本地回环 HTTP 服务 + 浏览器端）",
    "",
    "用法：",
    "  freeseek web --base-url <url> --model <id> [options]",
    "",
    "服务：",
    "  --port <n>              监听端口（默认 3080）",
    "  --host <h>              监听地址（默认 127.0.0.1，仅本机回环）",
    "  --workspace <dir>       Agent 工作区（默认当前目录）",
    "  --session-dir <dir>     durable session 目录（默认 ~/.freesek/web）",
    "",
    "Provider（也支持 FREESEEK_BASE_URL / FREESEEK_API_KEY / FREESEEK_MODEL）：",
    "  --base-url <url>        Provider API 根",
    "  --model <id>            模型 id",
    "  --api-key <key>         API Key",
    "  --format <f>            openai|claude|gemini（默认 openai）",
    "  --tool-mode <m>         native|react（默认 native）",
    "  --auth-type <a>         none|bearer|x-api-key|x-goog-api-key",
    "",
    "能力与审批：",
    "  --yes                   自动批准工具权限（默认：权限请求按取消处理）",
    "  --allow-shell           开启 shell / code execution",
    "  --no-network            禁止网络工具",
    "  --enable-multi-agent    开放子代理工具",
    "  --no-skills             禁用技能",
    "  --skills-dir <dir>      追加技能目录（可重复）",
    "  --extension-dir <dir>   显式信任 General HMR extension 目录（可重复）",
    "  --extension-sandbox-policy <file>  H4 capability grants 启动时只读 JSON",
    "  --context-planner <m>   off|v1|v1.1|v1.2（默认 off）",
    "  --context-plan-budget <n> Planner token 预算（默认 3500）",
    "  --agent-entry <file>    显式指定 freeseek-acp 入口（默认自动探测）",
  ].join("\n");
}

function nextValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return value;
}

function parseArgs(argv: string[]): WebCliArgs | { help: true } {
  const opts: WebCliArgs = {
    host: "127.0.0.1",
    port: 3080,
    workspace: process.cwd(),
    baseUrl: process.env.FREESEEK_BASE_URL ?? "",
    apiKey: process.env.FREESEEK_API_KEY ?? "",
    model: process.env.FREESEEK_MODEL ?? "",
    format: "openai",
    toolMode: "native",
    authType: "bearer",
    autoApprove: false,
    allowShell: false,
    allowNetwork: true,
    enableMultiAgent: false,
    enableSkills: true,
    skillDirs: [],
    extensionDirs: [],
    contextPlanner: "off",
    contextPlanBudget: 3500,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--yes") { opts.autoApprove = true; continue; }
    if (arg === "--allow-shell") { opts.allowShell = true; continue; }
    if (arg === "--no-network") { opts.allowNetwork = false; continue; }
    if (arg === "--enable-multi-agent") { opts.enableMultiAgent = true; continue; }
    if (arg === "--no-skills") { opts.enableSkills = false; continue; }
    if (arg === "--skills-dir" || arg === "--extension-dir") {
      const directory = path.resolve(nextValue(argv, i, arg)); i++;
      if (arg === "--skills-dir") opts.skillDirs.push(directory);
      else opts.extensionDirs.push(directory);
      continue;
    }
    const valued = ["--host", "--port", "--workspace", "--session-dir", "--base-url", "--api-key",
      "--model", "--format", "--tool-mode", "--auth-type", "--extension-sandbox-policy",
      "--context-planner", "--context-plan-budget", "--agent-entry"];
    if (valued.includes(arg)) {
      const value = nextValue(argv, i, arg); i++;
      if (arg === "--host") opts.host = value;
      else if (arg === "--port") opts.port = Number(value);
      else if (arg === "--workspace") opts.workspace = path.resolve(value);
      else if (arg === "--session-dir") opts.sessionDir = path.resolve(value);
      else if (arg === "--base-url") opts.baseUrl = value;
      else if (arg === "--api-key") opts.apiKey = value;
      else if (arg === "--model") opts.model = value;
      else if (arg === "--format") opts.format = value as ProviderFormat;
      else if (arg === "--tool-mode") opts.toolMode = value as "native" | "react";
      else if (arg === "--auth-type") opts.authType = value as AuthType;
      else if (arg === "--extension-sandbox-policy") opts.extensionSandboxPolicyFile = path.resolve(value);
      else if (arg === "--context-planner") opts.contextPlanner = value as WebCliArgs["contextPlanner"];
      else if (arg === "--context-plan-budget") opts.contextPlanBudget = Number(value);
      else if (arg === "--agent-entry") opts.agentEntry = path.resolve(value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!opts.baseUrl.trim()) throw new Error("缺少 --base-url / FREESEEK_BASE_URL");
  if (!opts.model.trim()) throw new Error("缺少 --model / FREESEEK_MODEL");
  if (!Number.isFinite(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error("--port 必须为 1..65535");
  if (!["openai", "claude", "gemini"].includes(opts.format)) throw new Error("--format 必须是 openai|claude|gemini");
  if (!["native", "react"].includes(opts.toolMode)) throw new Error("--tool-mode 必须是 native|react");
  if (!["none", "bearer", "x-api-key", "x-goog-api-key"].includes(opts.authType)) {
    throw new Error("--auth-type 必须是 none|bearer|x-api-key|x-goog-api-key");
  }
  if (!opts.apiKey && opts.authType === "bearer") opts.authType = "none";
  return opts;
}

/** 探测 freeseek-acp sidecar 入口（优先无自动运行 define 的模块产物）。 */
export function resolveAgentEntry(explicit?: string): string {
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`--agent-entry 不存在：${explicit}`);
  }
  const candidates = [
    path.join(__dirname, "..", "dist", "freeseek-acp-sidecar.js"),
    path.join(__dirname, "..", "src", "acp-server.js"),
    path.join(process.cwd(), "src", "acp-server.js"),
    path.join(process.cwd(), "tests", "src", "acp-server.js"),
    path.join(process.cwd(), "tests", ".build", "src", "acp-server.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 freeseek-acp 入口；请先 npm run compile 或显式 --agent-entry（尝试过: ${candidates.join(", ")}）`);
}

/** Start the Web Console host; resolves when the HTTP server closes. */
export async function runWebConsole(argv = process.argv.slice(2), io: WebCliIO = PROCESS_IO): Promise<number> {
  let args: WebCliArgs | { help: true };
  try { args = parseArgs(argv); }
  catch (error: any) { io.stderr(`${error?.message ?? error}\n\n${usage()}\n`); return 2; }
  if ("help" in args) { io.stdout(usage() + "\n"); return 0; }

  const sessionDir = args.sessionDir ?? path.join(os.homedir(), ".freesek", "web");
  const server = new WebConsoleServer({
    host: args.host,
    port: args.port,
    workspace: args.workspace,
    sessionDir,
    autoApprove: args.autoApprove,
    launch: {
      agentEntry: resolveAgentEntry(args.agentEntry),
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      format: args.format,
      toolMode: args.toolMode,
      authType: args.authType,
      sessionDir,
      allowShell: args.allowShell,
      allowNetwork: args.allowNetwork,
      enableMultiAgent: args.enableMultiAgent,
      enableSkills: args.enableSkills,
      skillDirs: args.skillDirs,
      extensionDirs: args.extensionDirs,
      extensionSandboxPolicyFile: args.extensionSandboxPolicyFile,
      contextPlanner: args.contextPlanner,
      contextPlanBudget: args.contextPlanBudget,
    },
  });

  const shutdown = () => { void server.stop(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const { url } = await server.start();
    io.stdout(`FreeSeek Web Console 已启动：${url}\n`);
    io.stdout("（令牌即完整控制权，请勿泄露；仅监听本机回环地址）\n");
    await server.waitForClose();
    return 0;
  } catch (error: any) {
    io.stderr(`Web Console 启动失败：${error?.message ?? error}\n`);
    return 1;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await server.stop();
  }
}

if (typeof __FREESEEK_CLI_ENTRY__ !== "undefined" && __FREESEEK_CLI_ENTRY__ === "web") {
  void runWebConsole().then((code) => { process.exitCode = code; });
}
