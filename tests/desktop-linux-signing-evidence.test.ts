import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/desktop-linux-signing-evidence.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const COMMIT = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout).trim();
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/desktop/package.json"), "utf8")).devDependencies.electron;
function sha(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-linux-signing-evidence-"));
  const artifact = path.join(dir, "FreeSeek-linux-x64.tar.gz");
  fs.writeFileSync(artifact, Buffer.from("real-linux-artifact-bytes"));
  const artifactBytes = fs.readFileSync(artifact);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyFile = path.join(dir, "public.pem");
  fs.writeFileSync(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
  const publicDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const signingPolicyFile = path.join(dir, "signing-policy.json");
  fs.writeFileSync(signingPolicyFile, JSON.stringify({
    schemaVersion: 1, kind: "freesek-desktop-signing-policy", policyId: "linux-test-policy",
    targets: [{ platform: "linux", arch: "x64", signatureKind: "ed25519-update-manifest", publicKeySha256: sha(publicDer) }],
  }, null, 2) + "\n");
  const signingPolicyBytes = fs.readFileSync(signingPolicyFile);
  const provenance = {
    schemaVersion: 1,
    kind: "freeseek-desktop-release-provenance",
    version: VERSION,
    desktopVersion: VERSION,
    electronVersionPin: PIN,
    gitCommit: COMMIT,
    gitTreeState: "clean",
    generatedAt: "2026-08-20T12:00:00.000Z",
    signingPolicy: { policyId: "linux-test-policy", sha256: sha(signingPolicyBytes), size: signingPolicyBytes.length },
    artifacts: [{
      platform: "linux", arch: "x64", name: path.basename(artifact), electronVersion: PIN,
      stageManifestSha256: "a".repeat(64), sha256: sha(artifactBytes), size: artifactBytes.length,
    }],
  };
  const provenanceFile = path.join(dir, "freesek-desktop-provenance.json");
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + "\n");
  const provenanceBytes = fs.readFileSync(provenanceFile);
  const manifest = {
    schemaVersion: 2, channel: "rc", version: VERSION,
    issuedAt: "2026-08-20T12:00:00.000Z", expiresAt: "2026-08-27T12:00:00.000Z",
    provenance: { url: "https://releases.example.invalid/freesek-desktop-provenance.json", sha256: sha(provenanceBytes), size: provenanceBytes.length },
    artifacts: [{ platform: "linux", arch: "x64", url: `https://releases.example.invalid/${path.basename(artifact)}`, sha256: sha(artifactBytes), size: artifactBytes.length }],
  };
  const manifestFile = path.join(dir, "update-rc.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  const manifestBytes = fs.readFileSync(manifestFile);
  const signatureFile = path.join(dir, "update-rc.json.sig");
  fs.writeFileSync(signatureFile, crypto.sign(null, manifestBytes, privateKey));
  return { dir, artifact, provenanceFile, manifestFile, signatureFile, publicKeyFile, signingPolicyFile, privateKey };
}
function run(f: ReturnType<typeof fixture>, out?: string, publicKeyFile = f.publicKeyFile) {
  const args = [SCRIPT, "--provenance", f.provenanceFile, "--manifest", f.manifestFile, "--signature", f.signatureFile, "--public-key", publicKeyFile, "--artifact", f.artifact, "--signing-policy", f.signingPolicyFile, "--arch", "x64"];
  if (out) args.push("--out", out);
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
}

test("Linux signing evidence authenticates the exact artifact through the Ed25519 update-manifest/provenance chain", () => {
  const f = fixture();
  try {
    const out = path.join(f.dir, "linux-signing.json");
    const result = run(f, out);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(evidence.kind, "freeseek-desktop-signing-evidence");
    assert.equal(evidence.signatureKind, "ed25519-update-manifest");
    assert.equal(evidence.signatureVerified, true);
    assert.equal(evidence.platform, "linux");
    assert.equal(evidence.arch, "x64");
    assert.equal(evidence.version, VERSION);
    assert.equal(evidence.gitCommit, COMMIT);
    assert.equal(evidence.provenanceSha256, sha(fs.readFileSync(f.provenanceFile)));
    assert.equal(evidence.stageManifestSha256, "a".repeat(64));
    assert.match(evidence.publicKeySha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.signingPolicySha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.signerIdentityMatched, true);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Linux signing evidence rejects a tampered artifact and a bad update signature", () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.artifact, "tamper");
    const artifactResult = run(f);
    assert.notEqual(artifactResult.status, 0);
    assert.match(artifactResult.stderr, /artifact does not match signed release evidence/);

    fs.writeFileSync(f.artifact, Buffer.from("real-linux-artifact-bytes"));
    const sig = fs.readFileSync(f.signatureFile); sig[0] ^= 0xff; fs.writeFileSync(f.signatureFile, sig);
    const signatureResult = run(f);
    assert.notEqual(signatureResult.status, 0);
    assert.match(signatureResult.stderr, /signature verification failed/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Linux signing evidence rejects a cryptographically valid release signed by a key not authorized by the bound policy", () => {
  const f = fixture();
  try {
    const { publicKey: otherPublicKey } = crypto.generateKeyPairSync("ed25519");
    const otherDer = otherPublicKey.export({ type: "spki", format: "der" }) as Buffer;
    const policy = JSON.parse(fs.readFileSync(f.signingPolicyFile, "utf8"));
    policy.targets[0].publicKeySha256 = sha(otherDer);
    fs.writeFileSync(f.signingPolicyFile, JSON.stringify(policy, null, 2) + "\n");
    const policyBytes = fs.readFileSync(f.signingPolicyFile);

    const provenance = JSON.parse(fs.readFileSync(f.provenanceFile, "utf8"));
    provenance.signingPolicy.sha256 = sha(policyBytes);
    provenance.signingPolicy.size = policyBytes.length;
    fs.writeFileSync(f.provenanceFile, JSON.stringify(provenance, null, 2) + "\n");
    const provenanceBytes = fs.readFileSync(f.provenanceFile);

    const manifest = JSON.parse(fs.readFileSync(f.manifestFile, "utf8"));
    manifest.provenance.sha256 = sha(provenanceBytes);
    manifest.provenance.size = provenanceBytes.length;
    fs.writeFileSync(f.manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(f.signatureFile, crypto.sign(null, fs.readFileSync(f.manifestFile), f.privateKey));

    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not authorize this Ed25519 public key/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
