#!/usr/bin/env node
/** Verify target-native stage signing/notarization before final portable artifact packaging. */
import * as fs from "node:fs";
import * as path from "node:path";
import { verifyNativeStageSignature } from "./lib/desktop-native-signature-preflight.mjs";
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node scripts/desktop-native-signing-preflight.mjs --stage dir --signing-policy policy.json --arch x64|arm64 [--out evidence.json]"); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["stage", "signing-policy", "arch"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
try {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyNativeStageSignature({ stage: args.stage, signingPolicy: args["signing-policy"], arch: args.arch });
  const report = { schemaVersion: 1, kind: "freesek-desktop-native-signing-preflight", passed: process.platform === "linux" ? result.updateManifestSigningDeferred === true : result.signatureVerified === true && result.signerIdentityMatched === true, ...result };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (args.out) { const out = path.resolve(args.out); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, "utf8"); }
  process.stdout.write(text);
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
