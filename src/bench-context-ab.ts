/** Context Planner A/B orchestration over explicit planner variants. */
import * as fs from "fs";
import * as path from "path";
import type { ContextPlannerMode } from "./context-planner";
import {
  compareBenchReports,
  privateBenchCaseId,
  runBenchSuite,
  type BenchCaseDelta,
  type BenchComparison,
  type BenchRunOptions,
  type LoadedBenchSuite,
  type BenchReport,
} from "./bench";

/** Result of one paired context-planner benchmark experiment. */
export interface ContextPlannerAbResult {
  baseline: BenchReport;
  candidate: BenchReport;
  comparison: BenchComparison;
  comparisonPath: string;
}

function shareSafeDelta(suite: LoadedBenchSuite, row: BenchCaseDelta): BenchCaseDelta {
  if (suite.visibility !== "private") return row;
  return { ...row, id: privateBenchCaseId(suite.fingerprint, row.id) };
}

function shareSafeComparison(suite: LoadedBenchSuite, comparison: BenchComparison): BenchComparison {
  if (suite.visibility !== "private") return comparison;
  return {
    ...comparison,
    improvements: comparison.improvements.map((row) => shareSafeDelta(suite, row)),
    regressions: comparison.regressions.map((row) => shareSafeDelta(suite, row)),
  };
}

/**
 * Run the exact same suite/filter/repeat twice with explicit planner variants.
 * Correctness is never hidden behind an efficiency score; the persisted comparison is share-safe.
 */
export async function runContextPlannerAb(
  suite: LoadedBenchSuite,
  options: BenchRunOptions & { baselinePlanner?: ContextPlannerMode; candidatePlanner?: ContextPlannerMode }
): Promise<ContextPlannerAbResult> {
  const baselinePlanner = options.baselinePlanner ?? "off";
  const candidatePlanner = options.candidatePlanner ?? "v1";
  if (baselinePlanner === candidatePlanner) throw new Error("Context Planner A/B baseline 与 candidate 不能相同");
  const baseline = await runBenchSuite(suite, { ...options, contextPlanner: baselinePlanner });
  const candidate = await runBenchSuite(suite, { ...options, contextPlanner: candidatePlanner });
  const comparison = compareBenchReports(baseline, candidate);
  if (!comparison.sameSuiteFingerprint || !comparison.sameSelection || !comparison.sameRepeat) {
    throw new Error("Context Planner A/B 两侧 suite/selection/repeat 不一致，拒绝比较");
  }
  const persisted = shareSafeComparison(suite, comparison);
  fs.mkdirSync(options.outDir, { recursive: true, mode: suite.visibility === "private" ? 0o700 : 0o755 });
  const comparisonPath = path.join(
    options.outDir,
    `context-ab-${baseline.runId}-to-${candidate.runId}.json`
  );
  fs.writeFileSync(comparisonPath, JSON.stringify(persisted, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return { baseline, candidate, comparison, comparisonPath };
}
