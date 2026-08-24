#!/usr/bin/env node
/** Preserve a verified pre-RC native portable artifact for first-release upgrade/rollback evidence. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageNativePortableStage } from "./lib/desktop-native-portable-artifact.mjs";
import { validatePortableStage } from "./lib/desktop-portable-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node scripts/desktop-native-installer-baseline.mjs --stage dir --native-preflight report.json --arch x64|arm64 --out artifact.tar.gz|artifact.zip [--evidence-out file]"); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["stage", "native-preflight", "arch", "out"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
function git(args) { const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`); return String(r.stdout ?? "").trim(); }
function hashFile(file) {
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("baseline artifact must be a regular file");
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), chunk = Buffer.allocUnsafe(1024 * 1024);
  try { let offset = 0; while (offset < stat.size) { const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset); if (n <= 0) throw new Error("unexpected EOF hashing baseline artifact"); hash.update(chunk.subarray(0, n)); offset += n; } }
  finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), size: stat.size };
}
try {
  const args = parseArgs(process.argv.slice(2));
  if (process.arch !== args.arch) fail(`native baseline architecture mismatch: runtime ${process.arch}, requested ${args.arch}`);
  if (git(["status", "--porcelain"])) fail("installer baseline requires a clean committed worktree");
  const version = String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version), gitCommit = git(["rev-parse", "HEAD"]), target = `${process.platform}/${args.arch}`;
  if (/^\d+\.\d+\.\d+$/.test(version)) fail("installer baseline is intended for a pre-RC/pre-Stable candidate, not a Stable version");
  const stage = validatePortableStage(path.resolve(args.stage), target), preflight = JSON.parse(fs.readFileSync(path.resolve(args["native-preflight"]), "utf8"));
  const expectedAsset = `electron-v${stage.manifest.expectedElectronVersion}-${process.platform}-${args.arch}.zip`;
  if (stage.manifest.version !== version || preflight.kind !== "freesek-desktop-native-target-preflight" || preflight.passed !== true || preflight.version !== version || preflight.gitCommit !== gitCommit || preflight.target !== target
    || preflight.stageManifestSha256 !== stage.manifestSha256 || preflight.electronArchiveAsset !== expectedAsset || !/^[a-f0-9]{64}$/i.test(String(preflight.electronArchiveSha256 ?? "")) || !/^[a-f0-9]{64}$/i.test(String(preflight.electronShasumsSha256 ?? ""))) fail("installer baseline requires matching official-Electron native preflight evidence");
  const packaged = packageNativePortableStage(stage.root, path.resolve(args.out)), digest = hashFile(packaged.artifact);
  const report = {
    schemaVersion: 1, kind: "freesek-desktop-installer-baseline-artifact", passed: true, releaseEvidenceEligible: false,
    version, gitCommit, platform: process.platform, arch: args.arch, target, artifact: packaged.artifact, artifactSha256: digest.sha256, artifactSize: digest.size,
    stageManifestSha256: stage.manifestSha256, electronArchiveSha256: preflight.electronArchiveSha256, installerKind: packaged.installerKind,
    purpose: "previous-artifact input for first Desktop RC upgrade/rollback evidence",
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (args["evidence-out"]) { const out = path.resolve(args["evidence-out"]); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, "utf8"); }
  process.stdout.write(text);
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
