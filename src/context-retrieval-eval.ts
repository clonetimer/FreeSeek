/** Deterministic Context Planner retrieval benchmark used before expensive model-level A/B runs. */
import * as fs from "fs";
import * as path from "path";
import {
  buildRepoMap,
  planRepositoryContext,
  type ContextPlannerVariant,
  type RepoMap,
} from "./context-planner";

export type ContextRetrievalDiagnosis = "hit" | "ranking_miss" | "dependency_miss" | "budget_overflow" | "retrieval_miss";

export interface ContextRetrievalProbe {
  id: string;
  workspace: string;
  query: string;
  targets: string[];
  tags?: string[];
}

export interface ContextRetrievalManifest {
  version: 1;
  name: string;
  probes: ContextRetrievalProbe[];
}

export interface ContextRetrievalProbeResult {
  id: string;
  tags: string[];
  bestRank: number | null;
  reciprocalRank: number;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
  diagnosis: ContextRetrievalDiagnosis;
  selected: string[];
  estimatedTokens: number;
  indexedFiles: number;
  durationMs: number;
}

export interface ContextRetrievalVariantReport {
  variant: ContextPlannerVariant;
  probes: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  meanReciprocalRank: number;
  avgEstimatedTokens: number;
  avgSelectedFiles: number;
  avgDurationMs: number;
  diagnoses: Record<ContextRetrievalDiagnosis, number>;
  results: ContextRetrievalProbeResult[];
}

export interface ContextRetrievalExperimentReport {
  version: 1;
  suite: string;
  createdAt: string;
  budgetTokens: number;
  variants: ContextRetrievalVariantReport[];
}


/** Built-in retrieval-only probe suite derived from the public context regression fixtures. */
export function builtInContextRetrievalManifestPath(): string {
  const packaged = path.resolve(__dirname, "..", "benchmarks", "v1", "context-retrieval.json");
  const development = path.resolve(process.cwd(), "benchmarks", "v1", "context-retrieval.json");
  return fs.existsSync(packaged) ? packaged : development;
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveWorkspace(manifestPath: string, workspace: string): string {
  const manifestDir = fs.realpathSync(path.dirname(manifestPath));
  const absolute = path.resolve(manifestDir, workspace);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new Error(`context retrieval workspace 不存在：${workspace}`);
  const real = fs.realpathSync(absolute);
  const rel = path.relative(manifestDir, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`context retrieval workspace 越界：${workspace}`);
  return real;
}

/** Load a retrieval-only suite. Targets are evaluator metadata and are never sent to the model. */
export function loadContextRetrievalManifest(manifestPath: string): ContextRetrievalManifest {
  const absolute = path.resolve(manifestPath);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as ContextRetrievalManifest;
  if (parsed.version !== 1 || !parsed.name?.trim() || !Array.isArray(parsed.probes) || !parsed.probes.length) {
    throw new Error("context retrieval manifest 必须是 version=1，并包含 name/probes");
  }
  const seen = new Set<string>();
  parsed.probes = parsed.probes.map((probe) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(probe.id) || seen.has(probe.id)) throw new Error(`context retrieval probe id 非法/重复：${probe.id}`);
    seen.add(probe.id);
    if (!probe.query?.trim() || !Array.isArray(probe.targets) || !probe.targets.length) throw new Error(`${probe.id}: query/targets 不能为空`);
    const workspace = resolveWorkspace(absolute, probe.workspace);
    const targets = probe.targets.map(normalizeRel);
    for (const target of targets) {
      const file = path.resolve(workspace, target);
      const rel = path.relative(workspace, file);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`${probe.id}: target 不存在或越界：${target}`);
      }
    }
    return { ...probe, workspace, targets, tags: [...(probe.tags ?? [])] };
  });
  return parsed;
}

function directlyRelated(map: RepoMap, selected: string[], targets: string[]): boolean {
  const byPath = new Map(map.files.map((file) => [file.path, file]));
  const selectedSet = new Set(selected);
  const targetSet = new Set(targets);
  for (const target of targets) {
    const entry = byPath.get(target);
    if (entry?.resolvedImports.some((dep) => selectedSet.has(dep))) return true;
  }
  for (const selectedPath of selected) {
    const entry = byPath.get(selectedPath);
    if (entry?.resolvedImports.some((dep) => targetSet.has(dep))) return true;
  }
  return false;
}

function diagnose(
  map: RepoMap,
  selected: string[],
  expanded: string[],
  targets: string[],
  bestRank: number | null
): ContextRetrievalDiagnosis {
  if (bestRank !== null && bestRank === 1) return "hit";
  if (bestRank !== null) return "ranking_miss";
  if (!targets.some((target) => map.files.some((file) => file.path === target))) return "retrieval_miss";
  if (expanded.some((candidate) => targets.includes(candidate))) return "budget_overflow";
  if (directlyRelated(map, selected, targets)) return "dependency_miss";
  return "ranking_miss";
}

function summarize(variant: ContextPlannerVariant, results: ContextRetrievalProbeResult[]): ContextRetrievalVariantReport {
  const total = Math.max(1, results.length);
  const diagnoses: Record<ContextRetrievalDiagnosis, number> = {
    hit: 0, ranking_miss: 0, dependency_miss: 0, budget_overflow: 0, retrieval_miss: 0,
  };
  for (const result of results) diagnoses[result.diagnosis]++;
  const avg = (fn: (row: ContextRetrievalProbeResult) => number) => results.reduce((sum, row) => sum + fn(row), 0) / total;
  return {
    variant,
    probes: results.length,
    hitAt1: results.filter((row) => row.hitAt1).length / total,
    hitAt3: results.filter((row) => row.hitAt3).length / total,
    hitAt5: results.filter((row) => row.hitAt5).length / total,
    meanReciprocalRank: avg((row) => row.reciprocalRank),
    avgEstimatedTokens: avg((row) => row.estimatedTokens),
    avgSelectedFiles: avg((row) => row.selected.length),
    avgDurationMs: avg((row) => row.durationMs),
    diagnoses,
    results,
  };
}

/** Run deterministic planner retrieval/presentation experiments without spending model tokens. */
export function runContextRetrievalExperiment(
  manifestPath: string,
  variants: ContextPlannerVariant[] = ["v1", "v1.1", "v1.2"],
  budgetTokens = 1500
): ContextRetrievalExperimentReport {
  const manifest = loadContextRetrievalManifest(manifestPath);
  const reports = variants.map((variant) => {
    const results = manifest.probes.map((probe): ContextRetrievalProbeResult => {
      const map = buildRepoMap(probe.workspace);
      const plan = planRepositoryContext(probe.workspace, probe.query, { mode: variant, budgetTokens, maxFiles: 6 });
      const selected = plan.selected.map((file) => file.path);
      const ranks = probe.targets.map((target) => selected.indexOf(target) + 1).filter((rank) => rank > 0);
      const bestRank = ranks.length ? Math.min(...ranks) : null;
      const expanded = planRepositoryContext(probe.workspace, probe.query, { mode: variant, budgetTokens: 12_000, maxFiles: 20, dependencyDepth: 3 })
        .selected.map((file) => file.path);
      return {
        id: probe.id,
        tags: [...(probe.tags ?? [])],
        bestRank,
        reciprocalRank: bestRank ? 1 / bestRank : 0,
        hitAt1: bestRank === 1,
        hitAt3: bestRank !== null && bestRank <= 3,
        hitAt5: bestRank !== null && bestRank <= 5,
        diagnosis: diagnose(map, selected, expanded, probe.targets, bestRank),
        selected,
        estimatedTokens: plan.estimatedTokens,
        indexedFiles: plan.indexedFiles,
        durationMs: plan.durationMs,
      };
    });
    return summarize(variant, results);
  });
  return { version: 1, suite: manifest.name, createdAt: new Date().toISOString(), budgetTokens, variants: reports };
}

/** Human-readable planner retrieval report; model-level Bench remains the authority for default-on decisions. */
export function renderContextRetrievalReport(report: ContextRetrievalExperimentReport): string {
  const lines = [
    `# FreeSeek Context Retrieval Experiment — ${report.suite}`,
    "",
    `Budget: ${report.budgetTokens} tokens`,
    "",
    "| Variant | Hit@1 | Hit@3 | MRR | Avg planner tokens | Ranking misses |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.variants.map((row) => `| ${row.variant} | ${(100 * row.hitAt1).toFixed(1)}% | ${(100 * row.hitAt3).toFixed(1)}% | ${row.meanReciprocalRank.toFixed(3)} | ${Math.round(row.avgEstimatedTokens)} | ${row.diagnoses.ranking_miss} |`),
    "",
    "Retrieval-only results decide *what to improve*, not whether a planner becomes default. Promotion still requires model-level Public + Private + Real A/B.",
    "",
  ];
  return lines.join("\n");
}
