import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const PACKAGE = path.join(ROOT, "scripts/desktop-portable-artifact.mjs");
const EVIDENCE = path.join(ROOT, "scripts/desktop-native-installer-evidence.mjs");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
function shaBytes(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function shaFile(file: string): string { return shaBytes(fs.readFileSync(file)); }
function gitCommit(): string { return spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(); }

function makeLinuxStage(root: string, name: string, version: string, arch: string): string {
  const stage = path.join(root, name), executable = path.join(stage, "FreeSeek"), critical = path.join(stage, "resources/app/package.json");
  fs.mkdirSync(path.dirname(critical), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(critical, JSON.stringify({ name: "@freeseek/desktop-portable", version }) + "\n");
  const embeddedManifestPath = "resources/freeseek/release-manifest.json";
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: "freeseek-desktop-portable-stage", version, platform: "linux", arch,
    electronVersion: "43.3.0", expectedElectronVersion: "43.3.0", versionMatched: true,
    electronExecutable: "FreeSeek", embeddedManifestPath,
    files: [{ path: "resources/app/package.json", size: fs.statSync(critical).size, sha256: shaFile(critical) }],
  }, null, 2) + "\n");
  fs.mkdirSync(path.dirname(path.join(stage, embeddedManifestPath)), { recursive: true });
  fs.writeFileSync(path.join(stage, "freesek-release-manifest.json"), manifestBytes);
  fs.writeFileSync(path.join(stage, embeddedManifestPath), manifestBytes);
  return stage;
}

function packageStage(stage: string, out: string) {
  return spawnSync(process.execPath, [PACKAGE, "--stage", stage, "--out", out], { cwd: ROOT, encoding: "utf8" });
}

test("native portable installer evidence scripts expose fixed non-arbitrary adapter contracts", () => {
  const packageHelp = spawnSync(process.execPath, [PACKAGE, "--help"], { cwd: ROOT, encoding: "utf8" });
  const evidenceHelp = spawnSync(process.execPath, [EVIDENCE, "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(packageHelp.status, 0); assert.match(packageHelp.stdout, /--stage dir/);
  assert.equal(evidenceHelp.status, 0); assert.match(evidenceHelp.stdout, /--candidate-artifact/); assert.match(evidenceHelp.stdout, /--previous-artifact/);
  const source = fs.readFileSync(EVIDENCE, "utf8");
  assert.doesNotMatch(source, /--installer-command|shell:\s*true|FREESEEK_INSTALLER_COMMAND/);
});

test("Linux final portable artifact performs native artifact-backed fresh install, upgrade, and rollback", { skip: process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-native-installer-evidence-"));
  try {
    const previous = makeLinuxStage(temp, "previous", "0.20.0-dev.2", process.arch);
    const candidate = makeLinuxStage(temp, "candidate", PKG.version, process.arch);
    const previousArtifact = path.join(temp, "FreeSeek-previous-linux.tar.gz");
    const candidateArtifact = path.join(temp, `FreeSeek-${PKG.version}-linux-${process.arch}.tar.gz`);
    for (const [stage, artifact] of [[previous, previousArtifact], [candidate, candidateArtifact]] as const) {
      const result = packageStage(stage, artifact); assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const candidateManifest = fs.readFileSync(path.join(candidate, "freesek-release-manifest.json"));
    const candidateStat = fs.statSync(candidateArtifact);
    const provenance = {
      schemaVersion: 1, kind: "freeseek-desktop-release-provenance", version: PKG.version, desktopVersion: PKG.version,
      electronVersionPin: "43.3.0", gitCommit: gitCommit(), gitTreeState: "clean", generatedAt: new Date().toISOString(),
      artifacts: [{ platform: "linux", arch: process.arch, name: path.basename(candidateArtifact), electronVersion: "43.3.0",
        stageManifestSha256: shaBytes(candidateManifest), sha256: shaFile(candidateArtifact), size: candidateStat.size }],
    };
    const provenanceFile = path.join(temp, "provenance.json"); fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + "\n");
    const out = path.join(temp, "installer-evidence.json");
    const result = spawnSync(process.execPath, [EVIDENCE, "--provenance", provenanceFile, "--candidate-artifact", candidateArtifact,
      "--previous-artifact", previousArtifact, "--arch", process.arch, "--out", out], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(report.kind, "freeseek-desktop-installer-rollback-evidence");
    assert.equal(report.installerKind, "portable-tar-gzip-v1");
    assert.equal(report.nativePlatformVerified, true);
    assert.equal(report.fromVersion, "0.20.0-dev.2");
    assert.equal(report.version, PKG.version);
    assert.equal(report.candidateStageManifestSha256, provenance.artifacts[0].stageManifestSha256);
    assert.equal(report.installedStageManifestSha256, provenance.artifacts[0].stageManifestSha256);
    assert.match(report.installedExecutableSha256, /^[a-f0-9]{64}$/);
    assert.match(report.rollbackInstalledStageManifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.freshInstallSucceeded, true); assert.equal(report.uninstallScenarioExecuted, true); assert.equal(report.uninstallSucceeded, true);
    assert.equal(report.upgradeSucceeded, true);
    assert.equal(report.rollbackScenarioExecuted, true); assert.equal(report.rollbackRestoredPreviousVersion, true); assert.equal(report.passed, true);
    assert.equal(fs.statSync(out).mode & 0o077, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("native installer evidence rejects a candidate artifact that is not the provenance artifact", { skip: process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-native-installer-mismatch-"));
  try {
    const previous = makeLinuxStage(temp, "previous", "0.20.0-dev.2", process.arch), candidate = makeLinuxStage(temp, "candidate", PKG.version, process.arch);
    const previousArtifact = path.join(temp, "previous.tar.gz"), candidateArtifact = path.join(temp, "candidate.tar.gz");
    assert.equal(packageStage(previous, previousArtifact).status, 0); assert.equal(packageStage(candidate, candidateArtifact).status, 0);
    const manifest = fs.readFileSync(path.join(candidate, "freesek-release-manifest.json"));
    const provenance = { schemaVersion: 1, kind: "freeseek-desktop-release-provenance", version: PKG.version, desktopVersion: PKG.version, gitCommit: gitCommit(), gitTreeState: "clean",
      artifacts: [{ platform: "linux", arch: process.arch, name: path.basename(candidateArtifact), stageManifestSha256: shaBytes(manifest), sha256: "0".repeat(64), size: fs.statSync(candidateArtifact).size }] };
    const provenanceFile = path.join(temp, "provenance.json"); fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
    const result = spawnSync(process.execPath, [EVIDENCE, "--provenance", provenanceFile, "--candidate-artifact", candidateArtifact, "--previous-artifact", previousArtifact, "--arch", process.arch], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Candidate artifact does not match release provenance/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
