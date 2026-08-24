#!/usr/bin/env node
/** Prepare synchronized RC candidate metadata. Dry-run by default; never commits or tags. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planRcMetadataPromotion } from "./lib/desktop-rc-promotion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = {
  rootPackage: "package.json",
  rootLock: "package-lock.json",
  desktopPackage: "apps/desktop/package.json",
  projectState: "docs/project/project-state.json",
};
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed`);
  return String(result.stdout ?? "").trim();
}
function parseArgs(argv) {
  const out = { apply: false, version: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") out.version = argv[++i] ?? "";
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run desktop:rc:prepare -- --version X.Y.Z-rc.N [--apply]");
      console.log("Default is dry-run. --apply edits synchronized version metadata only; it never commits or tags.");
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  if (!out.version) fail("--version is required");
  return out;
}
function readJson(relative) { return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8")); }
function writeJson(relative, value) { fs.writeFileSync(path.join(ROOT, relative), JSON.stringify(value, null, 2) + "\n", "utf8"); }

const args = parseArgs(process.argv.slice(2));
if (git(["status", "--porcelain"])) fail("RC candidate preparation requires a clean committed worktree");
const state = readJson(FILES.projectState);
const expectedBranch = String(state?.activeDevelopment?.branch ?? "");
const branch = git(["branch", "--show-current"]);
if (!expectedBranch || branch !== expectedBranch) fail(`RC candidate preparation must run on ${expectedBranch || "the active development branch"}; current=${branch || "<detached>"}`);
if (git(["tag", "--list", `v${args.version}`])) fail(`target tag v${args.version} already exists; RC versions are immutable once tagged`);

const plan = planRcMetadataPromotion({
  rootPackage: readJson(FILES.rootPackage), rootLock: readJson(FILES.rootLock), desktopPackage: readJson(FILES.desktopPackage),
  projectState: state, targetVersion: args.version,
});
if (!plan.valid) fail(plan.errors.join("; "));
const summary = {
  schemaVersion: 1, kind: "freeseek-desktop-rc-metadata-plan", branch,
  currentVersion: plan.currentVersion, targetVersion: plan.targetVersion, apply: args.apply,
  files: Object.values(FILES), nextSteps: ["review diff", "commit candidate metadata", "regenerate all commit-bound RC evidence", "do not tag before desktop:rc:evidence:gate returns rcEligible=true"],
};
if (args.apply) {
  for (const [key, relative] of Object.entries(FILES)) writeJson(relative, plan.documents[key]);
}
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
