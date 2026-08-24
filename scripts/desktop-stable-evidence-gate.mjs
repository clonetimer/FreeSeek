#!/usr/bin/env node
/** Require a fully audited RC and fresh Stable preflight before Desktop 0.20 Stable promotion. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDesktopStablePromotion } from "./lib/desktop-stable-promotion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = { installer: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rc-summary") out.rcSummary = argv[++i];
    else if (arg === "--stable-preflight") out.stablePreflight = argv[++i];
    else if (arg === "--installer-report") out.installer.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") { console.log("Usage: node scripts/desktop-stable-evidence-gate.mjs --rc-summary rc.json --stable-preflight stable.json --installer-report target.json..."); process.exit(0); }
    else fail(`unknown option: ${arg}`);
  }
  if (!out.rcSummary || !out.stablePreflight) fail("--rc-summary and --stable-preflight are required");
  return out;
}
function readJson(file, label) {
  const absolute = path.resolve(file); if (!fs.existsSync(absolute)) throw new Error(`${label} missing: ${absolute}`);
  const stat = fs.lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink regular file`);
  try { return JSON.parse(fs.readFileSync(absolute, "utf8")); } catch { throw new Error(`${label} must be valid JSON`); }
}
function gitCommit() { const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }); if (r.status !== 0) throw new Error("Unable to resolve current Git commit"); return String(r.stdout ?? "").trim(); }
try {
  const args = parseArgs(process.argv.slice(2));
  const candidateVersion = String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  const candidateCommit = gitCommit();
  const rcSummary = readJson(args.rcSummary, "RC evidence summary"), stableSummary = readJson(args.stablePreflight, "Stable aggregate preflight");
  const installerReports = args.installer.map((file) => readJson(file, `Stable installer report ${file}`));
  const result = validateDesktopStablePromotion({ stableSummary, rcSummary, installerReports, candidateVersion, candidateCommit });
  const summary = { schemaVersion: 1, kind: "freesek-desktop-stable-evidence-gate", version: candidateVersion, gitCommit: candidateCommit, rcVersion: result.rcVersion, passed: result.stableEligible, stableEligible: result.stableEligible, errors: result.errors };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n"); if (!result.stableEligible) process.exitCode = 1;
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
