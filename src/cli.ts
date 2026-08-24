#!/usr/bin/env node
/**
 * FreeSeek unified CLI surface.
 *
 * This is a thin host/router only: coding runs still execute through the same
 * runAgent -> ToolRegistry -> ToolRuntime -> EventLog kernel used by VS Code.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
declare const __FREESEEK_CLI_ENTRY__: string | undefined;
import { runHeadless } from "./headless";
import { runEvalCli } from "./eval-cli";
import { runBenchCli } from "./bench-cli";
import { runAcpCli } from "./acp-server";
import { runWebConsole } from "./web-cli";
import { runPluginCli } from "./plugin-cli";
import { ensureSessionEventIndex } from "./event-index";
import { querySessionEvents } from "./eventlog";
import { assertSafeSessionId } from "./session-id";

interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const PROCESS_IO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

interface SessionSummary {
  id: string;
  events: number;
  lastSeq: number;
  lastTs: string;
  lastType: string;
  ended: boolean;
}

function usage(): string {
  return [
    "FreeSeek CLI",
    "",
    "用法：",
    "  freeseek run [headless options]   运行 Coding Agent（默认命令）",
    "  freeseek eval [eval options]      运行 Eval Harness",
    "  freeseek bench [bench command]    运行 Bench / Context A/B",
    "  freeseek acp [acp options]        启动 ACP v1 stdio Agent Server",
    "  freeseek web [web options]        启动本地 Web Console（浏览器端）",
    "  freeseek plugin <add|remove|list> 管理插件（npm / git / 本地目录，对标 dsh plugin）",
    "  freeseek doctor [options]         检查本机运行环境（不输出密钥）",
    "  freeseek sessions [options]       列出 durable Headless sessions",
    "  freeseek replay <id> [options]    查看 session EventLog",
    "  freeseek version                  输出版本",
    "  freeseek help                     显示本帮助",
    "",
    "兼容：直接以 --prompt 开头的旧 freeseek 调用仍等价于 `freeseek run ...`。",
    "运行 `freeseek run --help` / `freeseek acp --help` / `freeseek eval --help` / `freeseek bench --help` 查看子命令参数。",
  ].join("\n");
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function value(argv: string[], i: number, name: string): string {
  const next = argv[i + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return next;
}

function defaultSessionDir(): string {
  return path.join(os.homedir(), ".freesek", "headless");
}

function parseCommonLocalOptions(argv: string[]): { sessionDir: string; json: boolean; rest: string[] } {
  let sessionDir = defaultSessionDir();
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--session-dir") { sessionDir = path.resolve(value(argv, i, arg)); i++; continue; }
    rest.push(arg);
  }
  return { sessionDir, json, rest };
}

function discoverSessions(dir: string): SessionSummary[] {
  if (!fs.existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const file of fs.readdirSync(dir)) {
    const match = /^events-(.+)\.jsonl$/.exec(file);
    if (!match) continue;
    const id = match[1];
    try { assertSafeSessionId(id); } catch { continue; }
    try {
      const index = ensureSessionEventIndex(dir, id).filter((row) => row.valid);
      const last = index[index.length - 1];
      if (!last?.seq) continue;
      out.push({
        id,
        events: index.length,
        lastSeq: last.seq,
        lastTs: last.ts ?? "",
        lastType: last.type ?? "",
        ended: last.type === "session_end",
      });
    } catch {
      // A single damaged session should not hide healthy sessions.
    }
  }
  return out.sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || "") || b.lastSeq - a.lastSeq);
}

function runSessions(argv: string[], io: CliIO): number {
  let parsed: ReturnType<typeof parseCommonLocalOptions>;
  try { parsed = parseCommonLocalOptions(argv); } catch (error: any) { io.stderr(`${error?.message ?? error}\n`); return 2; }
  if (parsed.rest.length) { io.stderr(`sessions 未知参数：${parsed.rest[0]}\n`); return 2; }
  const rows = discoverSessions(parsed.sessionDir);
  if (parsed.json) {
    io.stdout(JSON.stringify({ sessionDir: parsed.sessionDir, count: rows.length, sessions: rows }, null, 2) + "\n");
    return 0;
  }
  if (!rows.length) { io.stdout(`没有 durable sessions：${parsed.sessionDir}\n`); return 0; }
  io.stdout(`SESSION\tEVENTS\tSTATE\tLAST EVENT\tLAST TYPE\n`);
  for (const row of rows) {
    io.stdout(`${row.id}\t${row.events}\t${row.ended ? "ended" : "open"}\t${row.lastTs}\t${row.lastType}\n`);
  }
  return 0;
}

function replaySummary(event: ReturnType<typeof querySessionEvents>[number]): string {
  const data = event.data as any;
  if (event.type === "user/message") return String(data?.message?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
  if (event.type === "assistant/message") return String(data?.message?.content ?? data?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
  if (event.type === "tool/call") return String(data?.name ?? data?.tool ?? "").slice(0, 120);
  if (event.type === "tool/result") return String(data?.name ?? data?.tool ?? "").slice(0, 120);
  if (event.type === "session_end") return String(data?.reason ?? "").slice(0, 120);
  return "";
}

function runReplay(argv: string[], io: CliIO): number {
  let parsed: ReturnType<typeof parseCommonLocalOptions>;
  try { parsed = parseCommonLocalOptions(argv); } catch (error: any) { io.stderr(`${error?.message ?? error}\n`); return 2; }
  const id = parsed.rest[0];
  if (!id) { io.stderr("replay 缺少 session id\n"); return 2; }
  try { assertSafeSessionId(id); } catch (error: any) { io.stderr(`${error?.message ?? error}\n`); return 2; }
  let limit = 50;
  let type: string | undefined;
  for (let i = 1; i < parsed.rest.length; i++) {
    const arg = parsed.rest[i];
    if (arg === "--limit") { limit = Number(value(parsed.rest, i, arg)); i++; continue; }
    if (arg === "--type") { type = value(parsed.rest, i, arg); i++; continue; }
    io.stderr(`replay 未知参数：${arg}\n`); return 2;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) { io.stderr("--limit 必须在 1..5000\n"); return 2; }
  try {
    const newest = querySessionEvents(parsed.sessionDir, id, { reverse: true, limit, ...(type ? { types: [type] } : {}) });
    const events = newest.reverse();
    if (parsed.json) {
      io.stdout(JSON.stringify({ sessionDir: parsed.sessionDir, sessionId: id, count: events.length, events }, null, 2) + "\n");
      return 0;
    }
    if (!events.length) { io.stdout(`session 无事件或不存在：${id}\n`); return 1; }
    for (const event of events) {
      const extra = replaySummary(event);
      io.stdout(`#${event.seq}\t${event.ts}\t${event.actor ?? "main"}\t${event.type}${extra ? `\t${extra}` : ""}\n`);
    }
    return 0;
  } catch (error: any) {
    io.stderr(`replay 失败：${error?.message ?? error}\n`);
    return 1;
  }
}

function doctorRows(workspace: string): Array<{ check: string; ok: boolean; detail: string }> {
  const rows: Array<{ check: string; ok: boolean; detail: string }> = [];
  const major = Number(process.versions.node.split(".")[0] || 0);
  rows.push({ check: "node", ok: major >= 18, detail: process.version });
  let workspaceOk = false;
  try {
    workspaceOk = fs.statSync(workspace).isDirectory();
    if (workspaceOk) fs.accessSync(workspace, fs.constants.R_OK | fs.constants.W_OK);
  } catch { workspaceOk = false; }
  rows.push({ check: "workspace", ok: workspaceOk, detail: workspace });
  const git = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
  rows.push({ check: "git", ok: git.status === 0, detail: (git.stdout || git.stderr || "not found").trim().slice(0, 160) });
  const baseUrl = process.env.FREESEEK_BASE_URL ?? "";
  const model = process.env.FREESEEK_MODEL ?? "";
  const hasKey = Boolean(process.env.FREESEEK_API_KEY);
  rows.push({ check: "provider-base-url", ok: Boolean(baseUrl), detail: baseUrl || "FREESEEK_BASE_URL 未设置" });
  rows.push({ check: "provider-model", ok: Boolean(model), detail: model || "FREESEEK_MODEL 未设置" });
  rows.push({ check: "provider-api-key", ok: true, detail: hasKey ? "已通过 FREESEEK_API_KEY 设置（值未显示）" : "未设置（无认证本地 Provider 请在 run 时使用 --auth-type none）" });
  return rows;
}

function runDoctor(argv: string[], io: CliIO): number {
  let workspace = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { json = true; continue; }
    if (arg === "--workspace") { workspace = path.resolve(value(argv, i, arg)); i++; continue; }
    io.stderr(`doctor 未知参数：${arg}\n`); return 2;
  }
  const rows = doctorRows(workspace);
  const requiredOk = rows.filter((row) => ["node", "workspace", "git"].includes(row.check)).every((row) => row.ok);
  const providerReady = rows.filter((row) => row.check === "provider-base-url" || row.check === "provider-model").every((row) => row.ok);
  if (json) {
    io.stdout(JSON.stringify({ version: packageVersion(), requiredOk, providerReady, checks: rows }, null, 2) + "\n");
  } else {
    io.stdout(`FreeSeek ${packageVersion()} doctor\n`);
    for (const row of rows) io.stdout(`${row.ok ? "✓" : "!"} ${row.check}: ${row.detail}\n`);
    if (!providerReady) io.stdout("提示：本地检查已完成；运行 Agent 前请设置 provider 环境变量或在 run 命令中传入对应参数。\n");
  }
  return requiredOk ? 0 : 1;
}

/** Unified FreeSeek CLI main entry; exported for tests and embedding. */
export async function runFreeSeekCli(argv = process.argv.slice(2), io: CliIO = PROCESS_IO): Promise<number> {
  const first = argv[0];
  if (!first || first === "help" || first === "--help" || first === "-h") { io.stdout(usage() + "\n"); return 0; }
  if (first === "version" || first === "--version" || first === "-V") { io.stdout(packageVersion() + "\n"); return 0; }
  if (first === "doctor") return runDoctor(argv.slice(1), io);
  if (first === "sessions") return runSessions(argv.slice(1), io);
  if (first === "replay") return runReplay(argv.slice(1), io);
  if (first === "eval") return runEvalCli(argv.slice(1));
  if (first === "bench") return runBenchCli(argv.slice(1));
  if (first === "acp") return runAcpCli(argv.slice(1), io);
  if (first === "web") return runWebConsole(argv.slice(1), io);
  if (first === "plugin") return runPluginCli(argv.slice(1), io);
  if (first === "run") return runHeadless(argv.slice(1), io);
  // Backward compatibility: 0.17.x `freeseek --prompt ...` directly entered Headless.
  if (first.startsWith("--")) return runHeadless(argv, io);
  io.stderr(`未知命令：${first}\n\n${usage()}\n`);
  return 2;
}

if (typeof __FREESEEK_CLI_ENTRY__ !== "undefined" && __FREESEEK_CLI_ENTRY__ === "cli") {
  void runFreeSeekCli().then((code) => { process.exitCode = code; });
}
