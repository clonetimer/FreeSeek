import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const VERIFY = path.join(ROOT, "scripts/desktop-electron-runtime-verify.mjs");
const SIGNING_PREFLIGHT = path.join(ROOT, "scripts/desktop-native-signing-preflight.mjs");
const TARGET_PREFLIGHT = path.join(ROOT, "scripts/desktop-native-target-preflight.mjs");
const TARGET_PACKAGE = path.join(ROOT, "scripts/desktop-native-target-package.mjs");
const TARGET_EVIDENCE = path.join(ROOT, "scripts/desktop-native-target-evidence.mjs");
const RECOVERY_SMOKE = path.join(ROOT, "scripts/desktop-packaged-recovery-smoke.mjs");

function sha256(bytes: Buffer | string): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function writeShasums(file: string, asset: string, archive: string): void {
  fs.writeFileSync(file, `${sha256(fs.readFileSync(archive))}  ${asset}\n`, "utf8");
}

function makeLinuxStage(temp: string): string {
  const electron = path.join(temp, "electron-dist");
  fs.mkdirSync(path.join(electron, "resources"), { recursive: true });
  fs.writeFileSync(path.join(electron, "electron"), "fake-electron");
  fs.writeFileSync(path.join(electron, "version"), "43.3.0\n");
  const desktopDist = path.join(temp, "desktop-dist", "apps/desktop/src");
  fs.mkdirSync(desktopDist, { recursive: true });
  for (const name of ["main.js", "preload.js", "index.html"]) fs.writeFileSync(path.join(desktopDist, name), name);
  const sidecar = path.join(temp, "freeseek-acp.js"); fs.writeFileSync(sidecar, "#!/usr/bin/env node\n");
  const out = path.join(temp, "stage-out");
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "scripts/desktop-portable-stage.mjs"), "--skip-build", "--platform", "linux", "--arch", "x64",
    "--electron-dist", electron, "--desktop-dist", path.join(temp, "desktop-dist"), "--sidecar", sidecar, "--out", out,
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return path.join(out, `FreeSeek-${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version}-linux-x64`);
}

test("Electron runtime verifier binds archive bytes to the exact pinned release asset entry", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-electron-integrity-"));
  try {
    const archive = path.join(temp, "download.zip"), shasums = path.join(temp, "SHASUMS256.txt"), out = path.join(temp, "evidence.json");
    fs.writeFileSync(archive, "electron-archive-bytes");
    writeShasums(shasums, "electron-v43.3.0-linux-x64.zip", archive);
    const ok = spawnSync(process.execPath, [VERIFY, "--archive", archive, "--shasums", shasums, "--platform", "linux", "--arch", "x64", "--out", out], { cwd: ROOT, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(report.passed, true); assert.equal(report.electronVersion, "43.3.0"); assert.equal(report.assetName, "electron-v43.3.0-linux-x64.zip");
    fs.appendFileSync(archive, "tamper");
    const bad = spawnSync(process.execPath, [VERIFY, "--archive", archive, "--shasums", shasums, "--platform", "linux", "--arch", "x64"], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /SHA-256 mismatch/);
    const wrongTarget = spawnSync(process.execPath, [VERIFY, "--archive", archive, "--shasums", shasums, "--platform", "darwin", "--arch", "arm64"], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(wrongTarget.status, 0); assert.match(wrongTarget.stderr, /exactly one entry/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Electron runtime verifier can extract only a checksum-verified native archive", { skip: process.platform !== "linux" }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-electron-extract-"));
  try {
    const payload = path.join(temp, "payload"); fs.mkdirSync(path.join(payload, "resources"), { recursive: true });
    fs.writeFileSync(path.join(payload, "electron"), "fake-electron"); fs.writeFileSync(path.join(payload, "version"), "43.3.0\n");
    const archive = path.join(temp, "electron.zip");
    const zipped = spawnSync("zip", ["-q", "-r", archive, "."], { cwd: payload, encoding: "utf8" }); assert.equal(zipped.status, 0, zipped.stderr);
    const shasums = path.join(temp, "SHASUMS256.txt"); writeShasums(shasums, "electron-v43.3.0-linux-x64.zip", archive);
    const extracted = path.join(temp, "extracted");
    const result = spawnSync(process.execPath, [VERIFY, "--archive", archive, "--shasums", shasums, "--platform", "linux", "--arch", "x64", "--extract", extracted], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout); assert.equal(report.passed, true); assert.equal(report.extractedDistribution, extracted); assert.ok(fs.existsSync(path.join(extracted, "electron")));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Linux native signing preflight explicitly defers release authentication to provenance-bound Ed25519", { skip: process.platform !== "linux" }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-native-sign-preflight-"));
  try {
    const stage = makeLinuxStage(temp), policy = path.join(temp, "signing-policy.json");
    fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, kind: "freesek-desktop-signing-policy", policyId: "test", targets: [{ platform: "linux", arch: "x64", signatureKind: "ed25519-update-manifest", publicKeySha256: "a".repeat(64) }] }, null, 2) + "\n");
    const result = spawnSync(process.execPath, [SIGNING_PREFLIGHT, "--stage", stage, "--signing-policy", policy, "--arch", "x64"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout); assert.equal(report.passed, true); assert.equal(report.updateManifestSigningDeferred, true); assert.equal(report.signatureVerified, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("native validation workflow exposes fixed phase contracts without arbitrary installer/signing commands", () => {
  for (const script of [TARGET_PREFLIGHT, TARGET_PACKAGE, TARGET_EVIDENCE, RECOVERY_SMOKE]) {
    const help = spawnSync(process.execPath, [script, "--help"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Usage:/);
  }
  const preflight = fs.readFileSync(TARGET_PREFLIGHT, "utf8"), packaging = fs.readFileSync(TARGET_PACKAGE, "utf8"), evidence = fs.readFileSync(TARGET_EVIDENCE, "utf8"), recovery = fs.readFileSync(RECOVERY_SMOKE, "utf8");
  assert.match(preflight, /desktop-build-prod\.mjs/); assert.match(preflight, /FREESEEK_DESKTOP_E2E_VERIFY_SECRET/); assert.match(preflight, /prepareElectronReleaseDistribution/);
  assert.match(packaging, /verifyNativeStageSignature/); assert.match(packaging, /packageNativePortableStage/); assert.match(packaging, /native-preflight/); assert.match(packaging, /electronArchiveSha256/); assert.doesNotMatch(packaging, /--installer-command|--sign-command/);
  assert.match(packaging, /desktop-packaged-recovery-smoke\.mjs/); assert.match(recovery, /recovery-interrupt/); assert.match(recovery, /SIGKILL|taskkill/);
  assert.match(recovery, /child\.once\("close"/); assert.match(recovery, /closeAllConnections/); assert.match(recovery, /maxRetries/);
  assert.match(recovery, /startProvider\("hang"\)/); assert.match(recovery, /startProvider\("success"\)/); assert.match(recovery, /value\?\.passed === false/);
  assert.match(recovery, /recovery temp cleanup deferred/); assert.match(recovery, /if \(second && !second\.closed\(\)\)/);
  assert.match(evidence, /desktop-native-installer-evidence\.mjs/); assert.match(evidence, /desktop-windows-signing-evidence\.mjs/); assert.match(evidence, /desktop-macos-signing-evidence\.mjs/); assert.match(evidence, /recovery-smoke/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["desktop:electron:verify"], "node scripts/desktop-electron-runtime-verify.mjs");
  assert.equal(pkg.scripts["desktop:native:preflight"], "node scripts/desktop-native-target-preflight.mjs");
  assert.equal(pkg.scripts["desktop:native:package"], "node scripts/desktop-native-target-package.mjs");
  assert.equal(pkg.scripts["desktop:native:evidence"], "node scripts/desktop-native-target-evidence.mjs");
  assert.equal(pkg.scripts["desktop:native:installer:baseline"], "node scripts/desktop-native-installer-baseline.mjs");
  assert.equal(pkg.scripts["desktop:stable:prepare"], "node scripts/desktop-stable-prepare.mjs");
  const baseline = fs.readFileSync(path.join(ROOT, "scripts/desktop-native-installer-baseline.mjs"), "utf8");
  assert.match(baseline, /clean committed worktree/);
  assert.match(baseline, /freesek-desktop-native-target-preflight/);
  assert.match(baseline, /releaseEvidenceEligible:\s*false/);
  assert.match(baseline, /packageNativePortableStage/);
});
