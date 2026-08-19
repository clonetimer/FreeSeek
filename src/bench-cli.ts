#!/usr/bin/env node
/** CLI for FreeSeek public regression, private holdout and pinned real-repository benchmarks. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
declare const __FREESEEK_CLI_ENTRY__: string | undefined;
import {
  builtInBenchManifestPath, builtInRealBenchManifestPath, compareBenchReports, filterBenchCases, loadBenchSuite,
  privateBenchCaseId, runBenchSuite, type BenchCategory, type BenchFilters, type BenchReport,
} from "./bench";
import { validateBenchFixtures } from "./bench-validate";
import { initPrivateHoldoutPack } from "./bench-private";
import { runContextPlannerAb } from "./bench-context-ab";
import { builtInContextRetrievalManifestPath, renderContextRetrievalReport, runContextRetrievalExperiment } from "./context-retrieval-eval";

interface CliArgs {
  command: "list" | "validate" | "run" | "compare" | "init-holdout" | "ab-context" | "context-retrieval";
  suite: string;
  outDir: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  repeat: number;
  filters: BenchFilters;
  keepWorkspaces: boolean;
  keepPrivateTraces: boolean;
  trustSuite: boolean;
  gold: boolean;
  offlineSources: boolean;
  sourceCache?: string;
  outExplicit: boolean;
  baseline?: string;
  candidate?: string;
  contextPlanner: "off" | "v1" | "v1.1" | "v1.2";
  contextPlanBudget: number;
  baselinePlanner: "off" | "v1" | "v1.1" | "v1.2";
  candidatePlanner: "off" | "v1" | "v1.1" | "v1.2";
  retrievalSuite: string;
}

function usage(): string {
  return [
    "FreeSeek Bench",
    "",
    "  freeseek-bench list [--suite manifest.json | --real] [filters]",
    "  freeseek-bench validate [--suite manifest.json | --real] [--gold] [--trust-suite]",
    "  freeseek-bench run --base-url <url> --model <id> [options]",
    "  freeseek-bench compare --baseline <report.json> --candidate <report.json>",
    "  freeseek-bench ab-context --base-url <url> --model <id> [suite/filter/repeat options]",
    "  freeseek-bench context-retrieval [--out <dir>] [--context-plan-budget <n>]",
    "  freeseek-bench init-holdout --out <private-dir>",
    "",
    "Suites:",
    "  默认：benchmarks/v1（20 个公开 deterministic regression tasks）",
    "  --real：benchmarks/real-v1（固定 Git commit 的真实历史 PR tasks）",
    "  --suite：自定义/public/private manifest；v2 支持 local/git source",
    "",
    "Source：--source-cache <dir>；--offline-sources 只允许已缓存的 Git commit",
    "Private：visibility=private 时 report 自动匿名/脱敏，trace 默认删除；--keep-private-traces 显式保留",
    "Trust：外部 suite 的 command/host_node verifier 只有 --trust-suite 后才执行",
    "凭据：--api-key <key> 或 FREESEEK_API_KEY；--base-url / FREESEEK_BASE_URL；--model / FREESEEK_MODEL",
    "过滤：--case id、--category core|multifile|context|security、--tag tag（均可重复）",
    "Context：--context-planner off|v1|v1.1|v1.2；--context-plan-budget <tokens>（默认 3500）",
    "A/B：ab-context 默认 baseline=off、candidate=v1；可用 --baseline-planner / --candidate-planner 指定版本",
    "Retrieval：context-retrieval 不调用模型，比较 v1/v1.1/v1.2 的 Hit@K/MRR、失败归因与呈现 token",
  ].join("\n");
}

function value(argv: string[], i: number, name: string): string {
  const next = argv[i + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} 缺少参数`);
  return next;
}

function parse(argv: string[]): CliArgs {
  const command = (argv[0] && !argv[0].startsWith("--") ? argv[0] : "run") as CliArgs["command"];
  if (!["list", "validate", "run", "compare", "init-holdout", "ab-context", "context-retrieval"].includes(command)) throw new Error(`未知命令：${command}`);
  const start = argv[0] === command ? 1 : 0;
  const args: CliArgs = {
    command,
    suite: builtInBenchManifestPath(),
    outDir: path.join(os.homedir(), ".freesek", "bench"),
    baseUrl: process.env.FREESEEK_BASE_URL ?? "",
    apiKey: process.env.FREESEEK_API_KEY ?? "",
    model: process.env.FREESEEK_MODEL ?? "",
    repeat: 1,
    filters: {},
    keepWorkspaces: false,
    keepPrivateTraces: false,
    trustSuite: false,
    gold: false,
    offlineSources: false,
    outExplicit: false,
    contextPlanner: (["v1", "v1.1", "v1.2"] as const).includes(process.env.FREESEEK_CONTEXT_PLANNER as any) ? process.env.FREESEEK_CONTEXT_PLANNER as "v1" | "v1.1" | "v1.2" : "off",
    contextPlanBudget: 3500,
    baselinePlanner: "off",
    candidatePlanner: "v1",
    retrievalSuite: builtInContextRetrievalManifestPath(),
  };
  const ids: string[] = [], categories: BenchCategory[] = [], tags: string[] = [];
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { process.stdout.write(usage() + "\n"); process.exit(0); }
    if (arg === "--real") { args.suite = builtInRealBenchManifestPath(); continue; }
    if (arg === "--keep-workspaces") { args.keepWorkspaces = true; continue; }
    if (arg === "--keep-private-traces") { args.keepPrivateTraces = true; continue; }
    if (arg === "--trust-suite" || arg === "--allow-check-command") { args.trustSuite = true; continue; }
    if (arg === "--gold") { args.gold = true; continue; }
    if (arg === "--offline-sources") { args.offlineSources = true; continue; }
    if (["--suite", "--out", "--source-cache", "--base-url", "--api-key", "--model", "--repeat", "--case", "--category", "--tag", "--baseline", "--candidate", "--context-planner", "--context-plan-budget", "--baseline-planner", "--candidate-planner", "--retrieval-suite"].includes(arg)) {
      const v = value(argv, i, arg); i++;
      if (arg === "--suite") args.suite = path.resolve(v);
      else if (arg === "--out") { args.outDir = path.resolve(v); args.outExplicit = true; }
      else if (arg === "--source-cache") args.sourceCache = path.resolve(v);
      else if (arg === "--base-url") args.baseUrl = v;
      else if (arg === "--api-key") args.apiKey = v;
      else if (arg === "--model") args.model = v;
      else if (arg === "--repeat") args.repeat = Number(v);
      else if (arg === "--case") ids.push(v);
      else if (arg === "--category") categories.push(v as BenchCategory);
      else if (arg === "--tag") tags.push(v);
      else if (arg === "--baseline") args.baseline = path.resolve(v);
      else if (arg === "--candidate") args.candidate = path.resolve(v);
      else if (arg === "--context-planner") args.contextPlanner = v as "off" | "v1" | "v1.1" | "v1.2";
      else if (arg === "--context-plan-budget") args.contextPlanBudget = Number(v);
      else if (arg === "--baseline-planner") args.baselinePlanner = v as "off" | "v1" | "v1.1" | "v1.2";
      else if (arg === "--candidate-planner") args.candidatePlanner = v as "off" | "v1" | "v1.1" | "v1.2";
      else if (arg === "--retrieval-suite") args.retrievalSuite = path.resolve(v);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!['off', 'v1', 'v1.1', 'v1.2'].includes(args.contextPlanner)) throw new Error("--context-planner 必须是 off|v1|v1.1|v1.2");
  if (!['off', 'v1', 'v1.1', 'v1.2'].includes(args.baselinePlanner) || !['off', 'v1', 'v1.1', 'v1.2'].includes(args.candidatePlanner)) throw new Error("--baseline-planner/--candidate-planner 必须是 off|v1|v1.1|v1.2");
  if (!Number.isFinite(args.contextPlanBudget) || args.contextPlanBudget < 256 || args.contextPlanBudget > 12000) throw new Error("--context-plan-budget 必须在 256..12000");
  args.filters = { caseIds: ids.length ? ids : undefined, categories: categories.length ? categories : undefined, tags: tags.length ? tags : undefined };
  return args;
}

function isBuiltInSuite(file: string): boolean {
  try {
    const actual = fs.realpathSync(file);
    return [builtInBenchManifestPath(), builtInRealBenchManifestPath()].some((candidate) => {
      try { return actual === fs.realpathSync(candidate); } catch { return false; }
    });
  } catch { return false; }
}

function printList(args: CliArgs): number {
  const suite = loadBenchSuite(args.suite);
  const rows = filterBenchCases(suite.manifest.cases, args.filters);
  const cases = rows.map((row) => ({
    id: suite.visibility === "private" ? privateBenchCaseId(suite.fingerprint, row.id) : row.id,
    category: row.category,
    difficulty: row.difficulty,
    source: row.source?.kind ?? "local",
    weight: row.weight,
    tags: suite.visibility === "private" ? [] : (row.tags ?? []),
  }));
  process.stdout.write(JSON.stringify({ suite: suite.visibility === "private" ? "private-holdout" : suite.manifest.name, visibility: suite.visibility, fingerprint: suite.fingerprint, count: rows.length, cases }, null, 2) + "\n");
  return rows.length ? 0 : 1;
}

function validate(args: CliArgs): number {
  const suite = loadBenchSuite(args.suite);
  const trusted = isBuiltInSuite(args.suite) || args.trustSuite;
  if (!trusted) {
    process.stdout.write(JSON.stringify({ suite: suite.visibility === "private" ? "private-holdout" : suite.manifest.name, fingerprint: suite.fingerprint, cases: suite.manifest.cases.length, staticValidation: "skipped-untrusted", hint: "传 --trust-suite 执行外部 verifier" }, null, 2) + "\n");
    return 0;
  }
  const result = validateBenchFixtures(suite, { cacheDir: args.sourceCache, offline: args.offlineSources }, args.gold);
  process.stdout.write(JSON.stringify({ suite: suite.visibility === "private" ? "private-holdout" : suite.manifest.name, fingerprint: suite.fingerprint, ...result }, null, 2) + "\n");
  return result.failures.length ? 1 : 0;
}

function runOptions(args: CliArgs, trustedVerifier: boolean) {
  return {
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    outDir: args.outDir,
    repeat: args.repeat,
    filters: args.filters,
    keepWorkspaces: args.keepWorkspaces,
    keepPrivateTraces: args.keepPrivateTraces,
    allowCommandChecks: trustedVerifier,
    cacheDir: args.sourceCache,
    offline: args.offlineSources,
    contextPlanner: args.contextPlanner,
    contextPlanBudget: args.contextPlanBudget,
    io: { stdout: () => {}, stderr: (text: string) => process.stderr.write(text) },
  };
}

async function run(args: CliArgs): Promise<number> {
  if (!args.baseUrl) throw new Error("缺少 --base-url / FREESEEK_BASE_URL");
  if (!args.apiKey) throw new Error("缺少 --api-key / FREESEEK_API_KEY");
  if (!args.model) throw new Error("缺少 --model / FREESEEK_MODEL");
  const suite = loadBenchSuite(args.suite);
  const trustedVerifier = isBuiltInSuite(args.suite) || args.trustSuite;
  const report = await runBenchSuite(suite, runOptions(args, trustedVerifier));
  const reportPath = path.join(args.outDir, `bench-${report.runId}.json`);
  const markdownPath = path.join(args.outDir, `bench-${report.runId}.md`);
  process.stdout.write(JSON.stringify({ report: reportPath, markdown: markdownPath, visibility: report.visibility, fingerprint: report.suiteFingerprint, summary: report.summary }, null, 2) + "\n");
  return report.summary.strictPassed === report.summary.cases ? 0 : 1;
}

async function runContextAb(args: CliArgs): Promise<number> {
  if (!args.baseUrl) throw new Error("缺少 --base-url / FREESEEK_BASE_URL");
  if (!args.apiKey) throw new Error("缺少 --api-key / FREESEEK_API_KEY");
  if (!args.model) throw new Error("缺少 --model / FREESEEK_MODEL");
  const suite = loadBenchSuite(args.suite);
  const trustedVerifier = isBuiltInSuite(args.suite) || args.trustSuite;
  const result = await runContextPlannerAb(suite, { ...runOptions(args, trustedVerifier), baselinePlanner: args.baselinePlanner, candidatePlanner: args.candidatePlanner });
  process.stdout.write(JSON.stringify({
    comparison: result.comparisonPath,
    baseline: { runId: result.baseline.runId, planner: result.baseline.agent.contextPlanner, summary: result.baseline.summary },
    candidate: { runId: result.candidate.runId, planner: result.candidate.agent.contextPlanner, summary: result.candidate.summary },
    delta: result.comparison,
  }, null, 2) + "\n");
  return 0;
}


function runContextRetrieval(args: CliArgs): number {
  const report = runContextRetrievalExperiment(args.retrievalSuite, ["v1", "v1.1", "v1.2"], args.contextPlanBudget);
  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, `context-retrieval-${Date.now().toString(36)}.json`);
  const mdPath = jsonPath.replace(/\.json$/, ".md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(mdPath, renderContextRetrievalReport(report), "utf8");
  process.stdout.write(JSON.stringify({ report: jsonPath, markdown: mdPath, variants: report.variants.map((row) => ({ variant: row.variant, hitAt1: row.hitAt1, hitAt3: row.hitAt3, mrr: row.meanReciprocalRank, diagnoses: row.diagnoses })) }, null, 2) + "\n");
  return 0;
}

function compare(args: CliArgs): number {
  if (!args.baseline || !args.candidate) throw new Error("compare 需要 --baseline 与 --candidate");
  const baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8")) as BenchReport;
  const candidate = JSON.parse(fs.readFileSync(args.candidate, "utf8")) as BenchReport;
  const result = compareBenchReports(baseline, candidate);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.sameSuiteFingerprint && result.sameSelection ? 0 : 2;
}

function initHoldout(args: CliArgs): number {
  if (!args.outExplicit) throw new Error("init-holdout 必须显式提供 --out <private-dir>");
  const target = initPrivateHoldoutPack(args.outDir);
  process.stdout.write(JSON.stringify({ holdout: target, manifest: path.join(target, "manifest.json"), next: "编辑 fixture/prompt/verifier 后执行 freeseek-bench validate --suite <manifest> --trust-suite" }, null, 2) + "\n");
  return 0;
}

/** Benchmark CLI main entry. */
export async function runBenchCli(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try { args = parse(argv); } catch (e: any) { process.stderr.write(`${e?.message ?? e}\n\n${usage()}\n`); return 2; }
  try {
    if (args.command === "list") return printList(args);
    if (args.command === "validate") return validate(args);
    if (args.command === "compare") return compare(args);
    if (args.command === "ab-context") return await runContextAb(args);
    if (args.command === "context-retrieval") return runContextRetrieval(args);
    if (args.command === "init-holdout") return initHoldout(args);
    return await run(args);
  } catch (e: any) {
    process.stderr.write(`FreeSeek Bench 失败：${e?.message ?? String(e)}\n`);
    return 1;
  }
}

if (typeof __FREESEEK_CLI_ENTRY__ !== "undefined" && __FREESEEK_CLI_ENTRY__ === "bench") {
  void runBenchCli().then((code) => { process.exitCode = code; });
}
