#!/usr/bin/env node
/**
 * FreeSeek release-artifact gate and packager.
 *
 * Version promotion is deliberately NOT performed here. The audited release commit must already
 * contain matching package.json/package-lock/project-state versions before this script starts.
 * This avoids the historical failure mode where a packaging script silently changed only one
 * version source after the repository gates had already passed.
 *
 * Usage:
 *   node scripts/release.mjs
 *   node scripts/release.mjs --version 0.19.0-beta.4
 *   node scripts/release.mjs --version 0.19.0-rc.1 \
 *     --interop-report reports/client-a.json --interop-report reports/client-b.json
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES = join(ROOT, "releases");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = process.platform === "win32" && ["npm", "npx"].includes(cmd)
    ? spawnSync(`${cmd} ${args.map((arg) => `"${String(arg).replaceAll('"', '\\"')}"`).join(" ")}`, {
        cwd: ROOT,
        stdio: options.capture ? "pipe" : "inherit",
        encoding: options.capture ? "utf8" : undefined,
        shell: true,
      })
    : spawnSync(cmd, args, {
        cwd: ROOT,
        stdio: options.capture ? "pipe" : "inherit",
        encoding: options.capture ? "utf8" : undefined,
      });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    fail(`${cmd} ${args.join(" ")} failed (exit ${result.status})`);
  }
  return result;
}

function parseArgs(argv) {
  const out = { expectedVersion: null, interopReports: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--version") out.expectedVersion = argv[++index] ?? fail("--version requires a value");
    else if (arg === "--interop-report") out.interopReports.push(argv[++index] ?? fail("--interop-report requires a path"));
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/release.mjs [--version X.Y.Z[-rc.N]] [--interop-report file] [--interop-report file]");
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  return out;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function requiresIndependentInterop(version) {
  return /^\d+\.\d+\.\d+$/.test(version) || /-rc\.\d+$/.test(version);
}

function assertCleanWorktree() {
  const result = run("git", ["status", "--porcelain"], { capture: true });
  if (String(result.stdout ?? "").trim()) fail("release worktree must be clean and committed");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = String(pkg.version);
  if (args.expectedVersion && args.expectedVersion !== version) {
    fail(`--version ${args.expectedVersion} does not match committed package version ${version}`);
  }
  if (requiresIndependentInterop(version) && args.interopReports.length < 2) {
    fail(`${version} requires two --interop-report files before RC/stable artifacts can be built`);
  }

  console.log(`── FreeSeek release artifact gate ${version} ──`);
  assertCleanWorktree();
  const commit = String(run("git", ["rev-parse", "HEAD"], { capture: true }).stdout ?? "").trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) fail("unable to resolve full release candidate Git commit");

  console.log("1/8 repository gates …");
  run("npm", ["run", "check"]);
  console.log("2/8 full regression …");
  run("npm", ["test"]);
  console.log("3/8 ACP process conformance …");
  run("npm", ["run", "acp:conformance"]);

  if (requiresIndependentInterop(version)) {
    console.log("4/8 independent ACP client evidence …");
    run("node", [
      join(ROOT, "scripts", "acp-interop-gate.mjs"),
      ...args.interopReports.map((file) => resolve(ROOT, file)),
      "--expected-version", version,
      "--expected-commit", commit,
    ]);
  } else {
    console.log("4/8 independent ACP client evidence … skipped for pre-RC checkpoint");
  }

  console.log("5/8 production build (VS Code + CLI + ACP + Eval/Bench + Webview) …");
  run("node", [join(ROOT, "esbuild.js"), "--production"]);
  console.log("6/8 built-artifact smoke …");
  run("node", [join(ROOT, "scripts", "smoke.mjs"), "--built"]);

  mkdirSync(RELEASES, { recursive: true });
  console.log("7/8 package VSIX and npm artifact …");
  const vsixName = `freeseek-copilot-${version}.vsix`;
  const rootVsix = join(ROOT, vsixName);
  const releaseVsix = join(RELEASES, vsixName);
  if (existsSync(rootVsix)) rmSync(rootVsix);
  if (existsSync(releaseVsix)) rmSync(releaseVsix);
  run("npx", ["--no-install", "vsce", "package", "--no-dependencies", "--baseContentUrl", "https://raw.githubusercontent.com/freeseek/freeseek-copilot/main"]);
  if (!existsSync(rootVsix)) fail(`VSIX was not produced: ${rootVsix}`);
  renameSync(rootVsix, releaseVsix);

  for (const name of readdirSync(RELEASES)) {
    if (name === `freeseek-copilot-${version}.tgz`) rmSync(join(RELEASES, name));
  }
  run("npm", ["pack", "--pack-destination", RELEASES]);
  const tgzName = `freeseek-copilot-${version}.tgz`;
  const releaseTgz = join(RELEASES, tgzName);
  if (!existsSync(releaseTgz)) fail(`npm artifact was not produced: ${releaseTgz}`);

  console.log("8/8 SHA256 manifest …");
  const sums = [releaseVsix, releaseTgz]
    .map((file) => `${sha256(file)}  ${file.split(/[\\/]/).pop()}`)
    .join("\n") + "\n";
  writeFileSync(join(RELEASES, "SHA256SUMS.txt"), sums, "utf8");
  console.log(`✓ artifacts ready in ${RELEASES}`);
  console.log("  Git merge/tag/promotion is intentionally a separate audited step.");
}

main();
