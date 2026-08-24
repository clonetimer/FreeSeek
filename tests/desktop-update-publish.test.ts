import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const DESKTOP = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "desktop", "package.json"), "utf8"));

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { cwd: ROOT, encoding: "utf8" });
}
function writeProvenance(file: string, overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: "freeseek-desktop-release-provenance",
    version: PKG.version,
    desktopVersion: PKG.version,
    electronVersionPin: DESKTOP.devDependencies.electron,
    gitCommit: "1".repeat(40),
    gitTreeState: "clean",
    generatedAt: "2026-08-20T12:00:00.000Z",
    evidenceHost: { platform: "linux", arch: "x64", node: process.version },
    artifacts: [
      { platform: "linux", arch: "x64", name: "FreeSeek-linux-x64.tar.gz", electronVersion: DESKTOP.devDependencies.electron, stageManifestSha256: "c".repeat(64), sha256: "a".repeat(64), size: 123 },
      { platform: "darwin", arch: "arm64", name: "FreeSeek-darwin-arm64.zip", electronVersion: DESKTOP.devDependencies.electron, stageManifestSha256: "d".repeat(64), sha256: "b".repeat(64), size: 456 },
    ],
    ...overrides,
  }, null, 2) + "\n", { mode: 0o644 });
}

test("Desktop update publication builds provenance-bound manifest and signs exact bytes with Ed25519", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-update-publish-"));
  try {
    const provenance = path.join(temp, "freesek-desktop-provenance.json");
    const manifest = path.join(temp, "update-beta.json");
    const signature = `${manifest}.sig`;
    writeProvenance(provenance);
    const generated = run("desktop-update-manifest.mjs", [
      "--provenance", provenance,
      "--base-url", "https://updates.example/releases/current",
      "--channel", "beta",
      "--issued-at", "2026-08-20T12:00:00Z",
      "--expires-at", "2026-08-27T12:00:00Z",
      "--out", manifest,
    ]);
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    const provenanceBytes = fs.readFileSync(provenance);
    const manifestBytes = fs.readFileSync(manifest);
    const parsed = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.version, PKG.version);
    assert.equal(parsed.provenance.sha256, crypto.createHash("sha256").update(provenanceBytes).digest("hex"));
    assert.equal(parsed.provenance.size, provenanceBytes.length);
    assert.equal(parsed.provenance.url, "https://updates.example/releases/current/freesek-desktop-provenance.json");
    assert.deepEqual(parsed.artifacts.map((row: any) => `${row.platform}/${row.arch}`), ["darwin/arm64", "linux/x64"]);
    assert.ok(parsed.artifacts.every((row: any) => row.url.startsWith("https://updates.example/releases/current/")));

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const keyFile = path.join(temp, "update-signing-key.pem");
    fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    const signed = run("desktop-update-sign.mjs", ["--manifest", manifest, "--private-key", keyFile, "--out", signature]);
    assert.equal(signed.status, 0, signed.stderr || signed.stdout);
    const sig = fs.readFileSync(signature);
    assert.equal(sig.length, 64);
    assert.equal(crypto.verify(null, manifestBytes, publicKey, sig), true);
    const tampered = Buffer.from(manifestBytes.toString("utf8").replace(PKG.version, `${PKG.version}-tampered`));
    assert.equal(crypto.verify(null, tampered, publicKey, sig), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Desktop update publication rejects dirty provenance, insecure URLs and weak signing-key permissions", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-update-publish-gate-"));
  try {
    const provenance = path.join(temp, "provenance.json");
    const manifest = path.join(temp, "manifest.json");
    writeProvenance(provenance, { gitTreeState: "dirty" });
    const dirty = run("desktop-update-manifest.mjs", ["--provenance", provenance, "--base-url", "https://updates.example/r/", "--channel", "beta", "--issued-at", "2026-08-20T12:00:00Z", "--expires-at", "2026-08-21T12:00:00Z", "--out", manifest]);
    assert.notEqual(dirty.status, 0); assert.match(dirty.stderr, /clean release provenance/);

    writeProvenance(provenance);
    const insecure = run("desktop-update-manifest.mjs", ["--provenance", provenance, "--base-url", "http://updates.example/r/", "--channel", "beta", "--issued-at", "2026-08-20T12:00:00Z", "--expires-at", "2026-08-21T12:00:00Z", "--out", manifest]);
    assert.notEqual(insecure.status, 0); assert.match(insecure.stderr, /must use HTTPS/);

    const good = run("desktop-update-manifest.mjs", ["--provenance", provenance, "--base-url", "https://updates.example/r/", "--channel", "beta", "--issued-at", "2026-08-20T12:00:00Z", "--expires-at", "2026-08-21T12:00:00Z", "--out", manifest]);
    assert.equal(good.status, 0, good.stderr || good.stdout);
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const keyFile = path.join(temp, "weak-key.pem");
    fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o644 });
    fs.chmodSync(keyFile, 0o644);
    if (process.platform === "win32") { t.diagnostic("POSIX signing-key permission gate not applicable on Windows"); return; }
    const weak = run("desktop-update-sign.mjs", ["--manifest", manifest, "--private-key", keyFile]);
    assert.notEqual(weak.status, 0); assert.match(weak.stderr, /permissions must not allow group\/other access/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
