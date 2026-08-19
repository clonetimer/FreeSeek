/** Static benchmark self-validation: pristine must fail and optional gold must pass. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { EvalCheck } from "./eval";
import type { BenchCaseDefinition, LoadedBenchSuite } from "./bench";
import { materializeBenchSource, type BenchSourceOptions, type MaterializedBenchSource } from "./bench-source";

export interface BenchFixtureValidation {
  cases: number;
  pristineChecks: number;
  goldChecks: number;
  failures: string[];
}

type StaticVerifier = Extract<EvalCheck, { type: "command" | "host_node" }>;

function verifierEnv(): NodeJS.ProcessEnv {
  const keys = ["PATH", "PATHEXT", "SystemRoot", "ComSpec", "WINDIR", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function runVerifier(workspace: string, check: StaticVerifier): { ok: boolean; detail: string } {
  if (check.type === "host_node") {
    const proc = spawnSync(process.execPath, [check.script, workspace, ...(check.args ?? [])], {
      cwd: workspace, shell: false, windowsHide: true, encoding: "utf8", env: verifierEnv(),
      timeout: Math.min(30_000, Math.max(100, check.timeoutMs ?? 10_000)), maxBuffer: 2 * 1024 * 1024,
    });
    const ok = proc.status === (check.exitCode ?? 0) && (!check.stdoutIncludes || String(proc.stdout ?? "").includes(check.stdoutIncludes));
    return { ok, detail: `exit=${proc.status}; ${String(proc.stderr ?? "").slice(0, 300)}` };
  }
  const cwd = path.resolve(workspace, check.cwd ?? ".");
  const rel = path.relative(workspace, cwd);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ok: false, detail: "verifier cwd 越界" };
  const proc = spawnSync(check.argv[0], check.argv.slice(1), {
    cwd, shell: false, windowsHide: true, encoding: "utf8", env: verifierEnv(),
    timeout: Math.min(30_000, Math.max(100, check.timeoutMs ?? 10_000)), maxBuffer: 2 * 1024 * 1024,
  });
  const ok = proc.status === (check.exitCode ?? 0) && (!check.stdoutIncludes || String(proc.stdout ?? "").includes(check.stdoutIncludes));
  return { ok, detail: `exit=${proc.status}; ${String(proc.stderr ?? "").slice(0, 300)}` };
}

function localSource(row: BenchCaseDefinition): MaterializedBenchSource | undefined {
  if (!row.workspace) return undefined;
  return { workspace: row.workspace, sourceKind: "local", cleanup: () => {} };
}

function baseSource(row: BenchCaseDefinition, suite: LoadedBenchSuite, options: BenchSourceOptions): MaterializedBenchSource {
  const local = localSource(row);
  if (local) return local;
  if (!row.source) throw new Error(`${row.id}: 缺少 source`);
  return materializeBenchSource(row.source, path.dirname(suite.manifestPath), options);
}

function goldSource(row: BenchCaseDefinition, suite: LoadedBenchSuite, options: BenchSourceOptions): MaterializedBenchSource {
  if (row.source?.kind === "git") {
    if (!row.source.goldCommit) throw new Error(`${row.id}: git source 缺少 goldCommit`);
    return materializeBenchSource(row.source, path.dirname(suite.manifestPath), options, row.source.goldCommit);
  }
  const base = baseSource(row, suite, options);
  const overlay = path.join(path.dirname(suite.manifestPath), "gold", row.id);
  if (!fs.existsSync(overlay) || !fs.statSync(overlay).isDirectory()) {
    base.cleanup();
    throw new Error(`${row.id}: 缺少 gold overlay`);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `freesek-bench-gold-${row.id}-`));
  fs.cpSync(base.workspace, temp, { recursive: true, dereference: false });
  fs.cpSync(overlay, temp, { recursive: true, force: true, dereference: false });
  base.cleanup();
  return { workspace: temp, sourceKind: "local", cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function staticChecks(row: BenchCaseDefinition): StaticVerifier[] {
  return (row.checks ?? []).filter((check): check is StaticVerifier => check.type === "command" || check.type === "host_node");
}

/** Validate suite fixtures without invoking an LLM. Pristine must fail at least one static verifier; gold optionally must pass all. */
export function validateBenchFixtures(
  suite: LoadedBenchSuite,
  options: BenchSourceOptions = {},
  includeGold = false
): BenchFixtureValidation {
  const failures: string[] = [];
  let pristineChecks = 0;
  let goldChecks = 0;
  for (const row of suite.manifest.cases) {
    const checks = staticChecks(row);
    if (!checks.length) { failures.push(`${row.id}: 没有 command/host_node static verifier`); continue; }
    let base: MaterializedBenchSource | undefined;
    try {
      base = baseSource(row, suite, options);
      const results = checks.map((check) => { pristineChecks++; return runVerifier(base!.workspace, check); });
      if (results.every((result) => result.ok)) failures.push(`${row.id}: pristine source 已通过全部 verifier，任务不是有效回归题`);
    } catch (error: any) {
      failures.push(`${row.id}: pristine source ${error?.message ?? String(error)}`);
    } finally { base?.cleanup(); }
    if (!includeGold) continue;
    let gold: MaterializedBenchSource | undefined;
    try {
      gold = goldSource(row, suite, options);
      for (const check of checks) {
        goldChecks++;
        const result = runVerifier(gold.workspace, check);
        if (!result.ok) failures.push(`${row.id}: gold verifier ${result.detail}`);
      }
    } catch (error: any) {
      failures.push(`${row.id}: gold source ${error?.message ?? String(error)}`);
    } finally { gold?.cleanup(); }
  }
  return { cases: suite.manifest.cases.length, pristineChecks, goldChecks, failures };
}

/** Backwards-compatible helper for the built-in v1 public regression suite. */
export function validateBuiltInFixtures(suite: LoadedBenchSuite): BenchFixtureValidation {
  return validateBenchFixtures(suite, {}, true);
}
