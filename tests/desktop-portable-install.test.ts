import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/desktop-portable-install-preflight.mjs");

/**
 * 加载 portable-install 库。注意不能用 `await import(绝对路径)`：本测试经 tsc CJS 发射后
 * 动态 import 会被转成 `require(file://...)`，在 Windows 下必然失败；直接 require 绝对路径
 * （Node>=22.12 原生支持 require(ESM .mjs)）在 tsc 与 esbuild 两种布局下均可用。
 */
function loadPortableLib(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(ROOT, "scripts/lib/desktop-portable-install.mjs"));
}

function sha(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function makeStage(root: string, name: string, version: string, target = "linux/x64"): string {
  const [platform, arch] = target.split("/");
  const stage = path.join(root, name);
  const critical = path.join(stage, "resources/app/package.json");
  fs.mkdirSync(path.dirname(critical), { recursive: true });
  fs.writeFileSync(critical, JSON.stringify({ name: "@freeseek/desktop-portable", version }) + "\n");
  const embeddedManifestPath = platform === "darwin"
    ? "FreeSeek.app/Contents/Resources/freeseek/release-manifest.json"
    : "resources/freeseek/release-manifest.json";
  const manifestBytes = JSON.stringify({
    schemaVersion: 1,
    kind: "freeseek-desktop-portable-stage",
    version,
    platform,
    arch,
    electronVersion: "43.3.0",
    expectedElectronVersion: "43.3.0",
    versionMatched: true,
    electronExecutable: platform === "win32" ? "FreeSeek.exe" : "FreeSeek",
    embeddedManifestPath,
    files: [{ path: "resources/app/package.json", size: fs.statSync(critical).size, sha256: sha(critical) }],
  }, null, 2) + "\n";
  fs.mkdirSync(path.dirname(path.join(stage, embeddedManifestPath)), { recursive: true });
  fs.writeFileSync(path.join(stage, "freesek-release-manifest.json"), manifestBytes);
  fs.writeFileSync(path.join(stage, embeddedManifestPath), manifestBytes);
  return stage;
}

function run(previous: string, candidate: string, out?: string) {
  const args = [SCRIPT, "--previous-stage", previous, "--candidate-stage", candidate];
  if (out) args.push("--out", out);
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
}

test("portable installer preflight performs fresh install, upgrade, and rollback without producing RC installer evidence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-installer-preflight-"));
  try {
    const previous = makeStage(temp, "previous", "0.20.0-dev.3");
    const candidate = makeStage(temp, "candidate", "0.20.0-rc.1");
    const out = path.join(temp, "evidence.json");
    const result = run(previous, candidate, out);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(report.kind, "freeseek-desktop-portable-installer-preflight");
    assert.notEqual(report.kind, "freeseek-desktop-installer-rollback-evidence");
    assert.equal(report.target, "linux/x64");
    assert.equal(report.fromVersion, "0.20.0-dev.3");
    assert.equal(report.toVersion, "0.20.0-rc.1");
    assert.equal(report.freshInstallSucceeded, true);
    assert.equal(report.upgradeSucceeded, true);
    assert.equal(report.rollbackScenarioExecuted, true);
    assert.equal(report.rollbackRestoredPreviousVersion, true);
    assert.equal(report.installedStageManifestSha256, report.candidateStageManifestSha256);
    assert.equal(report.rollbackInstalledStageManifestSha256, report.previousStageManifestSha256);
    assert.equal(report.passed, true);
    assert.match(report.note, /Preflight only/);
    if (process.platform !== "win32") assert.equal(fs.statSync(out).mode & 0o077, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("portable installer preflight rejects non-upgrades and target changes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-installer-gates-"));
  try {
    const previous = makeStage(temp, "previous", "0.20.0-rc.1");
    const same = makeStage(temp, "same", "0.20.0-rc.1");
    const wrongTarget = makeStage(temp, "wrong-target", "0.20.0-rc.2", "win32/x64");
    const sameResult = run(previous, same);
    assert.notEqual(sameResult.status, 0);
    assert.match(sameResult.stderr, /Refusing non-upgrade portable install/);
    const targetResult = run(previous, wrongTarget);
    assert.notEqual(targetResult.status, 0);
    assert.match(targetResult.stderr, /does not match expected linux\/x64/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("portable installer preflight validates critical file digests before any install swap", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-installer-digest-"));
  try {
    const previous = makeStage(temp, "previous", "0.20.0-dev.3");
    const candidate = makeStage(temp, "candidate", "0.20.0-rc.1");
    fs.appendFileSync(path.join(candidate, "resources/app/package.json"), "tampered\n");
    const result = run(previous, candidate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /critical file digest mismatch/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});


test("portable installer preflight rejects a stage whose embedded manifest diverges from its root evidence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-installer-embedded-manifest-"));
  try {
    const previous = makeStage(temp, "previous", "0.20.0-dev.3");
    const candidate = makeStage(temp, "candidate", "0.20.0-rc.1");
    const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "freesek-release-manifest.json"), "utf8"));
    fs.appendFileSync(path.join(candidate, manifest.embeddedManifestPath), "tampered\n");
    const result = run(previous, candidate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /embedded stage manifest does not match stage-root manifest bytes/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("portable uninstall validates the installed payload and removes current/previous/state transactionally", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-uninstall-"));
  try {
    const previous = makeStage(temp, "previous", "0.20.0-dev.2");
    const candidate = makeStage(temp, "candidate", "0.20.0-dev.3");
    const installRoot = path.join(temp, "install");
    const lib = loadPortableLib();
    lib.installPortableStage(previous, installRoot);
    lib.installPortableStage(candidate, installRoot);
    const removed = lib.uninstallPortableDesktop(installRoot);
    assert.equal(removed.removedVersion, "0.20.0-dev.3");
    assert.equal(removed.previousVersion, "0.20.0-dev.2");
    assert.equal(lib.readPortableInstallState(installRoot), null);
    assert.equal(fs.existsSync(path.join(installRoot, "current")), false);
    assert.equal(fs.existsSync(path.join(installRoot, "previous")), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("portable uninstall fails closed when installed payload no longer matches install state", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-uninstall-tamper-"));
  try {
    const candidate = makeStage(temp, "candidate", "0.20.0-dev.3");
    const installRoot = path.join(temp, "install");
    const lib = loadPortableLib();
    lib.installPortableStage(candidate, installRoot);
    fs.appendFileSync(path.join(installRoot, "current/resources/app/package.json"), "tampered\n");
    assert.throws(() => lib.uninstallPortableDesktop(installRoot), /critical file digest mismatch/);
    assert.notEqual(lib.readPortableInstallState(installRoot), null);
    assert.equal(fs.existsSync(path.join(installRoot, "current")), true);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
