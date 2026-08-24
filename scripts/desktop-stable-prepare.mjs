#!/usr/bin/env node
/** Prepare synchronized Stable candidate metadata from an already audited/tagged direct RC. Dry-run by default. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planStableMetadataPromotion } from "./lib/desktop-stable-metadata-promotion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = { rootPackage: "package.json", rootLock: "package-lock.json", desktopPackage: "apps/desktop/package.json", projectState: "docs/project/project-state.json" };
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function git(args) { const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); if (result.status !== 0) fail(`git ${args.join(" ")} failed`); return String(result.stdout ?? "").trim(); }
function parseArgs(argv) {
  const out = { apply: false, version: "", rcSummary: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") out.version = argv[++i] ?? "";
    else if (arg === "--rc-summary") out.rcSummary = argv[++i] ?? "";
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--help" || arg === "-h") { console.log("Usage: npm run desktop:stable:prepare -- --version X.Y.Z --rc-summary rc-evidence.json [--apply]"); console.log("Default is dry-run. The audited RC tag must point at current HEAD. This command never commits or tags."); process.exit(0); }
    else fail(`unknown option: ${arg}`);
  }
  if (!out.version) fail("--version is required"); if (!out.rcSummary) fail("--rc-summary is required"); return out;
}
function readJson(relativeOrAbsolute) { const file = path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(ROOT, relativeOrAbsolute); return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJson(relative, value) { fs.writeFileSync(path.join(ROOT, relative), JSON.stringify(value, null, 2) + "\n", "utf8"); }

const args = parseArgs(process.argv.slice(2));
if (git(["status", "--porcelain"])) fail("Stable candidate preparation requires a clean committed RC worktree");
const state = readJson(FILES.projectState), branch = git(["branch", "--show-current"]), expectedBranch = String(state?.activeDevelopment?.branch ?? "");
if (!expectedBranch || branch !== expectedBranch) fail(`Stable candidate preparation must run on ${expectedBranch || "the active development branch"}; current=${branch || "<detached>"}`);
if (git(["tag", "--list", `v${args.version}`])) fail(`target Stable tag v${args.version} already exists`);
const currentVersion = String(readJson(FILES.rootPackage).version), head = git(["rev-parse", "HEAD"]), rcTag = `v${currentVersion}`;
if (!git(["tag", "--list", rcTag])) fail(`audited direct RC tag ${rcTag} does not exist`);
const rcTagCommit = git(["rev-list", "-n", "1", rcTag]); if (rcTagCommit !== head) fail(`audited direct RC tag ${rcTag} must point at current HEAD`);
const rcSummary = readJson(path.resolve(args.rcSummary));
if (rcSummary?.schemaVersion !== 1 || rcSummary.kind !== "freesek-desktop-rc-evidence-gate" || rcSummary.passed !== true || rcSummary.rcEligible !== true || rcSummary.preflightOnly !== false || rcSummary.version !== currentVersion || rcSummary.gitCommit !== head || !Array.isArray(rcSummary.errors) || rcSummary.errors.length) fail("--rc-summary is not the audited eligible RC evidence for current HEAD");
const plan = planStableMetadataPromotion({ rootPackage: readJson(FILES.rootPackage), rootLock: readJson(FILES.rootLock), desktopPackage: readJson(FILES.desktopPackage), projectState: state, targetVersion: args.version });
if (!plan.valid) fail(plan.errors.join("; "));
const summary = { schemaVersion: 1, kind: "freesek-desktop-stable-metadata-plan", branch, auditedRcVersion: currentVersion, auditedRcCommit: head, auditedRcTag: rcTag, targetVersion: plan.targetVersion, apply: args.apply, files: Object.values(FILES), nextSteps: ["review synchronized metadata diff", "commit Stable candidate metadata without tagging", "regenerate candidate-bound aggregate/native/ACP evidence", "run desktop:stable:evidence:gate", "tag only after stableEligible=true"] };
if (args.apply) for (const [key, relative] of Object.entries(FILES)) writeJson(relative, plan.documents[key]);
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
