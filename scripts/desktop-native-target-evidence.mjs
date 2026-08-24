#!/usr/bin/env node
/** Post-provenance native target evidence: final signing verification + install/uninstall/upgrade/rollback. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node scripts/desktop-native-target-evidence.mjs --provenance file --artifact file --previous-artifact file --stage dir --signing-policy policy.json --native-preflight file --dev-smoke file --packaged-smoke file --recovery-smoke file --arch x64|arm64 --out dir [Linux: --manifest update.json --signature update.sig --public-key public.pem]"); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["provenance", "artifact", "previous-artifact", "stage", "signing-policy", "native-preflight", "dev-smoke", "packaged-smoke", "recovery-smoke", "arch", "out"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  if (process.platform === "linux") for (const key of ["manifest", "signature", "public-key"]) if (!out[key]) fail(`--${key} is required on Linux`);
  return out;
}
function run(script, args, outFile) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args, "--out", outFile], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${script} failed: ${String(result.stderr ?? result.stdout).trim()}`);
  const report = JSON.parse(fs.readFileSync(outFile, "utf8")); if (report.passed !== true) throw new Error(`${script} did not emit passed evidence`); return report;
}
try {
  const args = parseArgs(process.argv.slice(2));
  if (process.arch !== args.arch) fail(`native evidence architecture mismatch: runtime ${process.arch}, requested ${args.arch}`);
  const out = path.resolve(args.out); fs.mkdirSync(out, { recursive: true });
  const nativePreflight = JSON.parse(fs.readFileSync(path.resolve(args["native-preflight"]), "utf8"));
  const devSmoke = JSON.parse(fs.readFileSync(path.resolve(args["dev-smoke"]), "utf8"));
  const packagedSmoke = JSON.parse(fs.readFileSync(path.resolve(args["packaged-smoke"]), "utf8"));
  if (nativePreflight.kind !== "freesek-desktop-native-target-preflight" || nativePreflight.passed !== true || nativePreflight.platform !== process.platform || nativePreflight.arch !== args.arch) fail("native preflight is not valid target evidence");
  if (devSmoke.kind !== "freesek-desktop-electron-e2e" || devSmoke.passed !== true || devSmoke.packagedMode !== false
    || devSmoke.versionMatched !== true || devSmoke.testNoSandbox !== false || devSmoke.freesekVersion !== nativePreflight.version
    || devSmoke.gitCommit !== nativePreflight.gitCommit || devSmoke.platform !== process.platform || devSmoke.arch !== args.arch) {
    fail("development smoke is not valid candidate evidence");
  }
  if (packagedSmoke.kind !== "freesek-desktop-electron-e2e" || packagedSmoke.passed !== true || packagedSmoke.packagedMode !== true
    || packagedSmoke.appIsPackaged !== true || packagedSmoke.versionMatched !== true || packagedSmoke.testNoSandbox !== false
    || packagedSmoke.secretStoreVerified !== true || packagedSmoke.secretDiagnosticsClean !== true
    || packagedSmoke.freesekVersion !== nativePreflight.version || packagedSmoke.gitCommit !== nativePreflight.gitCommit
    || packagedSmoke.platform !== process.platform || packagedSmoke.arch !== args.arch) fail("packaged smoke is not valid native target evidence");
  const recoverySmoke = JSON.parse(fs.readFileSync(path.resolve(args["recovery-smoke"]), "utf8"));
  if (recoverySmoke.kind !== "freesek-desktop-packaged-recovery-e2e" || recoverySmoke.passed !== true || recoverySmoke.appIsPackaged !== true || recoverySmoke.versionMatched !== true || recoverySmoke.testNoSandbox !== false || recoverySmoke.platform !== process.platform || recoverySmoke.arch !== args.arch || recoverySmoke.recoveredSameSession !== true || recoverySmoke.markerSurvivedForcedTermination !== true || recoverySmoke.markerClearedAfterRecovery !== true || recoverySmoke.stageManifestSha256 !== packagedSmoke.stageManifestSha256) fail("packaged recovery smoke is not valid native target evidence");
  if (nativePreflight.stageManifestSha256 !== packagedSmoke.stageManifestSha256 || nativePreflight.version !== recoverySmoke.version || nativePreflight.gitCommit !== recoverySmoke.gitCommit) fail("native preflight/recovery evidence does not bind the same candidate stage");
  for (const [source, name] of [[args["native-preflight"], "native-preflight.json"], [args["dev-smoke"], "dev-smoke.json"], [args["packaged-smoke"], "packaged-smoke.json"], [args["recovery-smoke"], "recovery-smoke.json"]]) fs.copyFileSync(path.resolve(source), path.join(out, name));
  const common = ["--provenance", args.provenance, "--artifact", args.artifact, "--signing-policy", args["signing-policy"], "--arch", args.arch];
  let signing;
  if (process.platform === "win32") signing = run("scripts/desktop-windows-signing-evidence.mjs", [...common, "--stage", args.stage], path.join(out, "signing-evidence.json"));
  else if (process.platform === "darwin") signing = run("scripts/desktop-macos-signing-evidence.mjs", [...common, "--stage", args.stage], path.join(out, "signing-evidence.json"));
  else signing = run("scripts/desktop-linux-signing-evidence.mjs", ["--provenance", args.provenance, "--manifest", args.manifest, "--signature", args.signature, "--public-key", args["public-key"], "--artifact", args.artifact, "--signing-policy", args["signing-policy"], "--arch", args.arch], path.join(out, "signing-evidence.json"));
  const installer = run("scripts/desktop-native-installer-evidence.mjs", ["--provenance", args.provenance, "--candidate-artifact", args.artifact, "--previous-artifact", args["previous-artifact"], "--arch", args.arch], path.join(out, "installer-evidence.json"));
  if (signing.stageManifestSha256 !== packagedSmoke.stageManifestSha256 || installer.installedStageManifestSha256 !== packagedSmoke.stageManifestSha256) fail("native signing/installer evidence does not bind the packaged smoke stage");
  const report = {
    schemaVersion: 1, kind: "freesek-desktop-native-target-evidence-bundle", passed: true,
    version: signing.version, gitCommit: signing.gitCommit, platform: process.platform, arch: args.arch, target: `${process.platform}/${args.arch}`,
    nativePreflight: "native-preflight.json", devSmoke: "dev-smoke.json", packagedSmoke: "packaged-smoke.json", recoverySmoke: "recovery-smoke.json", signingEvidence: "signing-evidence.json", installerEvidence: "installer-evidence.json",
    stageManifestSha256: packagedSmoke.stageManifestSha256, artifactSha256: signing.artifactSha256,
  };
  fs.writeFileSync(path.join(out, "native-target-evidence.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
