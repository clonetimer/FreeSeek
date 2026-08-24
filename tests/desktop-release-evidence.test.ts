import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function digest(data: Buffer): string { return crypto.createHash("sha256").update(data).digest("hex"); }
function runEvidence(args: string[]) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts/desktop-release-evidence.mjs"), ...args], { cwd: ROOT, encoding: "utf8" });
}

function writeSigningPolicy(file: string, targets: Array<{ platform: string; arch: string }>) {
  const rows = targets.map(({ platform, arch }) => platform === "linux"
    ? { platform, arch, signatureKind: "ed25519-update-manifest", publicKeySha256: "c".repeat(64) }
    : platform === "win32"
      ? { platform, arch, signatureKind: "authenticode", certificateSha256: "d".repeat(64) }
      : { platform, arch, signatureKind: "apple-codesign", teamIdentifier: "ABCDE12345", notarizationRequired: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: "freesek-desktop-signing-policy", policyId: "desktop-release-test-policy", targets: rows }, null, 2) + "\n");
  return file;
}

function writeStageManifest(file: string, platform: string, arch: string, electronVersion = "43.3.0") {
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, kind: "freeseek-desktop-portable-stage", version: PKG.version,
    platform, arch, electronVersion, expectedElectronVersion: "43.3.0", versionMatched: electronVersion === "43.3.0",
    electronExecutable: "FreeSeek", files: [],
  }, null, 2) + "\n");
}

test("Desktop release evidence binds checksums to commit, exact runtime stage and target", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-desktop-evidence-"));
  try {
    const linuxData = Buffer.from("linux desktop artifact\n"); const macData = Buffer.alloc(1024 * 1024 + 11, 9);
    const linux = path.join(temp, "FreeSeek-linux-x64.tar.gz"); const mac = path.join(temp, "FreeSeek-darwin-arm64.zip");
    const linuxManifest = path.join(temp, "linux-stage.json"); const macManifest = path.join(temp, "mac-stage.json");
    const signingPolicy = writeSigningPolicy(path.join(temp, "signing-policy.json"), [{ platform: "linux", arch: "x64" }, { platform: "darwin", arch: "arm64" }]);
    fs.writeFileSync(linux, linuxData); fs.writeFileSync(mac, macData);
    writeStageManifest(linuxManifest, "linux", "x64"); writeStageManifest(macManifest, "darwin", "arm64");
    const out = path.join(temp, "evidence");
    const result = runEvidence([
      "--allow-dirty", "--out", out, "--signing-policy", signingPolicy,
      "--artifact", `linux/x64=${linux}`, "--stage-manifest", `linux/x64=${linuxManifest}`,
      "--artifact", `darwin/arm64=${mac}`, "--stage-manifest", `darwin/arm64=${macManifest}`,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sums = fs.readFileSync(path.join(out, "SHA256SUMS.txt"), "utf8");
    assert.match(sums, new RegExp(`${digest(macData)}  FreeSeek-darwin-arm64\\.zip`));
    assert.match(sums, new RegExp(`${digest(linuxData)}  FreeSeek-linux-x64\\.tar\\.gz`));
    const provenance = JSON.parse(fs.readFileSync(path.join(out, "freesek-desktop-provenance.json"), "utf8"));
    assert.equal(provenance.kind, "freeseek-desktop-release-provenance");
    assert.equal(provenance.version, PKG.version); assert.equal(provenance.desktopVersion, PKG.version);
    assert.equal(provenance.electronVersionPin, "43.3.0"); assert.match(provenance.gitCommit, /^[a-f0-9]{40}$/);
    assert.ok(["clean", "dirty"].includes(provenance.gitTreeState));
    assert.equal(provenance.signingPolicy.policyId, "desktop-release-test-policy");
    assert.match(provenance.signingPolicy.sha256, /^[a-f0-9]{64}$/); assert.ok(provenance.signingPolicy.size > 0);
    assert.deepEqual(provenance.artifacts.map((row: any) => `${row.platform}/${row.arch}`).sort(), ["darwin/arm64", "linux/x64"]);
    assert.ok(provenance.artifacts.every((row: any) => row.electronVersion === "43.3.0" && /^[a-f0-9]{64}$/.test(row.stageManifestSha256)));
    assert.ok(provenance.artifacts.every((row: any) => /^[a-f0-9]{64}$/.test(row.sha256) && row.size > 0));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Desktop release evidence rejects duplicate targets, false labels and mismatched runtime stages", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-desktop-evidence-gate-"));
  try {
    const one = path.join(temp, "one.bin"); const two = path.join(temp, "two.bin"); const manifest = path.join(temp, "stage.json");
    const signingPolicy = writeSigningPolicy(path.join(temp, "signing-policy.json"), [{ platform: "linux", arch: "x64" }]);
    fs.writeFileSync(one, "one"); fs.writeFileSync(two, "two"); writeStageManifest(manifest, "linux", "x64");
    const duplicate = runEvidence(["--allow-dirty", "--signing-policy", signingPolicy, "--artifact", `linux/x64=${one}`, "--stage-manifest", `linux/x64=${manifest}`, "--artifact", `linux/x64=${two}`, "--stage-manifest", `linux/x64=${manifest}`]);
    assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /duplicate Desktop stage-manifest target|duplicate Desktop artifact target/);
    const mismatchedVersion = PKG.version === "9.9.9" ? "9.9.8" : "9.9.9";
    const mislabeled = runEvidence(["--allow-dirty", "--signing-policy", signingPolicy, "--version", mismatchedVersion, "--artifact", `linux/x64=${one}`, "--stage-manifest", `linux/x64=${manifest}`]);
    assert.notEqual(mislabeled.status, 0); assert.match(mislabeled.stderr, /does not match committed package version/);
    writeStageManifest(manifest, "linux", "x64", "43.2.0");
    const runtimeMismatch = runEvidence(["--allow-dirty", "--signing-policy", signingPolicy, "--artifact", `linux/x64=${one}`, "--stage-manifest", `linux/x64=${manifest}`]);
    assert.notEqual(runtimeMismatch.status, 0); assert.match(runtimeMismatch.stderr, /not built with exact Electron 43\.3\.0/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Desktop release evidence rejects symlink artifacts", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-desktop-evidence-link-"));
  try {
    const source = path.join(temp, "source.bin"); const link = path.join(temp, "link.bin"); const manifest = path.join(temp, "stage.json");
    const signingPolicy = writeSigningPolicy(path.join(temp, "signing-policy.json"), [{ platform: "linux", arch: "x64" }]);
    fs.writeFileSync(source, "source"); writeStageManifest(manifest, "linux", "x64");
    try { fs.symlinkSync(source, link, "file"); } catch (error) { t.diagnostic(`symlink creation skipped: ${String(error)}`); return; }
    const result = runEvidence(["--allow-dirty", "--signing-policy", signingPolicy, "--artifact", `linux/x64=${link}`, "--stage-manifest", `linux/x64=${manifest}`]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /must not be a symlink/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
