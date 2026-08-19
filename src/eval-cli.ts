#!/usr/bin/env node
/** CLI wrapper for the FreeSeek trace/eval harness. */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
declare const __FREESEEK_CLI_ENTRY__: string | undefined;
import { compareEvalReports, runEvalManifest, type EvalManifest, type EvalReport } from "./eval";

interface CliArgs {
  manifest: string;
  outDir: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  allowCommandChecks: boolean;
  keepWorkspaces: boolean;
  compare?: string;
  contextPlanner: "off" | "v1" | "v1.1" | "v1.2";
  contextPlanBudget: number;
}

function usage(): string {
  return [
    "FreeSeek Eval",
    "",
    "  freeseek-eval --manifest <suite.json> --base-url <url> --model <id> [options]",
    "",
    "凭据：--api-key <key> 或 FREESEEK_API_KEY",
    "输出：--out <dir>（默认 ~/.freesek/evals）",
    "检查：--allow-check-command 允许 manifest 中 argv-only command checks",
    "保留：--keep-workspaces 保留每个 case 的复制工作区",
    "对比：--compare <baseline-report.json> 在本轮后输出指标 delta",
    "Context：--context-planner off|v1|v1.1|v1.2；--context-plan-budget <tokens>（默认 3500）",
  ].join("\n");
}

function value(argv: string[], i: number, name: string): string {
  const next = argv[i + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return next;
}

function parse(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    outDir: path.join(os.homedir(), ".freesek", "evals"),
    baseUrl: process.env.FREESEEK_BASE_URL ?? "",
    apiKey: process.env.FREESEEK_API_KEY ?? "",
    model: process.env.FREESEEK_MODEL ?? "",
    allowCommandChecks: false,
    keepWorkspaces: false,
    contextPlanner: (["v1", "v1.1", "v1.2"] as const).includes(process.env.FREESEEK_CONTEXT_PLANNER as any) ? process.env.FREESEEK_CONTEXT_PLANNER as "v1" | "v1.1" | "v1.2" : "off",
    contextPlanBudget: 3500,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { process.stdout.write(usage() + "\n"); process.exit(0); }
    if (arg === "--allow-check-command") { out.allowCommandChecks = true; continue; }
    if (arg === "--keep-workspaces") { out.keepWorkspaces = true; continue; }
    if (["--manifest", "--out", "--base-url", "--api-key", "--model", "--compare", "--context-planner", "--context-plan-budget"].includes(arg)) {
      const v = value(argv, i, arg); i++;
      if (arg === "--out") out.outDir = path.resolve(v);
      else if (arg === "--base-url") out.baseUrl = v;
      else if (arg === "--api-key") out.apiKey = v;
      else if (arg === "--compare") out.compare = path.resolve(v);
      else if (arg === "--context-planner") out.contextPlanner = v as "off" | "v1" | "v1.1" | "v1.2";
      else if (arg === "--context-plan-budget") out.contextPlanBudget = Number(v);
      else (out as Record<string, unknown>)[arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = v;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!out.manifest) throw new Error("缺少 --manifest");
  if (!out.baseUrl) throw new Error("缺少 --base-url / FREESEEK_BASE_URL");
  if (!out.apiKey) throw new Error("缺少 --api-key / FREESEEK_API_KEY");
  if (!out.model) throw new Error("缺少 --model / FREESEEK_MODEL");
  if (!['off', 'v1', 'v1.1', 'v1.2'].includes(String(out.contextPlanner))) throw new Error("--context-planner 必须是 off|v1|v1.1|v1.2");
  if (!Number.isFinite(out.contextPlanBudget) || Number(out.contextPlanBudget) < 256 || Number(out.contextPlanBudget) > 12000) throw new Error("--context-plan-budget 必须在 256..12000");
  out.manifest = path.resolve(out.manifest);
  return out as CliArgs;
}

function loadManifest(filePath: string): EvalManifest {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvalManifest;
  const base = path.dirname(filePath);
  for (const row of parsed.cases ?? []) row.workspace = path.resolve(base, row.workspace);
  return parsed;
}

/** Eval CLI main entry; exported for smoke tests. */
export async function runEvalCli(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try { args = parse(argv); } catch (e: any) { process.stderr.write(`${e?.message ?? e}\n\n${usage()}\n`); return 2; }
  try {
    const manifest = loadManifest(args.manifest);
    const report = await runEvalManifest(manifest, {
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      outDir: args.outDir,
      allowCommandChecks: args.allowCommandChecks,
      keepWorkspaces: args.keepWorkspaces,
      contextPlanner: args.contextPlanner,
      contextPlanBudget: args.contextPlanBudget,
      io: { stdout: () => {}, stderr: (text) => process.stderr.write(text) },
    });
    const reportPath = path.join(args.outDir, `report-${report.runId}.json`);
    process.stdout.write(JSON.stringify({ report: reportPath, summary: report.summary }, null, 2) + "\n");
    if (args.compare) {
      const baseline = JSON.parse(fs.readFileSync(args.compare, "utf8")) as EvalReport;
      const comparison = compareEvalReports(baseline, report);
      const comparisonPath = path.join(args.outDir, `compare-${baseline.runId}-to-${report.runId}.json`);
      fs.writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2), "utf8");
      process.stdout.write(JSON.stringify({ comparison: comparisonPath, delta: comparison }, null, 2) + "\n");
    }
    return report.summary.failed === 0 ? 0 : 1;
  } catch (e: any) {
    process.stderr.write(`FreeSeek Eval 失败：${e?.message ?? String(e)}\n`);
    return 1;
  }
}

if (typeof __FREESEEK_CLI_ENTRY__ !== "undefined" && __FREESEEK_CLI_ENTRY__ === "eval") {
  void runEvalCli().then((code) => { process.exitCode = code; });
}
