/**
 * Deterministic eval harness for FreeSeek Headless.
 *
 * A case runs against a copied workspace, records the normal durable EventLog, projects an
 * indexed trace summary, then executes declarative post-conditions. Command checks are argv-only
 * and require an explicit allowCommandChecks opt-in.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { runHeadless, type HeadlessIO } from "./headless";
import { assertSafeSessionId } from "./session-id";
import { loadSessionTrace, diffSessionTrace, type SessionTraceSummary, type TraceDelta } from "./trace";
import { querySessionEvents } from "./eventlog";
import { resolveSafe } from "./path-safety";

export type EvalCheck =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_not_contains"; path: string; text: string }
  | { type: "tool_called"; name: string; min?: number; max?: number }
  | { type: "event_count"; eventType: string; min?: number; max?: number; actor?: string }
  | { type: "turn_reason"; reason: "completed" | "budget" | "aborted" | "error" }
  | { type: "command"; argv: string[]; cwd?: string; timeoutMs?: number; exitCode?: number; stdoutIncludes?: string }
  | { type: "host_node"; script: string; args?: string[]; timeoutMs?: number; exitCode?: number; stdoutIncludes?: string };

export interface EvalCaseDefinition {
  id: string;
  workspace: string;
  prompt: string;
  checks?: EvalCheck[];
  allowShell?: boolean;
  allowNetwork?: boolean;
}

export interface EvalManifest {
  name: string;
  cases: EvalCaseDefinition[];
}

export interface EvalRunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  outDir: string;
  allowCommandChecks?: boolean;
  keepWorkspaces?: boolean;
  contextPlanner?: "off" | "v1" | "v1.1" | "v1.2";
  contextPlanBudget?: number;
  io?: HeadlessIO;
}

export interface EvalCheckResult {
  check: EvalCheck;
  pass: boolean;
  detail: string;
}

export interface EvalCaseResult {
  id: string;
  pass: boolean;
  exitCode: number;
  workspace: string;
  sessionDir: string;
  sessionId: string;
  stdout: string;
  stderr: string;
  checks: EvalCheckResult[];
  trace: SessionTraceSummary;
}

export interface EvalReportSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  steps: number;
  blockedToolCalls: number;
  timedOutToolCalls: number;
  approvalsRequested: number;
  contextPlans: number;
  contextPlanErrors: number;
  contextFilesSelected: number;
  contextPlanTokens: number;
  contextPlanDurationMs: number;
  contextExploratorySearchCalls: number;
  contextPlannedReadCalls: number;
  contextUnplannedReadCalls: number;
  contextPlannedMutationCalls: number;
  contextUnplannedMutationCalls: number;
  contextTopCandidateTouches: number;
}

export interface EvalReport {
  version: 1;
  runId: string;
  suite: string;
  createdAt: string;
  provider: { baseUrl: string; model: string };
  agent: { contextPlanner: "off" | "v1" | "v1.1" | "v1.2"; contextPlanBudget: number };
  cases: EvalCaseResult[];
  summary: EvalReportSummary;
}

export interface EvalReportComparison {
  baselineRunId: string;
  candidateRunId: string;
  passRateDelta: number;
  passedDelta: number;
  metrics: TraceDelta;
}

function safeCaseId(id: string): string {
  return assertSafeSessionId(id);
}

function copyWorkspace(source: string, target: string): void {
  const sourceReal = fs.realpathSync(source);
  if (!fs.statSync(sourceReal).isDirectory()) throw new Error(`eval workspace 不是目录：${source}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(sourceReal, target, { recursive: true, dereference: false, errorOnExist: false });
}

function bounded(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function evalCommandEnv(): NodeJS.ProcessEnv {
  const keys = ["PATH", "PATHEXT", "SystemRoot", "ComSpec", "WINDIR", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

async function runCheckCommand(
  workspace: string,
  check: Extract<EvalCheck, { type: "command" }>,
  allow: boolean
): Promise<EvalCheckResult> {
  if (!allow) return { check, pass: false, detail: "command check 被禁用；传 --allow-check-command 显式开启" };
  if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some((x) => typeof x !== "string" || !x)) {
    return { check, pass: false, detail: "command.argv 必须是非空字符串数组" };
  }
  let cwd: string;
  try { cwd = resolveSafe(workspace, check.cwd ?? "."); } catch (e: any) {
    return { check, pass: false, detail: e?.message ?? String(e) };
  }
  const timeoutMs = Math.min(120_000, Math.max(100, bounded(check.timeoutMs, 30_000)));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(check.argv[0], check.argv.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      env: evalCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 1_000_000) stderr += String(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
  if (result.timedOut) return { check, pass: false, detail: `command check 超时（${timeoutMs}ms）` };
  const expected = check.exitCode ?? 0;
  if (result.code !== expected) return { check, pass: false, detail: `exit=${result.code}，期望 ${expected}; stderr=${result.stderr.slice(0, 500)}` };
  if (check.stdoutIncludes && !result.stdout.includes(check.stdoutIncludes)) {
    return { check, pass: false, detail: `stdout 未包含：${check.stdoutIncludes}` };
  }
  return { check, pass: true, detail: `exit=${result.code}` };
}


async function runHostNodeCheck(
  workspace: string,
  check: Extract<EvalCheck, { type: "host_node" }>,
  allow: boolean
): Promise<EvalCheckResult> {
  if (!allow) return { check, pass: false, detail: "host verifier 被禁用；仅可信 suite 可显式开启" };
  let script: string;
  try { script = fs.realpathSync(check.script); } catch { return { check, pass: false, detail: "host verifier script 不存在" }; }
  if (!fs.statSync(script).isFile()) return { check, pass: false, detail: "host verifier script 不是文件" };
  const timeoutMs = Math.min(120_000, Math.max(100, bounded(check.timeoutMs, 30_000)));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(process.execPath, [script, workspace, ...(check.args ?? [])], {
      cwd: workspace, shell: false, windowsHide: true, env: evalCommandEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let timedOut = false;
    child.stdout?.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 1_000_000) stderr += String(chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
  if (result.timedOut) return { check, pass: false, detail: `host verifier 超时（${timeoutMs}ms）` };
  const expected = check.exitCode ?? 0;
  if (result.code !== expected) return { check, pass: false, detail: `exit=${result.code}，期望 ${expected}; stderr=${result.stderr.slice(0, 500)}` };
  if (check.stdoutIncludes && !result.stdout.includes(check.stdoutIncludes)) {
    return { check, pass: false, detail: `stdout 未包含：${check.stdoutIncludes}` };
  }
  return { check, pass: true, detail: `exit=${result.code}` };
}

async function evaluateCheck(
  workspace: string,
  sessionDir: string,
  sessionId: string,
  trace: SessionTraceSummary,
  check: EvalCheck,
  allowCommandChecks: boolean
): Promise<EvalCheckResult> {
  if (check.type === "command") return runCheckCommand(workspace, check, allowCommandChecks);
  if (check.type === "host_node") return runHostNodeCheck(workspace, check, allowCommandChecks);
  if (check.type === "turn_reason") {
    const pass = trace.finalReason === check.reason;
    return { check, pass, detail: `turn reason=${trace.finalReason ?? "none"}` };
  }
  if (check.type === "tool_called") {
    const calls = trace.toolUsage[check.name]?.calls ?? 0;
    const min = bounded(check.min, 1);
    const max = bounded(check.max, Number.MAX_SAFE_INTEGER);
    return { check, pass: calls >= min && calls <= max, detail: `${check.name} calls=${calls}, expected ${min}..${max}` };
  }
  if (check.type === "event_count") {
    const count = querySessionEvents(sessionDir, sessionId, { actor: check.actor, types: [check.eventType] }).length;
    const min = bounded(check.min, 1);
    const max = bounded(check.max, Number.MAX_SAFE_INTEGER);
    return { check, pass: count >= min && count <= max, detail: `${check.eventType} count=${count}, expected ${min}..${max}` };
  }
  let target: string;
  try { target = resolveSafe(workspace, check.path); } catch (e: any) {
    return { check, pass: false, detail: e?.message ?? String(e) };
  }
  if (check.type === "file_exists") {
    const pass = fs.existsSync(target);
    return { check, pass, detail: pass ? "存在" : "不存在" };
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { check, pass: false, detail: "目标文件不存在" };
  const content = fs.readFileSync(target, "utf8");
  if (check.type === "file_contains") {
    const pass = content.includes(check.text);
    return { check, pass, detail: pass ? "包含目标文本" : `未包含：${check.text}` };
  }
  const pass = !content.includes(check.text);
  return { check, pass, detail: pass ? "未发现禁止文本" : `发现禁止文本：${check.text}` };
}

function appendCapture(current: string, text: string, max = 1_000_000): string {
  if (current.length >= max) return current;
  return current + text.slice(0, max - current.length);
}

/** Run one eval case in an isolated copied workspace using the normal Headless kernel. */
export async function runEvalCase(
  definition: EvalCaseDefinition,
  options: EvalRunOptions,
  runId: string
): Promise<EvalCaseResult> {
  const caseId = safeCaseId(definition.id);
  const caseRoot = path.join(options.outDir, "cases", caseId);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `freesek-eval-${caseId}-`));
  const sessionDir = path.join(caseRoot, "sessions");
  copyWorkspace(path.resolve(definition.workspace), workspace);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionId = assertSafeSessionId(`eval-${runId}-${caseId}`.slice(0, 128));
  let stdout = "";
  let stderr = "";
  const capture: HeadlessIO = {
    stdout: (text) => { stdout = appendCapture(stdout, text); options.io?.stdout(text); },
    stderr: (text) => { stderr = appendCapture(stderr, text); options.io?.stderr(text); },
  };
  const args = [
    "--prompt", definition.prompt,
    "--base-url", options.baseUrl,
    "--api-key", options.apiKey,
    "--model", options.model,
    "--workspace", workspace,
    "--session-dir", sessionDir,
    "--session-id", sessionId,
    "--yes",
    "--context-planner", options.contextPlanner ?? "off",
    "--context-plan-budget", String(options.contextPlanBudget ?? 3500),
  ];
  if (definition.allowShell) args.push("--allow-shell");
  if (definition.allowNetwork === false) args.push("--no-network");
  const exitCode = await runHeadless(args, capture);
  const trace = loadSessionTrace(sessionDir, sessionId);
  const checks: EvalCheckResult[] = [];
  for (const check of definition.checks ?? []) {
    checks.push(await evaluateCheck(workspace, sessionDir, sessionId, trace, check, options.allowCommandChecks === true));
  }
  const pass = exitCode === 0 && checks.every((row) => row.pass);
  return { id: caseId, pass, exitCode, workspace, sessionDir, sessionId, stdout, stderr, checks, trace };
}

function aggregate(cases: readonly EvalCaseResult[]): EvalReportSummary {
  const passed = cases.filter((row) => row.pass).length;
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: cases.length ? passed / cases.length : 0,
    durationMs: cases.reduce((n, row) => n + row.trace.durationMs, 0),
    totalTokens: cases.reduce((n, row) => n + row.trace.totalTokens, 0),
    promptTokens: cases.reduce((n, row) => n + row.trace.promptTokens, 0),
    completionTokens: cases.reduce((n, row) => n + row.trace.completionTokens, 0),
    toolCalls: cases.reduce((n, row) => n + row.trace.toolCalls, 0),
    steps: cases.reduce((n, row) => n + row.trace.steps, 0),
    blockedToolCalls: cases.reduce((n, row) => n + row.trace.blockedToolCalls, 0),
    timedOutToolCalls: cases.reduce((n, row) => n + row.trace.timedOutToolCalls, 0),
    approvalsRequested: cases.reduce((n, row) => n + row.trace.approvalsRequested, 0),
    contextPlans: cases.reduce((n, row) => n + row.trace.contextPlans, 0),
    contextPlanErrors: cases.reduce((n, row) => n + row.trace.contextPlanErrors, 0),
    contextFilesSelected: cases.reduce((n, row) => n + row.trace.contextFilesSelected, 0),
    contextPlanTokens: cases.reduce((n, row) => n + row.trace.contextPlanTokens, 0),
    contextPlanDurationMs: cases.reduce((n, row) => n + row.trace.contextPlanDurationMs, 0),
    contextExploratorySearchCalls: cases.reduce((n, row) => n + row.trace.contextExploratorySearchCalls, 0),
    contextPlannedReadCalls: cases.reduce((n, row) => n + row.trace.contextPlannedReadCalls, 0),
    contextUnplannedReadCalls: cases.reduce((n, row) => n + row.trace.contextUnplannedReadCalls, 0),
    contextPlannedMutationCalls: cases.reduce((n, row) => n + row.trace.contextPlannedMutationCalls, 0),
    contextUnplannedMutationCalls: cases.reduce((n, row) => n + row.trace.contextUnplannedMutationCalls, 0),
    contextTopCandidateTouches: cases.reduce((n, row) => n + row.trace.contextTopCandidateTouches, 0),
  };
}

/** Run a manifest sequentially and persist a stable JSON report. */
export async function runEvalManifest(manifest: EvalManifest, options: EvalRunOptions): Promise<EvalReport> {
  if (!manifest.name?.trim() || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error("eval manifest 必须包含 name 与非空 cases");
  fs.mkdirSync(options.outDir, { recursive: true });
  const runId = assertSafeSessionId(`r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
  const cases: EvalCaseResult[] = [];
  for (const definition of manifest.cases) cases.push(await runEvalCase(definition, options, runId));
  const report: EvalReport = {
    version: 1,
    runId,
    suite: manifest.name,
    createdAt: new Date().toISOString(),
    provider: { baseUrl: options.baseUrl, model: options.model },
    agent: { contextPlanner: options.contextPlanner ?? "off", contextPlanBudget: options.contextPlanBudget ?? 3500 },
    cases,
    summary: aggregate(cases),
  };
  fs.writeFileSync(path.join(options.outDir, `report-${runId}.json`), JSON.stringify(report, null, 2), "utf8");
  if (!options.keepWorkspaces) {
    // Keep sessions/traces and check results; drop copied workspaces to limit eval disk growth.
    for (const row of cases) fs.rmSync(row.workspace, { recursive: true, force: true });
  }
  return report;
}

function reportAsTrace(report: EvalReport): SessionTraceSummary {
  return {
    sessionId: report.runId, actor: "aggregate", durationMs: report.summary.durationMs,
    turns: report.cases.reduce((n, row) => n + row.trace.turns, 0), steps: report.summary.steps,
    modelRequests: report.cases.reduce((n, row) => n + row.trace.modelRequests, 0), modelErrors: report.cases.reduce((n, row) => n + row.trace.modelErrors, 0),
    modelLatencyMs: report.cases.reduce((n, row) => n + row.trace.modelLatencyMs, 0), promptTokens: report.summary.promptTokens,
    completionTokens: report.summary.completionTokens, totalTokens: report.summary.totalTokens, toolCalls: report.summary.toolCalls,
    blockedToolCalls: report.summary.blockedToolCalls, timedOutToolCalls: report.summary.timedOutToolCalls,
    approvalsRequested: report.summary.approvalsRequested, approvalsAllowed: report.cases.reduce((n, row) => n + row.trace.approvalsAllowed, 0),
    approvalsDenied: report.cases.reduce((n, row) => n + row.trace.approvalsDenied, 0),
    contextPlans: report.summary.contextPlans, contextPlanErrors: report.summary.contextPlanErrors,
    contextFilesSelected: report.summary.contextFilesSelected, contextPlanTokens: report.summary.contextPlanTokens,
    contextPlanDurationMs: report.summary.contextPlanDurationMs,
    contextExploratorySearchCalls: report.summary.contextExploratorySearchCalls,
    contextPlannedReadCalls: report.summary.contextPlannedReadCalls,
    contextUnplannedReadCalls: report.summary.contextUnplannedReadCalls,
    contextPlannedMutationCalls: report.summary.contextPlannedMutationCalls,
    contextUnplannedMutationCalls: report.summary.contextUnplannedMutationCalls,
    contextTopCandidateTouches: report.summary.contextTopCandidateTouches,
    checkpoints: report.cases.reduce((n, row) => n + row.trace.checkpoints, 0),
    compactions: report.cases.reduce((n, row) => n + row.trace.compactions, 0), forks: report.cases.reduce((n, row) => n + row.trace.forks, 0), toolUsage: {},
  };
}

/** Compare aggregate reliability/cost metrics between two eval reports. */
export function compareEvalReports(baseline: EvalReport, candidate: EvalReport): EvalReportComparison {
  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
    passedDelta: candidate.summary.passed - baseline.summary.passed,
    metrics: diffSessionTrace(reportAsTrace(baseline), reportAsTrace(candidate)),
  };
}
