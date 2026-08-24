#!/usr/bin/env node
/** Create the public Desktop signing-policy file from release signer identities; never accepts private keys. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function usage() { console.log("Usage: node scripts/desktop-signing-policy-create.mjs --policy-id ID [--linux x64=ed25519-public.pem] [--windows x64=certificate-sha256] [--macos arm64=TEAMID] --out policy.json"); }
function parseArgs(argv) {
  const out = { linux: [], windows: [], macos: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { usage(); process.exit(0); }
    if (key === "--linux" || key === "--windows" || key === "--macos") { const value = argv[++i]; if (!value) fail(`${key} requires arch=value`); out[key.slice(2)].push(value); continue; }
    if (key === "--policy-id" || key === "--out") { const value = argv[++i]; if (!value) fail(`${key} requires a value`); out[key.slice(2)] = value; continue; }
    fail(`unknown argument: ${key}`);
  }
  if (!out["policy-id"] || !out.out) fail("--policy-id and --out are required");
  if (!out.linux.length && !out.windows.length && !out.macos.length) fail("at least one signing target is required");
  return out;
}
function splitSpec(spec, label) {
  const at = spec.indexOf("="); if (at <= 0 || at === spec.length - 1) fail(`${label} must use arch=value`);
  const arch = spec.slice(0, at), value = spec.slice(at + 1); if (!/^(x64|arm64)$/.test(arch)) fail(`${label} architecture must be x64 or arm64`); return { arch, value };
}
function normalizeSha256(value, label) {
  const digest = String(value).replace(/[:\s-]/g, "").toLowerCase(); if (!/^[a-f0-9]{64}$/.test(digest)) fail(`${label} must be a SHA-256 fingerprint`); return digest;
}
function linuxTarget(spec) {
  const { arch, value } = splitSpec(spec, "--linux"); const file = path.resolve(value);
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) fail(`Linux Ed25519 public key must be a non-symlink regular file: ${file}`);
  let key; try { key = crypto.createPublicKey(fs.readFileSync(file)); } catch { fail(`unable to parse Linux public key: ${file}`); }
  if (key.asymmetricKeyType !== "ed25519") fail(`Linux public key must be Ed25519, got ${key.asymmetricKeyType ?? "unknown"}`);
  const der = key.export({ type: "spki", format: "der" });
  return { platform: "linux", arch, signatureKind: "ed25519-update-manifest", publicKeySha256: crypto.createHash("sha256").update(der).digest("hex") };
}
function windowsTarget(spec) {
  const { arch, value } = splitSpec(spec, "--windows");
  return { platform: "win32", arch, signatureKind: "authenticode", certificateSha256: normalizeSha256(value, "Windows certificate fingerprint") };
}
function macosTarget(spec) {
  const { arch, value } = splitSpec(spec, "--macos"), teamIdentifier = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier)) fail("Apple Team ID must contain exactly 10 uppercase alphanumeric characters");
  return { platform: "darwin", arch, signatureKind: "apple-codesign", teamIdentifier, notarizationRequired: true };
}
try {
  const args = parseArgs(process.argv.slice(2)), targets = [...args.linux.map(linuxTarget), ...args.windows.map(windowsTarget), ...args.macos.map(macosTarget)];
  targets.sort((a, b) => `${a.platform}/${a.arch}`.localeCompare(`${b.platform}/${b.arch}`));
  const seen = new Set(); for (const row of targets) { const target = `${row.platform}/${row.arch}`; if (seen.has(target)) fail(`duplicate signing target: ${target}`); seen.add(target); }
  const policy = { schemaVersion: 1, kind: "freesek-desktop-signing-policy", policyId: String(args["policy-id"]), targets };
  const text = JSON.stringify(policy, null, 2) + "\n", out = path.resolve(args.out); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(JSON.stringify({ passed: true, policyFile: out, policySha256: crypto.createHash("sha256").update(text).digest("hex"), targets: targets.map((row) => `${row.platform}/${row.arch}`) }, null, 2) + "\n");
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
