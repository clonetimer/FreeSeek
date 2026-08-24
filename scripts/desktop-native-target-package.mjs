#!/usr/bin/env node
/** Verify native stage signing policy (where applicable) and build the final portable target artifact. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageNativePortableStage } from "./lib/desktop-native-portable-artifact.mjs";
import { validatePortableStage } from "./lib/desktop-portable-install.mjs";
import { verifyNativeStageSignature } from "./lib/desktop-native-signature-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node scripts/desktop-native-target-package.mjs --stage dir --native-preflight report.json --signing-policy policy.json --arch x64|arm64 --out artifact.tar.gz|artifact.zip [--smoke-out file] [--evidence-out file]"); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["stage", "native-preflight", "signing-policy", "arch", "out"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
function hashFile(file) {
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("final portable artifact must be a regular file");
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), chunk = Buffer.allocUnsafe(1024 * 1024);
  try { let offset = 0; while (offset < stat.size) { const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset); if (n <= 0) throw new Error("unexpected EOF hashing portable artifact"); hash.update(chunk.subarray(0, n)); offset += n; } }
  finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), size: stat.size };
}
function git(args) { const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`); return String(r.stdout ?? "").trim(); }
function runFinalPackagedSmoke(stage, outFile) {
  const executable = path.resolve(stage.root, String(stage.manifest.electronExecutable ?? ""));
  const env = { ...process.env, FREESEEK_ELECTRON_BIN: executable, FREESEEK_DESKTOP_PACKAGED_E2E: "1", FREESEEK_DESKTOP_E2E_VERIFY_SECRET: "1", FREESEEK_DESKTOP_E2E_EVIDENCE_OUT: outFile };
  delete env.FREESEEK_ALLOW_ELECTRON_VERSION_MISMATCH; delete env.FREESEEK_DESKTOP_E2E_NO_SANDBOX; delete env.FREESEEK_DESKTOP_USE_REAL_DISPLAY;
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/desktop-electron-smoke.mjs")], { cwd: ROOT, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error("signed/productized packaged smoke failed before final artifact packaging");
  const report = JSON.parse(fs.readFileSync(outFile, "utf8"));
  if (report.passed !== true || report.packagedMode !== true || report.appIsPackaged !== true || report.versionMatched !== true || report.testNoSandbox !== false || report.secretStoreVerified !== true || report.secretDiagnosticsClean !== true || !report.secretBackend || report.secretBackend === "basic_text" || report.stageManifestSha256 !== stage.manifestSha256) throw new Error("final packaged smoke evidence does not satisfy release target requirements");
  return report;
}
function runRecoverySmoke(stage, arch, outFile) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/desktop-packaged-recovery-smoke.mjs"), "--stage", stage.root, "--arch", arch, "--out", outFile], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error("packaged forced-termination recovery smoke failed before final artifact packaging");
  const report = JSON.parse(fs.readFileSync(outFile, "utf8"));
  if (report.kind !== "freesek-desktop-packaged-recovery-e2e" || report.passed !== true || report.appIsPackaged !== true || report.versionMatched !== true || report.testNoSandbox !== false || report.stageManifestSha256 !== stage.manifestSha256 || report.recoveredSameSession !== true || report.markerSurvivedForcedTermination !== true || report.markerClearedAfterRecovery !== true) throw new Error("packaged recovery evidence does not satisfy release target requirements");
  return report;
}
try {
  const args = parseArgs(process.argv.slice(2));
  if (process.arch !== args.arch) fail(`native packaging architecture mismatch: runtime ${process.arch}, requested ${args.arch}`);
  if (git(["status", "--porcelain"])) fail("native target packaging requires a clean committed worktree");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")), version = String(pkg.version), gitCommit = git(["rev-parse", "HEAD"]);
  const target = `${process.platform}/${args.arch}`, stage = validatePortableStage(path.resolve(args.stage), target);
  if (stage.manifest.version !== version) fail(`portable stage version ${stage.manifest.version} does not match committed version ${version}`);
  const nativePreflight = JSON.parse(fs.readFileSync(path.resolve(args["native-preflight"]), "utf8"));
  const expectedAsset = `electron-v${stage.manifest.expectedElectronVersion}-${process.platform}-${args.arch}.zip`;
  if (nativePreflight.kind !== "freesek-desktop-native-target-preflight" || nativePreflight.passed !== true || nativePreflight.version !== version || nativePreflight.gitCommit !== gitCommit
    || nativePreflight.platform !== process.platform || nativePreflight.arch !== args.arch || nativePreflight.target !== target || nativePreflight.electronVersion !== stage.manifest.expectedElectronVersion
    || nativePreflight.electronArchiveAsset !== expectedAsset || !/^[a-f0-9]{64}$/i.test(String(nativePreflight.electronArchiveSha256 ?? ""))
    || !/^[a-f0-9]{64}$/i.test(String(nativePreflight.electronShasumsSha256 ?? "")) || nativePreflight.stageManifestSha256 !== stage.manifestSha256) fail("native target packaging requires matching official-Electron preflight evidence");
  const signingPreflight = verifyNativeStageSignature({ stage: stage.root, signingPolicy: args["signing-policy"], arch: args.arch });
  if (process.platform !== "linux" && (signingPreflight.signatureVerified !== true || signingPreflight.signerIdentityMatched !== true)) fail("native stage signing preflight did not pass");
  const smokeOut = path.resolve(args["smoke-out"] || `${path.resolve(args.out)}.packaged-smoke.json`);
  fs.mkdirSync(path.dirname(smokeOut), { recursive: true });
  const finalPackagedSmoke = runFinalPackagedSmoke(stage, smokeOut);
  const recoveryOut = path.resolve(`${path.resolve(args.out)}.recovery-smoke.json`);
  const recoverySmoke = runRecoverySmoke(stage, args.arch, recoveryOut);
  const packaged = packageNativePortableStage(stage.root, path.resolve(args.out));
  const artifact = hashFile(packaged.artifact);
  const report = {
    schemaVersion: 1, kind: "freesek-desktop-native-target-artifact", passed: true,
    version, gitCommit, platform: process.platform, arch: args.arch, target,
    artifact: packaged.artifact, artifactSha256: artifact.sha256, artifactSize: artifact.size,
    stageManifestSha256: stage.manifestSha256, installerKind: packaged.installerKind,
    nativePreflight: path.resolve(args["native-preflight"]), electronArchiveSha256: nativePreflight.electronArchiveSha256,
    signingPreflight, finalPackagedSmoke: smokeOut, recoverySmoke: recoveryOut, secretBackend: finalPackagedSmoke.secretBackend,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (args["evidence-out"]) { const out = path.resolve(args["evidence-out"]); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, "utf8"); }
  process.stdout.write(text);
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
