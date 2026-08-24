#!/usr/bin/env node
/** Verify Linux Desktop artifact authenticity through the signed provenance-bound Ed25519 update manifest. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provenance") out.provenance = argv[++i] ?? fail("--provenance requires a file");
    else if (arg === "--manifest") out.manifest = argv[++i] ?? fail("--manifest requires a file");
    else if (arg === "--signature") out.signature = argv[++i] ?? fail("--signature requires a file");
    else if (arg === "--public-key") out.publicKey = argv[++i] ?? fail("--public-key requires a file");
    else if (arg === "--artifact") out.artifact = argv[++i] ?? fail("--artifact requires a file");
    else if (arg === "--signing-policy") out.signingPolicy = argv[++i] ?? fail("--signing-policy requires a file");
    else if (arg === "--arch") out.arch = argv[++i] ?? fail("--arch requires x64|arm64");
    else if (arg === "--out") out.out = argv[++i] ?? fail("--out requires a file");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/desktop-linux-signing-evidence.mjs --provenance file --manifest update.json --signature update.json.sig --public-key ed25519-public.pem --artifact file --signing-policy policy.json --arch x64|arm64 [--out evidence.json]");
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  for (const key of ["provenance", "manifest", "signature", "publicKey", "artifact", "signingPolicy", "arch"]) if (!out[key]) fail(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
function regularFile(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) fail(`${label} missing: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a non-symlink regular file: ${absolute}`);
  return { absolute, stat };
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (bytesRead <= 0) fail(`unexpected EOF while hashing ${file}`);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), size: stat.size };
}
function json(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} must be valid JSON`); } }
function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed`);
  return String(result.stdout ?? "").trim();
}

const args = parseArgs(process.argv.slice(2));
const provenanceFile = regularFile(args.provenance, "release provenance");
const manifestFile = regularFile(args.manifest, "update manifest");
const signatureFile = regularFile(args.signature, "update signature");
const publicKeyFile = regularFile(args.publicKey, "Ed25519 public key");
const artifactFile = regularFile(args.artifact, "Linux artifact");
const signingPolicyFile = regularFile(args.signingPolicy, "Desktop signing policy");
const provenanceBytes = fs.readFileSync(provenanceFile.absolute);
const manifestBytes = fs.readFileSync(manifestFile.absolute);
const signature = fs.readFileSync(signatureFile.absolute);
const provenance = json(provenanceBytes, "release provenance");
const manifest = json(manifestBytes, "update manifest");
const signingPolicyBytes = fs.readFileSync(signingPolicyFile.absolute);
const signingPolicy = json(signingPolicyBytes, "Desktop signing policy");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version);
const gitCommit = git(["rev-parse", "HEAD"]);
if (provenance?.schemaVersion !== 1 || provenance.kind !== "freeseek-desktop-release-provenance" || provenance.gitTreeState !== "clean") fail("Linux signing evidence requires clean release provenance");
if (signingPolicy?.schemaVersion !== 1 || signingPolicy.kind !== "freesek-desktop-signing-policy" || !Array.isArray(signingPolicy.targets)) fail("invalid Desktop signing policy");
if (!provenance.signingPolicy || provenance.signingPolicy.policyId !== signingPolicy.policyId || provenance.signingPolicy.size !== signingPolicyBytes.length || String(provenance.signingPolicy.sha256).toLowerCase() !== sha256(signingPolicyBytes)) fail("release provenance does not bind the supplied Desktop signing policy");
if (provenance.version !== version || provenance.desktopVersion !== version || provenance.gitCommit !== gitCommit) fail("release provenance does not bind the current candidate version/commit");
if (manifest?.schemaVersion !== 2 || manifest.version !== version || !manifest.provenance || !Array.isArray(manifest.artifacts)) fail("invalid provenance-bound update manifest v2");
if (manifest.provenance.size !== provenanceBytes.length || String(manifest.provenance.sha256).toLowerCase() !== sha256(provenanceBytes)) fail("signed update manifest does not bind the supplied release provenance bytes");

let publicKey;
try { publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyFile.absolute)); } catch { fail("unable to parse Ed25519 public key"); }
if (publicKey.asymmetricKeyType !== "ed25519") fail(`public key must be Ed25519, got ${publicKey.asymmetricKeyType ?? "unknown"}`);
if (!crypto.verify(null, manifestBytes, publicKey, signature)) fail("Ed25519 update manifest signature verification failed");

const target = `linux/${args.arch}`;
const manifestRows = manifest.artifacts.filter((row) => row?.platform === "linux" && row?.arch === args.arch);
const provenanceRows = provenance.artifacts?.filter((row) => row?.platform === "linux" && row?.arch === args.arch) ?? [];
if (manifestRows.length !== 1 || provenanceRows.length !== 1) fail(`expected exactly one ${target} artifact in manifest and provenance`);
const signedArtifact = manifestRows[0], releaseArtifact = provenanceRows[0];
if (releaseArtifact.name !== path.basename(artifactFile.absolute)) fail(`Linux artifact basename ${path.basename(artifactFile.absolute)} does not match provenance ${releaseArtifact.name}`);
if (signedArtifact.sha256 !== releaseArtifact.sha256 || signedArtifact.size !== releaseArtifact.size) fail("signed update manifest and release provenance disagree on Linux artifact digest/size");
const actual = hashFile(artifactFile.absolute);
if (actual.sha256.toLowerCase() !== String(releaseArtifact.sha256).toLowerCase() || actual.size !== releaseArtifact.size) fail("Linux artifact does not match signed release evidence");

const publicDer = publicKey.export({ type: "spki", format: "der" });
const publicKeySha256 = sha256(publicDer);
const policyRows = signingPolicy.targets.filter((row) => row?.platform === "linux" && row?.arch === args.arch);
if (policyRows.length !== 1 || policyRows[0].signatureKind !== "ed25519-update-manifest" || String(policyRows[0].publicKeySha256).toLowerCase() !== publicKeySha256) fail(`Desktop signing policy does not authorize this Ed25519 public key for ${target}`);
const evidence = {
  schemaVersion: 1,
  kind: "freeseek-desktop-signing-evidence",
  passed: true,
  version,
  gitCommit,
  platform: "linux",
  arch: args.arch,
  artifactSha256: actual.sha256,
  stageManifestSha256: releaseArtifact.stageManifestSha256,
  signatureKind: "ed25519-update-manifest",
  signatureVerified: true,
  manifestSha256: sha256(manifestBytes),
  provenanceSha256: sha256(provenanceBytes),
  signingPolicySha256: sha256(signingPolicyBytes),
  signerIdentityMatched: true,
  publicKeySha256,
};
const text = JSON.stringify(evidence, null, 2) + "\n";
if (args.out) {
  const out = path.resolve(args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, { encoding: "utf8", mode: 0o644 });
}
process.stdout.write(text);
