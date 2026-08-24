#!/usr/bin/env node
/** Execute final portable artifact fresh-install/upgrade/rollback on the native OS and emit RC installer evidence. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractNativePortableArtifact, portableArtifactKind } from "./lib/desktop-native-portable-artifact.mjs";
import { comparePortableSemver, installPortableStage, readPortableInstallState, rollbackPortableStage, uninstallPortableDesktop, validatePortableStage } from "./lib/desktop-portable-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function usage() { console.log("Usage: node scripts/desktop-native-installer-evidence.mjs --provenance file --candidate-artifact file --previous-artifact file --arch x64|arm64 [--out evidence.json]"); }
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { usage(); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["provenance", "candidate-artifact", "previous-artifact", "arch"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
function hashFile(file) {
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Installer evidence requires a regular file: ${file}`);
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), chunk = Buffer.allocUnsafe(1024 * 1024);
  try { let offset = 0; while (offset < stat.size) { const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset); if (n <= 0) throw new Error(`Unexpected EOF while hashing ${file}`); hash.update(chunk.subarray(0, n)); offset += n; } }
  finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), size: stat.size };
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function gitCommit() { const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }); if (r.status !== 0) throw new Error("Unable to resolve current Git commit"); return String(r.stdout ?? "").trim(); }
function installedExecutableDigest(installRoot, target) {
  const stage = validatePortableStage(path.join(installRoot, "current"), target);
  const executable = path.resolve(stage.root, String(stage.manifest.electronExecutable ?? ""));
  const rel = path.relative(stage.root, executable);
  if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Installed executable escapes installed payload root");
  return { stage, executable: hashFile(executable) };
}
try {
  const args = parseArgs(process.argv.slice(2));
  if (!/^(linux|win32|darwin)$/.test(process.platform)) fail(`unsupported native platform: ${process.platform}`);
  const target = `${process.platform}/${args.arch}`;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = String(pkg.version), commit = gitCommit();
  const provenanceFile = path.resolve(args.provenance), provenanceBytes = fs.readFileSync(provenanceFile), provenance = JSON.parse(provenanceBytes.toString("utf8"));
  if (provenance?.schemaVersion !== 1 || provenance.kind !== "freeseek-desktop-release-provenance" || provenance.gitTreeState !== "clean") throw new Error("Native installer evidence requires clean release provenance");
  if (provenance.version !== version || provenance.desktopVersion !== version || provenance.gitCommit !== commit) throw new Error("Release provenance does not bind current candidate version/commit");
  const rows = Array.isArray(provenance.artifacts) ? provenance.artifacts.filter((row) => `${row?.platform}/${row?.arch}` === target) : [];
  if (rows.length !== 1) throw new Error(`Expected exactly one ${target} artifact in release provenance`);
  const releaseArtifact = rows[0], candidateArtifact = path.resolve(args["candidate-artifact"]), previousArtifact = path.resolve(args["previous-artifact"]);
  const candidateDigest = hashFile(candidateArtifact);
  if (path.basename(candidateArtifact) !== releaseArtifact.name || candidateDigest.sha256.toLowerCase() !== String(releaseArtifact.sha256).toLowerCase() || candidateDigest.size !== releaseArtifact.size) throw new Error(`Candidate artifact does not match release provenance for ${target}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-native-installer-evidence-"));
  try {
    const previous = extractNativePortableArtifact(previousArtifact, path.join(temp, "previous-artifact"), process.platform, target);
    const candidate = extractNativePortableArtifact(candidateArtifact, path.join(temp, "candidate-artifact"), process.platform, target);
    if (candidate.manifest.version !== version || candidate.manifestSha256 !== releaseArtifact.stageManifestSha256) throw new Error("Candidate artifact stage does not match release provenance");
    if (comparePortableSemver(candidate.manifest.version, previous.manifest.version) <= 0) throw new Error(`Installer evidence requires an upgrade: ${previous.manifest.version} -> ${candidate.manifest.version}`);

    const freshRoot = path.join(temp, "fresh-install");
    installPortableStage(candidate.root, freshRoot);
    const freshMeasured = installedExecutableDigest(freshRoot, target);
    const freshState = readPortableInstallState(freshRoot);
    const freshInstallSucceeded = freshState?.current.version === version && freshMeasured.stage.embeddedManifestSha256 === candidate.manifestSha256;
    const uninstallScenarioExecuted = true;
    uninstallPortableDesktop(freshRoot);
    const uninstallSucceeded = readPortableInstallState(freshRoot) === null
      && !fs.existsSync(path.join(freshRoot, "current")) && !fs.existsSync(path.join(freshRoot, "previous"));

    const upgradeRoot = path.join(temp, "upgrade-install");
    installPortableStage(previous.root, upgradeRoot);
    installPortableStage(candidate.root, upgradeRoot);
    const upgradedMeasured = installedExecutableDigest(upgradeRoot, target);
    const upgradeState = readPortableInstallState(upgradeRoot);
    const upgradeSucceeded = upgradeState?.current.version === version && upgradeState?.previous?.version === previous.manifest.version
      && upgradedMeasured.stage.embeddedManifestSha256 === candidate.manifestSha256;
    const rollbackScenarioExecuted = true;
    rollbackPortableStage(upgradeRoot);
    const rollbackMeasured = installedExecutableDigest(upgradeRoot, target);
    const rollbackState = readPortableInstallState(upgradeRoot);
    const rollbackRestoredPreviousVersion = rollbackState?.current.version === previous.manifest.version
      && rollbackMeasured.stage.embeddedManifestSha256 === previous.manifestSha256 && !rollbackState?.previous;

    const report = {
      schemaVersion: 1, kind: "freeseek-desktop-installer-rollback-evidence", passed: freshInstallSucceeded && uninstallSucceeded && upgradeSucceeded && rollbackRestoredPreviousVersion,
      version, gitCommit: commit, platform: process.platform, arch: args.arch, target,
      installerKind: portableArtifactKind(process.platform), nativePlatformVerified: true,
      fromVersion: previous.manifest.version, artifactSha256: candidateDigest.sha256, provenanceSha256: sha256(provenanceBytes),
      candidateStageManifestSha256: candidate.manifestSha256, installedStageManifestSha256: upgradedMeasured.stage.embeddedManifestSha256,
      installedExecutableSha256: upgradedMeasured.executable.sha256,
      rollbackInstalledStageManifestSha256: rollbackMeasured.stage.embeddedManifestSha256,
      freshInstallSucceeded, uninstallScenarioExecuted, uninstallSucceeded, upgradeSucceeded, rollbackScenarioExecuted, rollbackRestoredPreviousVersion,
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (args.out) { const out = path.resolve(args.out); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, { encoding: "utf8", mode: 0o600 }); }
    process.stdout.write(text); if (!report.passed) process.exitCode = 1;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
