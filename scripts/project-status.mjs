#!/usr/bin/env node
/** Print the canonical FreeSeek project/version ledger plus local Git state when available. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = JSON.parse(readFileSync(resolve(ROOT, "docs/project/project-state.json"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

const rows = [
  ["project", state.project],
  ["package", pkg.version],
  ["stable", `${state.stableBaseline.version} (${state.stableBaseline.status})`],
  ["development", `${state.activeDevelopment.version} (${state.activeDevelopment.status})`],
  ["branch", git(["branch", "--show-current"])],
  ["commit", git(["rev-parse", "--short=12", "HEAD"])],
  ["worktree", git(["status", "--porcelain"]) ? "dirty" : "clean"],
];
for (const [key, value] of rows) console.log(`${key.padEnd(12)} ${value}`);
console.log("\nproduct surfaces");
for (const [surface, status] of Object.entries(state.productSurfaces)) {
  console.log(`  ${surface.padEnd(14)} ${status}`);
}
console.log("\nmilestones");
for (const milestone of state.milestones) {
  console.log(`  ${milestone.id.padEnd(4)} ${String(milestone.status).padEnd(12)} ${milestone.target.padEnd(16)} ${milestone.name}`);
}
