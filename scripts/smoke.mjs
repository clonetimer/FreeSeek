/**
 * FreeSeek production artifact smoke (zero runtime dependencies beyond the built tree).
 *
 * Usage:
 *   node scripts/smoke.mjs            # typecheck + build + artifact contract checks
 *   node scripts/smoke.mjs --package  # additionally package and validate VSIX
 *   node scripts/smoke.mjs --built    # artifact checks only after an existing production build
 *
 * IMPORTANT: this smoke test validates public/stable artifact contracts, not private
 * implementation symbol names. Production minification/tree-shaking is allowed to rename
 * helpers such as encodeBuffer without turning a healthy bundle into a release failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const withPackage = process.argv.includes("--package");
const alreadyBuilt = process.argv.includes("--built");

const nodeArtifacts = [
  ["freeseek", "dist/freeseek-headless.js"],
  ["freeseek-acp", "dist/freeseek-acp.js"],
  ["freeseek-eval", "dist/freeseek-eval.js"],
  ["freeseek-bench", "dist/freeseek-bench.js"],
];
const allArtifacts = [
  "dist/extension.js",
  ...nodeArtifacts.map(([, file]) => file),
  "dist/webview.js",
  "dist/mermaid.js",
];

/** Run a JS entry directly with Node (no shell; deterministic on Windows). */
function runNode(entry, args = [], opts = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    ...opts,
  });
}

/** Run a command through a shell only for .cmd-style tools such as vsce. */
function runShell(cmd, args, opts = {}) {
  return spawnSync(`${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: 180_000,
    ...opts,
  });
}

test("TS typecheck catches import/type errors", () => {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const r = runNode(tsc, ["-p", "tsconfig.check.json", "--noEmit"]);
  assert.equal(r.status, 0, `tsc failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
});

test("esbuild production tree can be created", { skip: alreadyBuilt }, () => {
  const r = runNode(path.join(root, "esbuild.js"), ["--production"]);
  assert.equal(r.status, 0, `build failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
});

test("dist artifacts satisfy the public host/package contract", () => {
  for (const f of allArtifacts) {
    const p = path.join(root, f);
    assert.ok(fs.existsSync(p), `${f} missing`);
    assert.ok(fs.statSync(p).size > 10_000, `${f} unexpectedly small (${fs.statSync(p).size} B)`);
  }

  assert.equal(pkg.main, "./dist/extension.js", "package main must point at the built VS Code host");
  for (const [binName, artifact] of nodeArtifacts) {
    assert.equal(pkg.bin?.[binName], `./${artifact}`, `${binName} package bin mapping drifted`);
    const source = fs.readFileSync(path.join(root, artifact), "utf8");
    const lines = source.split(/\r?\n/);
    assert.equal(lines[0], "#!/usr/bin/env node", `${artifact} shebang must be line 1`);
    assert.equal(lines.filter((line) => line.startsWith("#!")).length, 1, `${artifact} must contain exactly one shebang`);
    // Validate that each bundled Node host is syntactically loadable by Node.
    const checked = spawnSync(process.execPath, ["--check", path.join(root, artifact)], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(checked.status, 0, `${artifact} failed node --check:\n${checked.stdout}\n${checked.stderr}`);
  }

  // Validate stable extension/webview protocol strings. These are public host contracts
  // (command ids / view ids / message types), unlike private helper function names.
  const ext = fs.readFileSync(path.join(root, "dist/extension.js"), "utf8");
  for (const marker of ["freesek.openChat", "freesek.chatView", "freesek.manageMCP", "agent_mode", "__auto__"]) {
    assert.ok(ext.includes(marker), `dist/extension.js missing stable contract marker ${marker}`);
  }
  const wv = fs.readFileSync(path.join(root, "dist/webview.js"), "utf8");
  for (const marker of ["modeCraftBtn", "setMode", "agent_mode"]) {
    assert.ok(wv.includes(marker), `dist/webview.js missing stable UI contract marker ${marker}`);
  }
  assert.ok(fs.existsSync(path.join(root, "benchmarks/v1/manifest.json")), "built-in benchmark manifest missing");
});

test("VSIX package can be produced", { skip: !withPackage }, () => {
  const vsix = path.join(root, `freeseek-copilot-${pkg.version}.vsix`);
  if (fs.existsSync(vsix)) fs.rmSync(vsix);
  const r = runShell("npx", ["--no-install", "vsce", "package", "--no-dependencies"]);
  assert.equal(r.status, 0, `vsce package failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(vsix), `VSIX was not produced: ${vsix}`);
  assert.ok(fs.statSync(vsix).size > 100_000, `VSIX unexpectedly small (${fs.statSync(vsix).size} B)`);
});

if (!withPackage) console.log("\nHint: run `node scripts/smoke.mjs --package` to also validate VSIX packaging.");
