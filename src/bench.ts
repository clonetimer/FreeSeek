/** FreeSeek Coding Benchmark orchestration built on the deterministic Eval Harness. */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { runEvalCase, type EvalCaseDefinition, type EvalCaseResult, type EvalRunOptions, type EvalCheck } from "./eval";
import { benchSourceIdentity, materializeBenchSource, validateBenchSource, type BenchSource, type BenchSourceOptions } from "./bench-source";
import { assertSafeSessionId } from "./session-id";
import type { SessionTraceSummary } from "./trace";

export type BenchCategory = "core" | "multifile" | "context" | "security";
export type BenchDifficulty = "easy" | "medium" | "hard";

export interface BenchBudget {
  maxTokens?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxApprovalsRequested?: number;
}

export type BenchVisibility = "public" | "private";

export interface BenchProvenance {
  repository?: string;
  pullRequest?: number;
  issue?: number;
  license?: string;
}

export interface BenchCaseDefinition extends Omit<EvalCaseDefinition, "workspace"> {
  workspace?: string;
  source?: BenchSource;
  provenance?: BenchProvenance;
  category: BenchCategory;
  difficulty: BenchDifficulty;
  tags?: string[];
  weight?: number;
  budget?: BenchBudget;
}

export interface BenchSuiteManifest {
  version: 1 | 2;
  name: string;
  description?: string;
  visibility?: BenchVisibility;
  cases: BenchCaseDefinition[];
}

export interface LoadedBenchSuite {
  manifestPath: string;
  manifest: BenchSuiteManifest;
  fingerprint: string;
  visibility: BenchVisibility;
}

export interface BenchFilters {
  caseIds?: string[];
  categories?: BenchCategory[];
  tags?: string[];
}

export interface BenchRunOptions extends EvalRunOptions, BenchSourceOptions {
  repeat?: number;
  filters?: BenchFilters;
  keepPrivateTraces?: boolean;
}

export interface BenchBudgetResult {
  pass: boolean;
  violations: string[];
}

export interface BenchAttemptResult {
  attempt: number;
  eval: EvalCaseResult;
  budget: BenchBudgetResult;
}

export interface BenchCaseResult {
  id: string;
  source: { kind: "local" | "git"; commit?: string; repositoryHash?: string };
  category: BenchCategory;
  difficulty: BenchDifficulty;
  tags: string[];
  weight: number;
  successRate: number;
  strictPass: boolean;
  budgetPassRate: number;
  attempts: BenchAttemptResult[];
}

export interface BenchCategorySummary {
  category: BenchCategory;
  cases: number;
  attempts: number;
  weightedScore: number;
  strictPassed: number;
}

export interface BenchSummary {
  cases: number;
  attempts: number;
  weightedScore: number;
  strictPassed: number;
  strictPassRate: number;
  budgetPassRate: number;
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
  categories: BenchCategorySummary[];
}

export interface BenchReport {
  version: 2;
  visibility: BenchVisibility;
  runId: string;
  suite: string;
  suiteFingerprint: string;
  createdAt: string;
  provider: { baseUrl: string; model: string };
  agent: { contextPlanner: "off" | "v1" | "v1.1" | "v1.2"; contextPlanBudget: number };
  environment: { platform: string; arch: string; node: string };
  repeat: number;
  filters: BenchFilters;
  cases: BenchCaseResult[];
  summary: BenchSummary;
}

export interface BenchCaseDelta {
  id: string;
  baseline: number;
  candidate: number;
  delta: number;
}

export interface BenchComparison {
  baselineRunId: string;
  candidateRunId: string;
  baselinePlanner: "off" | "v1" | "v1.1" | "v1.2";
  candidatePlanner: "off" | "v1" | "v1.1" | "v1.2";
  sameSuiteFingerprint: boolean;
  sameSelection: boolean;
  sameRepeat: boolean;
  weightedScoreDelta: number;
  strictPassedDelta: number;
  avgTokensPerAttemptDelta: number;
  avgStepsPerAttemptDelta: number;
  avgToolCallsPerAttemptDelta: number;
  avgDurationMsPerAttemptDelta: number;
  avgContextExploratorySearchCallsDelta: number;
  avgContextUnplannedReadCallsDelta: number;
  avgContextUnplannedMutationCallsDelta: number;
  improvements: BenchCaseDelta[];
  regressions: BenchCaseDelta[];
}

const CATEGORY_ORDER: BenchCategory[] = ["core", "multifile", "context", "security"];

function builtInManifest(relativeDir: string): string {
  const packaged = path.resolve(__dirname, "..", "benchmarks", relativeDir, "manifest.json");
  const development = path.resolve(process.cwd(), "benchmarks", relativeDir, "manifest.json");
  return fs.existsSync(packaged) ? packaged : development;
}

/** Built-in public deterministic regression suite. */
export function builtInBenchManifestPath(): string {
  return builtInManifest("v1");
}

/** Built-in pinned real-repository suite. Source code is fetched by immutable commit SHA. */
export function builtInRealBenchManifestPath(): string {
  return builtInManifest("real-v1");
}

function normalizeWeight(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function validateRelativeWorkspace(manifestDir: string, workspace: string): string {
  const base = fs.realpathSync(manifestDir);
  const resolved = path.resolve(base, workspace);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`benchmark workspace 不存在：${workspace}`);
  const real = fs.realpathSync(resolved);
  const rel = path.relative(base, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`benchmark workspace 越界：${workspace}`);
  return real;
}

function hashWorkspace(hash: crypto.Hash, workspace: string): void {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(p);
      if (entry.isFile()) return [p];
      throw new Error(`benchmark workspace 禁止 symlink/特殊文件：${p}`);
    });
  for (const file of walk(workspace).sort()) {
    const rel = path.relative(workspace, file).replace(/\\/g, "/");
    hash.update(`file:${rel}\0`);
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
}

function validateCase(row: BenchCaseDefinition, seen: Set<string>, manifestVersion: 1 | 2): void {
  assertSafeSessionId(row.id);
  if (seen.has(row.id)) throw new Error(`benchmark case id 重复：${row.id}`);
  seen.add(row.id);
  if (!CATEGORY_ORDER.includes(row.category)) throw new Error(`${row.id}: category 非法`);
  if (!["easy", "medium", "hard"].includes(row.difficulty)) throw new Error(`${row.id}: difficulty 非法`);
  if (!row.prompt?.trim()) throw new Error(`${row.id}: prompt 不能为空`);
  if (row.weight !== undefined && normalizeWeight(row.weight) !== row.weight) throw new Error(`${row.id}: weight 必须 > 0`);
  if (row.tags?.some((tag) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(tag))) throw new Error(`${row.id}: tag 非法`);
  if (manifestVersion === 1 && !row.workspace) throw new Error(`${row.id}: v1 case 必须提供 workspace`);
  if (manifestVersion === 2 && !row.source) throw new Error(`${row.id}: v2 case 必须提供 source`);
  if (!!row.workspace === !!row.source) throw new Error(`${row.id}: workspace 与 source 必须且只能提供一个`);
  if (row.source) validateBenchSource(row.source);
}

function resolveHostVerifier(
  base: string,
  row: BenchCaseDefinition,
  check: Extract<EvalCheck, { type: "host_node" }>,
  hash: crypto.Hash,
  agentWorkspace?: string
): Extract<EvalCheck, { type: "host_node" }> {
  const absolute = path.resolve(base, check.script);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`${row.id}: host verifier 不存在：${check.script}`);
  const baseReal = fs.realpathSync(base);
  const real = fs.realpathSync(absolute);
  const rel = path.relative(baseReal, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`${row.id}: host verifier 越界：${check.script}`);
  const workspaceRoot = agentWorkspace ?? row.workspace;
  if (workspaceRoot) {
    const workspace = fs.realpathSync(workspaceRoot);
    const verifierRel = path.relative(workspace, real);
    if (!(verifierRel === ".." || verifierRel.startsWith(`..${path.sep}`) || path.isAbsolute(verifierRel))) {
      throw new Error(`${row.id}: host verifier 不能位于 Agent workspace 内`);
    }
  }
  hash.update(`verifier:${check.script.replace(/\\/g, "/")}\0`);
  hash.update(fs.readFileSync(real));
  hash.update("\0");
  return { ...check, script: real };
}
/** Load, validate, resolve and fingerprint a benchmark manifest plus all copied workspace files. */
export function loadBenchSuite(manifestPath: string): LoadedBenchSuite {
  const absolute = path.resolve(manifestPath);
  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = JSON.parse(raw) as BenchSuiteManifest;
  if (![1, 2].includes(parsed.version) || !parsed.name?.trim() || !Array.isArray(parsed.cases) || !parsed.cases.length) {
    throw new Error("benchmark manifest 必须是 version=1|2，并包含 name 与非空 cases");
  }
  const visibility: BenchVisibility = parsed.visibility ?? "public";
  if (!["public", "private"].includes(visibility)) throw new Error("benchmark visibility 必须是 public|private");
  const base = path.dirname(absolute);
  const seen = new Set<string>();
  const hash = crypto.createHash("sha256");
  hash.update(raw.replace(/\r\n/g, "\n"));
  const cases = parsed.cases.map((input) => {
    const row: BenchCaseDefinition = { ...input };
    if (row.workspace) row.workspace = validateRelativeWorkspace(base, row.workspace);
    validateCase(row, seen, parsed.version);
    hash.update(`\ncase:${row.id}\0`);
    let agentWorkspace = row.workspace;
    if (row.workspace) hashWorkspace(hash, row.workspace);
    if (row.source?.kind === "local") {
      const materialized = materializeBenchSource(row.source, base);
      agentWorkspace = materialized.workspace;
      hashWorkspace(hash, materialized.workspace);
      materialized.cleanup();
    }
    const checks = (row.checks ?? []).map((check) => check.type === "host_node"
      ? resolveHostVerifier(base, row, check, hash, agentWorkspace)
      : check);
    return { ...row, checks, tags: [...(row.tags ?? [])], weight: normalizeWeight(row.weight) };
  });
  return { manifestPath: absolute, manifest: { ...parsed, visibility, cases }, fingerprint: hash.digest("hex"), visibility };
}

/** Select cases with AND semantics across requested filter dimensions. */
export function filterBenchCases(cases: readonly BenchCaseDefinition[], filters: BenchFilters = {}): BenchCaseDefinition[] {
  const ids = new Set(filters.caseIds ?? []);
  const categories = new Set(filters.categories ?? []);
  const tags = new Set(filters.tags ?? []);
  return cases.filter((row) => {
    if (ids.size && !ids.has(row.id)) return false;
    if (categories.size && !categories.has(row.category)) return false;
    if (tags.size && ![...tags].every((tag) => row.tags?.includes(tag))) return false;
    return true;
  });
}

function budgetResult(trace: SessionTraceSummary, budget: BenchBudget | undefined): BenchBudgetResult {
  if (!budget) return { pass: true, violations: [] };
  const violations: string[] = [];
  const check = (actual: number, limit: number | undefined, label: string) => {
    if (typeof limit === "number" && Number.isFinite(limit) && actual > limit) violations.push(`${label}=${actual} > ${limit}`);
  };
  check(trace.totalTokens, budget.maxTokens, "tokens");
  check(trace.steps, budget.maxSteps, "steps");
  check(trace.toolCalls, budget.maxToolCalls, "toolCalls");
  check(trace.durationMs, budget.maxDurationMs, "durationMs");
  check(trace.approvalsRequested, budget.maxApprovalsRequested, "approvals");
  return { pass: violations.length === 0, violations };
}

function aggregateTrace(attempts: readonly BenchAttemptResult[]) {
  return attempts.reduce((sum, row) => ({
    durationMs: sum.durationMs + row.eval.trace.durationMs,
    totalTokens: sum.totalTokens + row.eval.trace.totalTokens,
    promptTokens: sum.promptTokens + row.eval.trace.promptTokens,
    completionTokens: sum.completionTokens + row.eval.trace.completionTokens,
    toolCalls: sum.toolCalls + row.eval.trace.toolCalls,
    steps: sum.steps + row.eval.trace.steps,
    blockedToolCalls: sum.blockedToolCalls + row.eval.trace.blockedToolCalls,
    timedOutToolCalls: sum.timedOutToolCalls + row.eval.trace.timedOutToolCalls,
    approvalsRequested: sum.approvalsRequested + row.eval.trace.approvalsRequested,
    contextPlans: sum.contextPlans + row.eval.trace.contextPlans,
    contextPlanErrors: sum.contextPlanErrors + row.eval.trace.contextPlanErrors,
    contextFilesSelected: sum.contextFilesSelected + row.eval.trace.contextFilesSelected,
    contextPlanTokens: sum.contextPlanTokens + row.eval.trace.contextPlanTokens,
    contextPlanDurationMs: sum.contextPlanDurationMs + row.eval.trace.contextPlanDurationMs,
    contextExploratorySearchCalls: sum.contextExploratorySearchCalls + row.eval.trace.contextExploratorySearchCalls,
    contextPlannedReadCalls: sum.contextPlannedReadCalls + row.eval.trace.contextPlannedReadCalls,
    contextUnplannedReadCalls: sum.contextUnplannedReadCalls + row.eval.trace.contextUnplannedReadCalls,
    contextPlannedMutationCalls: sum.contextPlannedMutationCalls + row.eval.trace.contextPlannedMutationCalls,
    contextUnplannedMutationCalls: sum.contextUnplannedMutationCalls + row.eval.trace.contextUnplannedMutationCalls,
    contextTopCandidateTouches: sum.contextTopCandidateTouches + row.eval.trace.contextTopCandidateTouches,
  }), { durationMs: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, steps: 0, blockedToolCalls: 0, timedOutToolCalls: 0, approvalsRequested: 0, contextPlans: 0, contextPlanErrors: 0, contextFilesSelected: 0, contextPlanTokens: 0, contextPlanDurationMs: 0, contextExploratorySearchCalls: 0, contextPlannedReadCalls: 0, contextUnplannedReadCalls: 0, contextPlannedMutationCalls: 0, contextUnplannedMutationCalls: 0, contextTopCandidateTouches: 0 });
}

function summarize(cases: readonly BenchCaseResult[]): BenchSummary {
  const attempts = cases.flatMap((row) => row.attempts);
  const trace = aggregateTrace(attempts);
  const totalWeight = cases.reduce((n, row) => n + row.weight, 0);
  const weightedScore = totalWeight ? 100 * cases.reduce((n, row) => n + row.weight * row.successRate, 0) / totalWeight : 0;
  const strictPassed = cases.filter((row) => row.strictPass).length;
  const budgetPasses = attempts.filter((row) => row.budget.pass).length;
  const categories = CATEGORY_ORDER.map((category) => {
    const rows = cases.filter((row) => row.category === category);
    const weight = rows.reduce((n, row) => n + row.weight, 0);
    return {
      category,
      cases: rows.length,
      attempts: rows.reduce((n, row) => n + row.attempts.length, 0),
      weightedScore: weight ? 100 * rows.reduce((n, row) => n + row.weight * row.successRate, 0) / weight : 0,
      strictPassed: rows.filter((row) => row.strictPass).length,
    };
  }).filter((row) => row.cases > 0);
  return {
    cases: cases.length,
    attempts: attempts.length,
    weightedScore,
    strictPassed,
    strictPassRate: cases.length ? strictPassed / cases.length : 0,
    budgetPassRate: attempts.length ? budgetPasses / attempts.length : 0,
    ...trace,
    categories,
  };
}


function reportBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { return "[custom-endpoint]"; }
}

function runId(): string {
  return assertSafeSessionId(`b${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`);
}

function attemptCaseId(caseId: string, attempt: number): string {
  const suffix = `-a${attempt}`;
  return assertSafeSessionId(`${caseId.slice(0, 128 - suffix.length)}${suffix}`);
}

/** Stable opaque id used when private holdout results leave the local runner. */
export function privateBenchCaseId(fingerprint: string, id: string): string {
  return `holdout-${crypto.createHash("sha256").update(`${fingerprint}\0${id}`).digest("hex").slice(0, 12)}`;
}

function reportForPersistence(report: BenchReport): BenchReport {
  if (report.visibility === "public") return report;
  const cases = report.cases.map((row) => {
    const id = privateBenchCaseId(report.suiteFingerprint, row.id);
    return {
      ...row,
      id,
      tags: [],
      source: { kind: row.source.kind },
      attempts: row.attempts.map((attempt) => ({
        ...attempt,
        eval: {
          ...attempt.eval,
          id,
          workspace: "[redacted]",
          sessionDir: "[redacted]",
          sessionId: id,
          stdout: "",
          stderr: "",
          checks: [],
        },
      })),
    };
  });
  return {
    ...report,
    suite: "private-holdout",
    provider: { ...report.provider, baseUrl: "[redacted]" },
    filters: { categories: report.filters.categories },
    cases,
  };
}

function caseSource(definition: BenchCaseDefinition, suite: LoadedBenchSuite, options: BenchRunOptions) {
  if (definition.workspace) {
    return { workspace: definition.workspace, source: { kind: "local" as const }, cleanup: () => {} };
  }
  if (!definition.source) throw new Error(`${definition.id}: 缺少 benchmark source`);
  const materialized = materializeBenchSource(definition.source, path.dirname(suite.manifestPath), options);
  return { ...materialized, source: benchSourceIdentity(definition.source) };
}

/** Run a benchmark suite sequentially for deterministic traces and persist a share-safe report. */
export async function runBenchSuite(suite: LoadedBenchSuite, options: BenchRunOptions): Promise<BenchReport> {
  const repeat = Math.min(20, Math.max(1, Math.floor(options.repeat ?? 1)));
  const selected = filterBenchCases(suite.manifest.cases, options.filters);
  if (!selected.length) throw new Error("benchmark filters 没有选中任何 case");
  fs.mkdirSync(options.outDir, { recursive: true, mode: suite.visibility === "private" ? 0o700 : 0o755 });
  const id = runId();
  const results: BenchCaseResult[] = [];
  for (const definition of selected) {
    const materialized = caseSource(definition, suite, options);
    try {
      const attempts: BenchAttemptResult[] = [];
      for (let attempt = 1; attempt <= repeat; attempt++) {
        const runtimeCaseId = suite.visibility === "private" ? privateBenchCaseId(suite.fingerprint, definition.id) : definition.id;
        const evalId = attemptCaseId(runtimeCaseId, attempt);
        const evaluated = await runEvalCase({ ...definition, workspace: materialized.workspace, id: evalId }, options, id);
        const normalized = { ...evaluated, id: definition.id };
        attempts.push({ attempt, eval: normalized, budget: budgetResult(evaluated.trace, definition.budget) });
        if (!options.keepWorkspaces) fs.rmSync(evaluated.workspace, { recursive: true, force: true });
        if (suite.visibility === "private" && !options.keepPrivateTraces) {
          fs.rmSync(path.dirname(evaluated.sessionDir), { recursive: true, force: true });
        }
      }
      const successes = attempts.filter((row) => row.eval.pass).length;
      results.push({
        id: definition.id,
        source: materialized.source,
        category: definition.category,
        difficulty: definition.difficulty,
        tags: [...(definition.tags ?? [])],
        weight: normalizeWeight(definition.weight),
        successRate: successes / attempts.length,
        strictPass: successes === attempts.length,
        budgetPassRate: attempts.filter((row) => row.budget.pass).length / attempts.length,
        attempts,
      });
    } finally { materialized.cleanup(); }
  }
  const report: BenchReport = {
    version: 2,
    visibility: suite.visibility,
    runId: id,
    suite: suite.manifest.name,
    suiteFingerprint: suite.fingerprint,
    createdAt: new Date().toISOString(),
    provider: { baseUrl: reportBaseUrl(options.baseUrl), model: options.model },
    agent: { contextPlanner: options.contextPlanner ?? "off", contextPlanBudget: options.contextPlanBudget ?? 3500 },
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    repeat,
    filters: options.filters ?? {},
    cases: results,
    summary: summarize(results),
  };
  const persisted = reportForPersistence(report);
  fs.writeFileSync(path.join(options.outDir, `bench-${id}.json`), JSON.stringify(persisted, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(path.join(options.outDir, `bench-${id}.md`), renderBenchReportMarkdown(persisted), { encoding: "utf8", mode: 0o600 });
  return report;
}

/** Render a compact human-readable companion report; JSON remains the machine source of truth. */
export function renderBenchReportMarkdown(report: BenchReport): string {
  const attempts = Math.max(1, report.summary.attempts);
  const lines = [
    `# FreeSeek Bench Report — ${report.suite}`,
    "",
    `- Run: \`${report.runId}\``,
    `- Suite fingerprint: \`${report.suiteFingerprint}\``,
    `- Model: \`${report.provider.model}\``,
    `- Context Planner: **${report.agent.contextPlanner}** (budget ${report.agent.contextPlanBudget})`,
    `- Repeat: ${report.repeat}`,
    `- Weighted score: **${report.summary.weightedScore.toFixed(2)} / 100**`,
    `- Strict pass: **${report.summary.strictPassed}/${report.summary.cases}**`,
    `- Budget pass rate: **${(100 * report.summary.budgetPassRate).toFixed(1)}%**`,
    `- Avg tokens / attempt: ${Math.round(report.summary.totalTokens / attempts)}`,
    `- Avg steps / attempt: ${(report.summary.steps / attempts).toFixed(2)}`,
    `- Avg tool calls / attempt: ${(report.summary.toolCalls / attempts).toFixed(2)}`,
    `- Avg planner tokens / attempt: ${Math.round(report.summary.contextPlanTokens / attempts)}`,
    `- Avg post-plan exploratory search calls / attempt: ${(report.summary.contextExploratorySearchCalls / attempts).toFixed(2)}`,
    `- Avg unplanned reads / attempt: ${(report.summary.contextUnplannedReadCalls / attempts).toFixed(2)}`,
    `- Avg unplanned mutations / attempt: ${(report.summary.contextUnplannedMutationCalls / attempts).toFixed(2)}`,
    `- Planner errors: ${report.summary.contextPlanErrors}`,
    "",
    "## Categories",
    "",
    "| Category | Cases | Weighted score | Strict passed |",
    "| --- | ---: | ---: | ---: |",
    ...report.summary.categories.map((row) => `| ${row.category} | ${row.cases} | ${row.weightedScore.toFixed(2)} | ${row.strictPassed} |`),
    "",
    "## Cases",
    "",
    "| Case | Category | Difficulty | Success | Budget |",
    "| --- | --- | --- | ---: | ---: |",
    ...report.cases.map((row) => `| ${row.id} | ${row.category} | ${row.difficulty} | ${(100 * row.successRate).toFixed(1)}% | ${(100 * row.budgetPassRate).toFixed(1)}% |`),
    "",
  ];
  return lines.join("\n");
}

/** Compare two benchmark reports. Correctness is primary; efficiency deltas remain separate. */
export function compareBenchReports(baseline: BenchReport, candidate: BenchReport): BenchComparison {
  const before = new Map(baseline.cases.map((row) => [row.id, row.successRate]));
  const deltas: BenchCaseDelta[] = candidate.cases.flatMap((row) => {
    const prior = before.get(row.id);
    return prior === undefined ? [] : [{ id: row.id, baseline: prior, candidate: row.successRate, delta: row.successRate - prior }];
  });
  const avg = (value: number, attempts: number) => attempts ? value / attempts : 0;
  const beforeIds = baseline.cases.map((row) => row.id).sort().join("\n");
  const afterIds = candidate.cases.map((row) => row.id).sort().join("\n");
  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    baselinePlanner: baseline.agent?.contextPlanner ?? "off",
    candidatePlanner: candidate.agent?.contextPlanner ?? "off",
    sameSuiteFingerprint: baseline.suiteFingerprint === candidate.suiteFingerprint,
    sameSelection: beforeIds === afterIds,
    sameRepeat: baseline.repeat === candidate.repeat,
    weightedScoreDelta: candidate.summary.weightedScore - baseline.summary.weightedScore,
    strictPassedDelta: candidate.summary.strictPassed - baseline.summary.strictPassed,
    avgTokensPerAttemptDelta: avg(candidate.summary.totalTokens, candidate.summary.attempts) - avg(baseline.summary.totalTokens, baseline.summary.attempts),
    avgStepsPerAttemptDelta: avg(candidate.summary.steps, candidate.summary.attempts) - avg(baseline.summary.steps, baseline.summary.attempts),
    avgToolCallsPerAttemptDelta: avg(candidate.summary.toolCalls, candidate.summary.attempts) - avg(baseline.summary.toolCalls, baseline.summary.attempts),
    avgDurationMsPerAttemptDelta: avg(candidate.summary.durationMs, candidate.summary.attempts) - avg(baseline.summary.durationMs, baseline.summary.attempts),
    avgContextExploratorySearchCallsDelta: avg(candidate.summary.contextExploratorySearchCalls, candidate.summary.attempts) - avg(baseline.summary.contextExploratorySearchCalls, baseline.summary.attempts),
    avgContextUnplannedReadCallsDelta: avg(candidate.summary.contextUnplannedReadCalls, candidate.summary.attempts) - avg(baseline.summary.contextUnplannedReadCalls, baseline.summary.attempts),
    avgContextUnplannedMutationCallsDelta: avg(candidate.summary.contextUnplannedMutationCalls, candidate.summary.attempts) - avg(baseline.summary.contextUnplannedMutationCalls, baseline.summary.attempts),
    improvements: deltas.filter((row) => row.delta > 0).sort((a, b) => b.delta - a.delta),
    regressions: deltas.filter((row) => row.delta < 0).sort((a, b) => a.delta - b.delta),
  };
}


/** Backward-compatible built-in fixture validator export. */
export { validateBuiltInFixtures } from "./bench-validate";
