#!/usr/bin/env node
/**
 * FreeSeek 一体化工程门禁（零依赖，Node 18+）。
 * 用法：node scripts/check.mjs
 *   1) source typecheck —— tsc -p tsconfig.check.json（硬门禁）
 *   2) test typecheck   —— tsc -p tsconfig.tests.json（硬门禁）
 *   3) hygiene          —— src TypeScript 文件行数上限
 *   4) runtime-boundary —— raw body 只能由 ToolRegistry 持有，Registry body 只能由 ToolRuntime 调用
 *   5) benchmark-boundary —— 私有题库不入仓，real-repo 必须 immutable pin
 *   6) export-jsdoc     —— 顶层导出符号的 JSDoc 覆盖检查（warning）
 * 借鉴：deepseek-harness（typecheck/lint/hygiene/duplication 多门禁）、codex（模块行数上限）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DEFAULT_MAX_LINES = 600;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 1) 类型门禁：tsc --strict 全树 0 错误。 */
function typecheck(project) {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", project], {
    cwd: ROOT,
    stdio: "inherit",
  });
  return r.status === 0;
}

/** 2) 行数上限：文件头 `// check:max-lines N` 覆盖默认值（技术债豁免，拆分后必须减小）。 */
function hygiene() {
  const files = walk(SRC);
  const problems = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const head = src.split("\n").slice(0, 20).join("\n");
    const m = head.match(/\/\/\s*check:max-lines\s+(\d+)/);
    const limit = m ? parseInt(m[1], 10) : DEFAULT_MAX_LINES;
    const lines = src.split(/\r?\n/).length;
    if (lines > limit) problems.push(`${relative(ROOT, f)}: ${lines} 行 > 上限 ${limit}`);
  }
  return problems;
}


/** 3) Runtime 边界：raw body 只能进入 Registry；Registry.executeBody 只能由 ToolRuntime 调用。 */
function runtimeBoundary() {
  const files = walk(SRC);
  const problems = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    const src = readFileSync(f, "utf8");
    if (rel !== "src/tool-registry.ts" && rel !== "src/tools.ts" && /\bexecuteToolBody\b/.test(src)) {
      problems.push(`${rel}: 禁止直接引用 executeToolBody；raw body 只能注册进 ToolRegistry`);
    }
    if (rel !== "src/tool-runtime.ts" && rel !== "src/tool-registry.ts" && /\.executeBody\s*\(/.test(src)) {
      problems.push(`${rel}: 禁止直接执行 ToolRegistry body；请通过 ToolRuntime.execute()`);
    }
  }
  return problems;
}


/** 5) Benchmark 边界：private holdout 不进入仓库，real pack 只能使用完整 HTTPS commit pin。 */
function benchmarkBoundary() {
  const problems = [];
  for (const rel of ["benchmarks/private", ".freesek-holdout"]) {
    const dir = join(ROOT, rel);
    if (existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length) {
      problems.push(`${rel}: private holdout 不能进入公开源码/发布树`);
    }
  }
  const manifestFile = join(ROOT, "benchmarks", "real-v1", "manifest.json");
  if (existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      for (const row of manifest.cases ?? []) {
        const source = row?.source;
        if (source?.kind !== "git") { problems.push(`${row?.id ?? "?"}: real-v1 必须使用 git source`); continue; }
        if (!/^https:\/\//.test(source.url ?? "")) problems.push(`${row.id}: real-v1 只允许 HTTPS repository URL`);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.commit ?? "")) problems.push(`${row.id}: commit 必须是完整 immutable SHA`);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.goldCommit ?? "")) problems.push(`${row.id}: goldCommit 必须是完整 immutable SHA`);
      }
    } catch (error) { problems.push(`benchmarks/real-v1/manifest.json 无法解析：${error?.message ?? error}`); }
  }
  return problems;
}

/** 6) 导出符号 JSDoc 覆盖（启发式：export 声明前 3 行内有 /*…*\/ 或 // 注释即视为已注释）。 */
function exportJsdoc() {
  const files = walk(SRC);
  const missing = [];
  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w+)/,
    /^export\s+const\s+(\w+)/,
    /^export\s+class\s+(\w+)/,
    /^export\s+(?:abstract\s+)?class\s+(\w+)/,
  ];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let name = null;
      for (const re of patterns) {
        const m = lines[i].match(re);
        if (m) { name = m[1]; break; }
      }
      if (!name) continue;
      const near = lines.slice(Math.max(0, i - 3), i).join("\n");
      if (!/\*\//.test(near) && !/^\s*\/\//m.test(near)) {
        missing.push(`${relative(ROOT, f)}:${i + 1} export ${name} 缺 JSDoc`);
      }
    }
  }
  return missing;
}

function main() {
  let fail = false;
  console.log("── FreeSeek check ───────────────────────────────");
  console.log("1/6 source typecheck …");
  const sourceTypeOk = typecheck("tsconfig.check.json");
  if (!sourceTypeOk) { fail = true; console.log("  ✗ source typecheck 失败"); }
  else console.log("  ✓ source typecheck 通过");

  console.log("2/6 test typecheck …");
  const testTypeOk = typecheck("tsconfig.tests.json");
  if (!testTypeOk) { fail = true; console.log("  ✗ test typecheck 失败"); }
  else console.log("  ✓ test typecheck 通过");

  console.log("3/6 hygiene（行数上限）…");
  const problems = hygiene();
  if (problems.length) {
    fail = true;
    for (const p of problems) console.log("  ✗ " + p);
    console.log("  提示：给超限文件头部加 `// check:max-lines N` 临时豁免，并在拆分重构后减小/移除。");
  } else console.log("  ✓ 全部文件在行数上限内");

  console.log("4/6 runtime boundary …");
  const boundary = runtimeBoundary();
  if (boundary.length) {
    fail = true;
    for (const p of boundary) console.log("  ✗ " + p);
  } else console.log("  ✓ raw body → ToolRegistry → ToolRuntime 边界完整");

  console.log("5/6 benchmark boundary …");
  const benchBoundary = benchmarkBoundary();
  if (benchBoundary.length) {
    fail = true;
    for (const p of benchBoundary) console.log("  ✗ " + p);
  } else console.log("  ✓ private holdout / real-repo source 边界完整");

  console.log("6/6 export JSDoc …");
  const missing = exportJsdoc();
  if (missing.length) {
    console.log(`  ⚠ ${missing.length} 个导出缺 JSDoc（建议补齐，不阻塞）`);
    for (const m of missing.slice(0, 10)) console.log("    - " + m);
    if (missing.length > 10) console.log(`    … 其余 ${missing.length - 10} 个省略`);
  } else console.log("  ✓ 导出符号均带 JSDoc");

  console.log(fail ? "✗ check 未通过" : "✓ check 全部通过");
  process.exit(fail ? 1 : 0);
}

main();
