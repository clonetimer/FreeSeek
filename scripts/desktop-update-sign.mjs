#!/usr/bin/env node
/** Sign exact Desktop update-manifest bytes with an Ed25519 private key stored outside the repository. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") out.manifest = argv[++i] ?? fail("--manifest requires a file");
    else if (arg === "--private-key") out.privateKey = argv[++i] ?? fail("--private-key requires a file");
    else if (arg === "--out") out.out = argv[++i] ?? fail("--out requires a file");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/desktop-update-sign.mjs --manifest update-rc.json --private-key /secure/ed25519.pem [--out update-rc.json.sig]");
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!out.manifest || !out.privateKey) fail("--manifest and --private-key are required");
  return out;
}
function regularFile(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) fail(`${label} missing: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink: ${absolute}`);
  if (!stat.isFile()) fail(`${label} must be a regular file: ${absolute}`);
  return { absolute, stat };
}

const args = parseArgs(process.argv.slice(2));
const manifest = regularFile(args.manifest, "update manifest");
const privateKeyFile = regularFile(args.privateKey, "signing private key");
if (process.platform !== "win32" && (privateKeyFile.stat.mode & 0o077) !== 0) fail("signing private key permissions must not allow group/other access");
const manifestBytes = fs.readFileSync(manifest.absolute);
let parsed;
try { parsed = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("update manifest must be valid JSON"); }
if (parsed?.schemaVersion !== 2 || !parsed.provenance || !Array.isArray(parsed.artifacts) || !parsed.artifacts.length) fail("update manifest is not provenance-bound schema v2");

let key;
try { key = crypto.createPrivateKey(fs.readFileSync(privateKeyFile.absolute)); } catch { fail("unable to parse signing private key"); }
if (key.asymmetricKeyType !== "ed25519") fail(`signing private key must be Ed25519, got ${key.asymmetricKeyType ?? "unknown"}`);
const signature = crypto.sign(null, manifestBytes, key);
const outFile = path.resolve(args.out ?? `${manifest.absolute}.sig`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, signature, { mode: 0o644 });
const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
console.log(JSON.stringify({
  out: outFile,
  signatureBytes: signature.length,
  manifestSha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),
  publicKeySha256: crypto.createHash("sha256").update(publicKey).digest("hex"),
}, null, 2));
