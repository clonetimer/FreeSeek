import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const DESKTOP = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/desktop", "package.json"), "utf8"));
const COMMIT = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout).trim();
const PIN = DESKTOP.devDependencies.electron;
function write(file: string, value: unknown) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); return file; }
function hash(file: string) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-rc-evidence-"));
  const artifacts = [
    { platform: "linux", arch: "x64", name: "FreeSeek-linux-x64.tar.gz", electronVersion: PIN, stageManifestSha256: "a".repeat(64), sha256: "1".repeat(64), size: 100 },
    { platform: "darwin", arch: "arm64", name: "FreeSeek-darwin-arm64.zip", electronVersion: PIN, stageManifestSha256: "b".repeat(64), sha256: "2".repeat(64), size: 200 },
  ];
  const signingPolicy = write(path.join(dir, "signing-policy.json"), {
    schemaVersion: 1, kind: "freesek-desktop-signing-policy", policyId: "rc-gate-test-policy", targets: [
      { platform: "linux", arch: "x64", signatureKind: "ed25519-update-manifest", publicKeySha256: "3".repeat(64) },
      { platform: "darwin", arch: "arm64", signatureKind: "apple-codesign", teamIdentifier: "ABCDE12345", notarizationRequired: true },
    ],
  });
  const signingPolicySha256 = hash(signingPolicy);
  const signingPolicySize = fs.statSync(signingPolicy).size;
  const provenance = write(path.join(dir, "provenance.json"), {
    schemaVersion: 1, kind: "freeseek-desktop-release-provenance", version: PKG.version, desktopVersion: PKG.version,
    electronVersionPin: PIN, gitCommit: COMMIT, gitTreeState: "clean", generatedAt: "2026-08-20T12:00:00Z",
    signingPolicy: { policyId: "rc-gate-test-policy", sha256: signingPolicySha256, size: signingPolicySize }, artifacts,
  });
  const provenanceSha256 = hash(provenance);
  const dev = write(path.join(dir, "dev.json"), {
    schemaVersion: 1, kind: "freesek-desktop-electron-e2e", passed: true, platform: "linux", arch: "x64", freesekVersion: PKG.version,
    gitCommit: COMMIT, electronVersion: PIN, expectedElectronVersion: PIN, versionMatched: true, testNoSandbox: false, packagedMode: false,
  });
  const nativePreflight = artifacts.map((artifact) => write(path.join(dir, `preflight-${artifact.platform}.json`), {
    schemaVersion: 1, kind: "freesek-desktop-native-target-preflight", passed: true, version: PKG.version, gitCommit: COMMIT,
    platform: artifact.platform, arch: artifact.arch, target: `${artifact.platform}/${artifact.arch}`, electronVersion: PIN,
    electronArchiveAsset: `electron-v${PIN}-${artifact.platform}-${artifact.arch}.zip`, electronArchiveSha256: "7".repeat(64), electronShasumsSha256: "8".repeat(64),
    stageManifestSha256: artifact.stageManifestSha256,
  }));
  const packaged = artifacts.map((artifact) => write(path.join(dir, `packaged-${artifact.platform}.json`), {
    schemaVersion: 1, kind: "freesek-desktop-electron-e2e", passed: true, platform: artifact.platform, arch: artifact.arch, freesekVersion: PKG.version, gitCommit: COMMIT,
    electronVersion: PIN, expectedElectronVersion: PIN, versionMatched: true, testNoSandbox: false, packagedMode: true, appIsPackaged: true,
    stageManifestSha256: artifact.stageManifestSha256, secretStoreRequested: true, secretStoreVerified: true, secretDiagnosticsClean: true, secretBackend: artifact.platform === "darwin" ? "keychain" : "gnome_libsecret",
  }));
  const recovery = artifacts.map((artifact) => write(path.join(dir, `recovery-${artifact.platform}.json`), {
    schemaVersion: 1, kind: "freesek-desktop-packaged-recovery-e2e", passed: true, version: PKG.version, gitCommit: COMMIT,
    platform: artifact.platform, arch: artifact.arch, electronVersion: PIN, expectedElectronVersion: PIN, versionMatched: true,
    stageManifestSha256: artifact.stageManifestSha256, appIsPackaged: true, testNoSandbox: false,
    interruptedMarkerObserved: true, markerSurvivedForcedTermination: true, recoveredSameSession: true, markerClearedAfterRecovery: true,
  }));
  const installer = artifacts.map((artifact) => write(path.join(dir, `installer-${artifact.platform}.json`), {
    schemaVersion: 1, kind: "freeseek-desktop-installer-rollback-evidence", passed: true, version: PKG.version, gitCommit: COMMIT,
    platform: artifact.platform, arch: artifact.arch, artifactSha256: artifact.sha256, provenanceSha256,
    installerKind: artifact.platform === "linux" ? "portable-tar-gzip-v1" : "portable-zip-v1", nativePlatformVerified: true,
    fromVersion: "0.19.9", candidateStageManifestSha256: artifact.stageManifestSha256, installedStageManifestSha256: artifact.stageManifestSha256,
    installedExecutableSha256: "5".repeat(64), rollbackInstalledStageManifestSha256: "6".repeat(64),
    freshInstallSucceeded: true, uninstallScenarioExecuted: true, uninstallSucceeded: true, upgradeSucceeded: true, rollbackScenarioExecuted: true, rollbackRestoredPreviousVersion: true,
  }));
  const signing = artifacts.map((artifact) => write(path.join(dir, `signing-${artifact.platform}.json`), {
    schemaVersion: 1, kind: "freeseek-desktop-signing-evidence", passed: true, version: PKG.version, gitCommit: COMMIT,
    platform: artifact.platform, arch: artifact.arch, artifactSha256: artifact.sha256, provenanceSha256, signatureVerified: true,
    stageManifestSha256: artifact.stageManifestSha256,
    ...(artifact.platform === "linux" ? {} : { signedExecutableSha256: "5".repeat(64) }),
    signingPolicySha256, signerIdentityMatched: true,
    signatureKind: artifact.platform === "darwin" ? "apple-codesign" : artifact.platform === "win32" ? "authenticode" : "ed25519-update-manifest",
    ...(artifact.platform === "darwin"
      ? { notarized: true, teamIdentifier: "ABCDE12345" }
      : artifact.platform === "win32"
        ? { certificateSha256: "4".repeat(64) }
        : { publicKeySha256: "3".repeat(64) }),
  }));
  const interop = [
    ["agentclientprotocol", "typescript-sdk", ["resume"]], ["openclaw", "acpx", []],
  ].map(([owner, id, advanced], index) => write(path.join(dir, `interop-${index}.json`), {
    schemaVersion: 1, kind: "freesek-acp-external-interop", accepted: true, freesekVersion: PKG.version, gitCommit: COMMIT,
    evidence: { freesekAcpInterop: 1, implementationOwner: owner, implementationId: id, clientVersion: "1.0.0", initialize: true, newSession: true, prompt: true, sessionUpdate: true, advancedCapabilities: advanced },
  }));
  return { dir, provenance, signingPolicy, dev, nativePreflight, packaged, recovery, installer, signing, interop };
}
function run(f: ReturnType<typeof fixture>, edits: string[] = []) {
  const args = ["scripts/desktop-rc-evidence-gate.mjs", "--allow-non-rc", "--provenance", f.provenance, "--signing-policy", f.signingPolicy, "--dev-smoke", f.dev];
  for (const file of f.nativePreflight) args.push("--native-preflight-report", file);
  for (const file of f.packaged) args.push("--packaged-smoke", file);
  for (const file of f.recovery) args.push("--recovery-report", file);
  for (const file of f.interop) args.push("--interop-report", file);
  for (const file of f.installer) args.push("--installer-report", file);
  for (const file of f.signing) args.push("--signing-report", file);
  args.push(...edits);
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
}
function makeBundle(f: ReturnType<typeof fixture>, index: number) {
  const target = index === 0 ? { platform: "linux", arch: "x64" } : { platform: "darwin", arch: "arm64" };
  const dir = path.join(f.dir, `bundle-${index}`); fs.mkdirSync(dir);
  for (const [source, name] of [[f.nativePreflight[index], "native-preflight.json"], [f.dev, "dev-smoke.json"], [f.packaged[index], "packaged-smoke.json"], [f.recovery[index], "recovery-smoke.json"], [f.signing[index], "signing-evidence.json"], [f.installer[index], "installer-evidence.json"]] as const) fs.copyFileSync(source, path.join(dir, name));
  write(path.join(dir, "native-target-evidence.json"), { schemaVersion: 1, kind: "freesek-desktop-native-target-evidence-bundle", passed: true, version: PKG.version, gitCommit: COMMIT, ...target, target: `${target.platform}/${target.arch}`, nativePreflight: "native-preflight.json", devSmoke: "dev-smoke.json", packagedSmoke: "packaged-smoke.json", recoverySmoke: "recovery-smoke.json", signingEvidence: "signing-evidence.json", installerEvidence: "installer-evidence.json" });
  return dir;
}

test("Desktop RC aggregate gate reports eligibility from the committed candidate version", () => {
  const f = fixture();
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    const isRcVersion = /^\d+\.\d+\.\d+-rc\.\d+$/.test(PKG.version);
    assert.equal(summary.passed, true); assert.equal(summary.rcEligible, isRcVersion); assert.equal(summary.preflightOnly, !isRcVersion);
    assert.deepEqual(summary.releaseTargets, ["darwin/arm64", "linux/x64"]);
    assert.equal(summary.signingPolicyId, "rc-gate-test-policy"); assert.match(summary.signingPolicySha256, /^[a-f0-9]{64}$/);
    assert.equal(summary.independentInterop.passed, true);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Desktop RC aggregate gate expands canonical self-contained native target evidence bundles", () => {
  const f = fixture();
  try {
    const args = ["scripts/desktop-rc-evidence-gate.mjs", "--allow-non-rc", "--provenance", f.provenance, "--signing-policy", f.signingPolicy];
    for (let i = 0; i < f.packaged.length; i += 1) args.push("--native-target-bundle", makeBundle(f, i));
    for (const file of f.interop) args.push("--interop-report", file);
    const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout); assert.equal(summary.passed, true); assert.deepEqual(summary.recoveryEvidenceTargets, ["darwin/arm64", "linux/x64"]);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Desktop RC aggregate gate rejects sandbox waivers, missing signing evidence and stale ACP candidate reports", () => {
  const f = fixture();
  try {
    const badSmoke = JSON.parse(fs.readFileSync(f.packaged[0], "utf8")); badSmoke.testNoSandbox = true; write(f.packaged[0], badSmoke);
    fs.unlinkSync(f.signing[1]);
    const stale = JSON.parse(fs.readFileSync(f.interop[0], "utf8")); stale.gitCommit = "f".repeat(40); write(f.interop[0], stale);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.passed, false);
    assert.ok(summary.errors.some((row: string) => row.includes("exact runtime/secret gate")));
    assert.ok(summary.errors.some((row: string) => row.includes("missing signing evidence")));
    assert.ok(summary.errors.some((row: string) => row.includes("interoperability gate failed")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});


test("Desktop RC aggregate gate rejects packaged smoke from a different candidate commit", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.packaged[0], "utf8"));
    linux.gitCommit = "f".repeat(40);
    write(f.packaged[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("exact runtime/secret gate")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Desktop RC aggregate gate rejects signing evidence bound to a different release provenance", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.signing[0], "utf8"));
    linux.provenanceSha256 = "f".repeat(64);
    write(f.signing[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("signing/notarization evidence is incomplete for linux/x64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Desktop RC aggregate gate requires the platform-specific signature mechanism", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.signing[0], "utf8")); linux.signatureKind = "authenticode"; write(f.signing[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("signing/notarization evidence is incomplete for linux/x64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Desktop RC aggregate gate rejects a signer identity that is not authorized by the bound policy", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.signing[0], "utf8"));
    linux.publicKeySha256 = "9".repeat(64);
    write(f.signing[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("signing/notarization evidence is incomplete for linux/x64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});


test("Desktop RC aggregate gate rejects installer evidence whose installed payload is from a different stage", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.installer[0], "utf8"));
    linux.installedStageManifestSha256 = "f".repeat(64);
    write(f.installer[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("installer upgrade/rollback evidence is incomplete for linux/x64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Desktop RC aggregate gate rejects recovery evidence from a different packaged stage", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.recovery[0], "utf8"));
    linux.stageManifestSha256 = "f".repeat(64);
    write(f.recovery[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("packaged crash/recovery evidence is incomplete for linux/x64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Desktop RC aggregate gate rejects a native preflight that is not bound to the official pinned Electron asset", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.nativePreflight[0], "utf8"));
    linux.electronArchiveAsset = "electron-v43.2.0-linux-x64.zip";
    write(f.nativePreflight[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("official Electron native preflight is incomplete for linux/x64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});


test("Desktop RC aggregate gate rejects Windows/macOS evidence when the installed executable differs from the signed executable", () => {
  const f = fixture();
  try {
    const mac = JSON.parse(fs.readFileSync(f.installer[1], "utf8"));
    mac.installedExecutableSha256 = "6".repeat(64);
    write(f.installer[1], mac);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("signing/notarization evidence is incomplete for darwin/arm64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});


test("Desktop RC aggregate gate rejects preflight/non-native installer evidence even when success booleans are true", () => {
  const f = fixture();
  try {
    const linux = JSON.parse(fs.readFileSync(f.installer[0], "utf8"));
    linux.installerKind = "portable-directory-preflight";
    linux.nativePlatformVerified = false;
    write(f.installer[0], linux);
    const result = run(f);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.errors.some((row: string) => row.includes("installer upgrade/rollback evidence is incomplete for linux/x64")));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
