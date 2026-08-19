#!/usr/bin/env node
/**
 * Safe DeepSeek Context Planner A/B wrapper.
 * API keys are accepted only from environment variables and are never placed on argv.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "freeseek-bench.js");
const DEFAULT_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

function usage() {
  return [
    "FreeSeek DeepSeek Context A/B",
    "",
    "  DEEPSEEK_API_KEY=<secret> npm run bench:deepseek-context -- [options]",
    "",
    "Options:",
    "  --model <id>          default deepseek-v4-flash",
    "  --repeat <n>          default 3",
    "  --budget <tokens>     default 1500",
    "  --baseline <planner>  default v1.1",
    "  --candidate <planner> default v1.2",
    "  --all-public          run all public cases instead of context only",
    "  --real                run pinned real-v1 cases",
    "  --out <dir>           report directory",
    "  --no-build            require an existing dist/freeseek-bench.js",
    "  --dry-run             print a sanitized plan without network/model calls",
    "",
    "Security: --api-key is intentionally unsupported; use DEEPSEEK_API_KEY/FREESEEK_API_KEY.",
  ].join("\n");
}

function value(argv, i, name) {
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} missing value`);
  return v;
}

function parse(argv) {
  const out = {
    baseUrl: process.env.FREESEEK_BASE_URL || DEFAULT_BASE,
    model: process.env.FREESEEK_MODEL || DEFAULT_MODEL,
    repeat: 3,
    budget: 1500,
    baseline: "v1.1",
    candidate: "v1.2",
    allPublic: false,
    real: false,
    noBuild: false,
    dryRun: false,
    outDir: join(homedir(), ".freesek", "bench", "deepseek-context-ab"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(0); }
    if (arg === "--all-public") { out.allPublic = true; continue; }
    if (arg === "--real") { out.real = true; continue; }
    if (arg === "--no-build") { out.noBuild = true; continue; }
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (["--model", "--repeat", "--budget", "--baseline", "--candidate", "--out"].includes(arg)) {
      const v = value(argv, i, arg); i++;
      if (arg === "--model") out.model = v;
      else if (arg === "--repeat") out.repeat = Number(v);
      else if (arg === "--budget") out.budget = Number(v);
      else if (arg === "--baseline") out.baseline = v;
      else if (arg === "--candidate") out.candidate = v;
      else if (arg === "--out") out.outDir = resolve(v);
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(out.repeat) || out.repeat < 1 || out.repeat > 20) throw new Error("--repeat must be 1..20");
  if (!Number.isInteger(out.budget) || out.budget < 256 || out.budget > 12000) throw new Error("--budget must be 256..12000");
  const planners = new Set(["off", "v1", "v1.1", "v1.2"]);
  if (!planners.has(out.baseline) || !planners.has(out.candidate)) throw new Error("planner must be off|v1|v1.1|v1.2");
  return out;
}

function run(cmd, args, env = process.env) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env, shell: process.platform === "win32" });
}

function main() {
  let cfg;
  try { cfg = parse(process.argv.slice(2)); }
  catch (error) { console.error(String(error?.message || error)); console.error("\n" + usage()); process.exit(2); }

  const key = process.env.DEEPSEEK_API_KEY || process.env.FREESEEK_API_KEY || "";
  const plan = {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    baselinePlanner: cfg.baseline,
    candidatePlanner: cfg.candidate,
    repeat: cfg.repeat,
    contextPlanBudget: cfg.budget,
    suite: cfg.real ? "real-v1" : (cfg.allPublic ? "public-v1/all" : "public-v1/context"),
    outDir: cfg.outDir,
    apiKey: key ? "<environment:configured>" : "<environment:missing>",
  };
  if (cfg.dryRun) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (!key) {
    console.error("Missing DEEPSEEK_API_KEY/FREESEEK_API_KEY. The wrapper intentionally does not accept --api-key.");
    process.exit(2);
  }

  if (!cfg.noBuild) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const built = run(npm, ["run", "compile"]);
    if ((built.status ?? 1) !== 0) process.exit(built.status ?? 1);
  } else if (!existsSync(DIST)) {
    console.error("--no-build was set but dist/freeseek-bench.js is missing");
    process.exit(2);
  }

  mkdirSync(cfg.outDir, { recursive: true });
  const args = [
    DIST, "ab-context",
    "--base-url", cfg.baseUrl,
    "--model", cfg.model,
    "--repeat", String(cfg.repeat),
    "--context-plan-budget", String(cfg.budget),
    "--baseline-planner", cfg.baseline,
    "--candidate-planner", cfg.candidate,
    "--out", cfg.outDir,
  ];
  if (cfg.real) args.push("--real", "--source-cache", join(homedir(), ".freesek", "bench-sources"));
  else if (!cfg.allPublic) args.push("--category", "context");

  const env = { ...process.env, FREESEEK_API_KEY: key, FREESEEK_BASE_URL: cfg.baseUrl, FREESEEK_MODEL: cfg.model };
  const result = run(process.execPath, args, env);
  process.exit(result.status ?? 1);
}

main();
