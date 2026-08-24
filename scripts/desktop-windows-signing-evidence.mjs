#!/usr/bin/env node
/** Collect native Windows Authenticode evidence for the exact candidate executable and release artifact. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeSigningEvidenceContext } from "./lib/desktop-native-signing-evidence.mjs";
import { verifyNativeStageSignature } from "./lib/desktop-native-signature-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function usage() { console.log("Usage: node scripts/desktop-windows-signing-evidence.mjs --provenance file --artifact file --stage dir --signing-policy policy.json --arch x64|arm64 [--out evidence.json]"); }
if (process.argv.includes("--help") || process.argv.includes("-h")) { usage(); process.exit(0); }
if (process.platform !== "win32") fail("Windows Authenticode RC evidence must be collected on native Windows");
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]; if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["provenance", "artifact", "stage", "signing-policy", "arch"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
try {
  const args = parseArgs(process.argv.slice(2));
  const context = loadNativeSigningEvidenceContext({ root: ROOT, provenance: args.provenance, artifact: args.artifact, stage: args.stage, signingPolicy: args["signing-policy"], platform: "win32", arch: args.arch, signatureKind: "authenticode" });
  const native = verifyNativeStageSignature({ stage: args.stage, signingPolicy: args["signing-policy"], platform: "win32", arch: args.arch });
  if (native.stageManifestSha256 !== context.stage.manifestSha256 || native.executableSha256 !== context.executableDigest.sha256) fail("Windows signing preflight does not bind the provenance-authorized stage executable");
  const evidence = {
    schemaVersion: 1, kind: "freesek-desktop-signing-evidence", passed: true,
    version: context.version, gitCommit: context.gitCommit, platform: "win32", arch: args.arch,
    artifactSha256: context.artifact.sha256, stageManifestSha256: context.stage.manifestSha256,
    signedExecutableSha256: context.executableDigest.sha256,
    provenanceSha256: context.provenanceSha256, signingPolicySha256: context.signingPolicySha256,
    signatureKind: native.signatureKind, signatureVerified: native.signatureVerified, signerIdentityMatched: native.signerIdentityMatched,
    certificateSha256: native.certificateSha256, certificateSubject: native.certificateSubject, certificateIssuer: native.certificateIssuer,
  };
  const text = JSON.stringify(evidence, null, 2) + "\n";
  if (args.out) { const out = path.resolve(args.out); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, { encoding: "utf8", mode: 0o644 }); }
  process.stdout.write(text);
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
