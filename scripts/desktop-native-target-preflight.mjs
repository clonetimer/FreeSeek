#!/usr/bin/env node
/** One-shot strict native Desktop pre-provenance validation: official Electron -> build -> stage -> dev/packaged/secret smoke. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareElectronReleaseDistribution } from "./lib/desktop-electron-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node scripts/desktop-native-target-preflight.mjs --electron-archive electron.zip --electron-shasums SHASUMS256.txt --arch x64|arm64 --out dir"); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["electron-archive", "electron-shasums", "arch", "out"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return String(result.stdout ?? "").trim();
}
function runNode(script, args = [], env = process.env, stdio = "inherit") {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, env, encoding: stdio === "pipe" ? "utf8" : undefined, stdio });
  if (result.status !== 0) throw new Error(`${script} failed${stdio === "pipe" ? `: ${String(result.stderr ?? result.stdout).trim()}` : ""}`);
  return result;
}
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function strictSmokeEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.FREESEEK_ALLOW_ELECTRON_VERSION_MISMATCH;
  delete env.FREESEEK_DESKTOP_E2E_NO_SANDBOX;
  delete env.FREESEEK_DESKTOP_USE_REAL_DISPLAY;
  return env;
}
try {
  const args = parseArgs(process.argv.slice(2));
  if (!/^(linux|win32|darwin)$/.test(process.platform)) fail(`unsupported native platform: ${process.platform}`);
  if (process.arch !== args.arch) fail(`native validation architecture mismatch: runtime ${process.arch}, requested ${args.arch}`);
  const status = git(["status", "--porcelain"]); if (status) fail("native target preflight requires a clean committed worktree");
  const gitCommit = git(["rev-parse", "HEAD"]);
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "desktop", "package.json"), "utf8"));
  const version = String(rootPkg.version), electronVersion = String(desktopPkg.devDependencies?.electron ?? "");
  if (String(desktopPkg.version) !== version) fail("Desktop/root package versions differ");

  const out = path.resolve(args.out); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const runtimeDir = path.join(out, "electron-dist");
  const runtime = prepareElectronReleaseDistribution({ archive: args["electron-archive"], shasums: args["electron-shasums"], version: electronVersion, platform: process.platform, arch: args.arch, out: runtimeDir });
  const runtimeEvidenceFile = path.join(out, "electron-runtime-integrity.json");
  fs.writeFileSync(runtimeEvidenceFile, JSON.stringify({ schemaVersion: 1, kind: "freesek-electron-runtime-integrity-evidence", passed: true, electronVersion, platform: process.platform, arch: args.arch, assetName: runtime.assetName, archiveSha256: runtime.archiveSha256, archiveSize: runtime.archiveSize, shasumsSha256: runtime.shasumsSha256 }, null, 2) + "\n");

  runNode("scripts/desktop-build-prod.mjs");
  const stageOut = path.join(out, "stage");
  runNode("scripts/desktop-portable-stage.mjs", ["--skip-build", "--platform", process.platform, "--arch", args.arch, "--electron-dist", runtime.distribution, "--out", stageOut], process.env, "pipe");
  const stageRoot = path.join(stageOut, `FreeSeek-${version}-${process.platform}-${args.arch}`);
  const stageManifestFile = path.join(stageRoot, "freesek-release-manifest.json");
  const stageManifest = JSON.parse(fs.readFileSync(stageManifestFile, "utf8"));
  const stageManifestSha256 = sha256(stageManifestFile);
  const devSmokeFile = path.join(out, "dev-smoke.json"), packagedSmokeFile = path.join(out, "packaged-smoke.json");
  runNode("scripts/desktop-electron-smoke.mjs", [], strictSmokeEnv({ FREESEEK_ELECTRON_BIN: runtime.executable, FREESEEK_DESKTOP_E2E_EVIDENCE_OUT: devSmokeFile }));
  const productExecutable = path.resolve(stageRoot, String(stageManifest.electronExecutable ?? ""));
  runNode("scripts/desktop-electron-smoke.mjs", [], strictSmokeEnv({ FREESEEK_ELECTRON_BIN: productExecutable, FREESEEK_DESKTOP_PACKAGED_E2E: "1", FREESEEK_DESKTOP_E2E_VERIFY_SECRET: "1", FREESEEK_DESKTOP_E2E_EVIDENCE_OUT: packagedSmokeFile }));
  const devSmoke = JSON.parse(fs.readFileSync(devSmokeFile, "utf8")), packagedSmoke = JSON.parse(fs.readFileSync(packagedSmokeFile, "utf8"));
  if (devSmoke.versionMatched !== true || devSmoke.testNoSandbox !== false || devSmoke.packagedMode !== false
    || devSmoke.freesekVersion !== version || devSmoke.gitCommit !== gitCommit
    || devSmoke.platform !== process.platform || devSmoke.arch !== args.arch) throw new Error("Strict dev smoke evidence is invalid");
  if (packagedSmoke.versionMatched !== true || packagedSmoke.testNoSandbox !== false || packagedSmoke.packagedMode !== true
    || packagedSmoke.appIsPackaged !== true || packagedSmoke.secretStoreVerified !== true || packagedSmoke.secretDiagnosticsClean !== true
    || !packagedSmoke.secretBackend || packagedSmoke.secretBackend === "basic_text" || packagedSmoke.freesekVersion !== version
    || packagedSmoke.gitCommit !== gitCommit || packagedSmoke.platform !== process.platform || packagedSmoke.arch !== args.arch) {
    throw new Error("Packaged secureStorage smoke evidence is invalid");
  }
  if (packagedSmoke.stageManifestSha256 !== stageManifestSha256) throw new Error("Packaged smoke does not bind the prepared stage manifest");

  const report = {
    schemaVersion: 1, kind: "freesek-desktop-native-target-preflight", passed: true,
    version, gitCommit, platform: process.platform, arch: args.arch, target: `${process.platform}/${args.arch}`,
    electronVersion, electronArchiveAsset: runtime.assetName, electronArchiveSha256: runtime.archiveSha256,
    electronArchiveSize: runtime.archiveSize, electronShasumsSha256: runtime.shasumsSha256,
    stageManifestSha256, secretBackend: packagedSmoke.secretBackend,
    rcCandidateVersion: /^\d+\.\d+\.\d+-rc\.\d+$/.test(version),
    readyForNativeSigning: true,
    outputs: { stageRoot, stageManifestFile, runtimeEvidenceFile, devSmokeFile, packagedSmokeFile },
  };
  fs.writeFileSync(path.join(out, "native-target-preflight.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
