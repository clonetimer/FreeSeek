#!/usr/bin/env node
/** Build an unsigned Desktop update manifest from release provenance. Signing is a separate key-custody step. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANNELS = new Set(["stable", "rc", "beta"]);

function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function requireHttps(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be an absolute URL`); }
  if (url.protocol !== "https:") fail(`${label} must use HTTPS`);
  if (url.username || url.password) fail(`${label} must not embed credentials`);
  return url;
}
function hashBytes(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function parseInstant(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(`${label} must be a valid timestamp`);
  return new Date(time).toISOString();
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provenance") out.provenance = argv[++i] ?? fail("--provenance requires a file");
    else if (arg === "--base-url") out.baseUrl = argv[++i] ?? fail("--base-url requires a URL");
    else if (arg === "--channel") out.channel = argv[++i] ?? fail("--channel requires stable|rc|beta");
    else if (arg === "--issued-at") out.issuedAt = argv[++i] ?? fail("--issued-at requires a timestamp");
    else if (arg === "--expires-at") out.expiresAt = argv[++i] ?? fail("--expires-at requires a timestamp");
    else if (arg === "--out") out.out = argv[++i] ?? fail("--out requires a file");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/desktop-update-manifest.mjs --provenance file --base-url https://host/releases/version/ --channel rc --issued-at ISO --expires-at ISO [--out file]");
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!out.provenance || !out.baseUrl || !out.channel || !out.issuedAt || !out.expiresAt) fail("--provenance, --base-url, --channel, --issued-at and --expires-at are required");
  if (!CHANNELS.has(out.channel)) fail(`unsupported update channel: ${out.channel}`);
  return out;
}
function regularFile(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) fail(`${label} missing: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink: ${absolute}`);
  if (!stat.isFile()) fail(`${label} must be a regular file: ${absolute}`);
  return absolute;
}

const args = parseArgs(process.argv.slice(2));
const provenanceFile = regularFile(args.provenance, "release provenance");
const provenanceBytes = fs.readFileSync(provenanceFile);
let provenance;
try { provenance = JSON.parse(provenanceBytes.toString("utf8")); } catch { fail("release provenance must be valid JSON"); }
if (provenance?.schemaVersion !== 1 || provenance.kind !== "freeseek-desktop-release-provenance" || !Array.isArray(provenance.artifacts) || !provenance.artifacts.length) fail("invalid release provenance schema");
if (provenance.gitTreeState !== "clean") fail("update publication requires clean release provenance");
if (!/^[a-f0-9]{40}$/i.test(String(provenance.gitCommit ?? ""))) fail("release provenance must bind a full Git commit SHA");
if (!provenance.version || provenance.desktopVersion !== provenance.version) fail("release provenance version metadata is inconsistent");

const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (String(rootPackage.version) !== String(provenance.version)) fail(`release provenance version ${provenance.version} does not match committed package version ${rootPackage.version}`);

const base = requireHttps(args.baseUrl, "release base URL");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const issuedAt = parseInstant(args.issuedAt, "--issued-at");
const expiresAt = parseInstant(args.expiresAt, "--expires-at");
if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail("--expires-at must be later than --issued-at");

const targets = new Set();
const names = new Set();
const artifacts = provenance.artifacts.map((artifact, index) => {
  if (!artifact || !["win32", "darwin", "linux"].includes(artifact.platform) || !["x64", "arm64"].includes(artifact.arch)) fail(`provenance artifacts[${index}] has unsupported platform/arch`);
  const target = `${artifact.platform}/${artifact.arch}`;
  if (targets.has(target)) fail(`duplicate provenance target: ${target}`);
  targets.add(target);
  if (!artifact.name || artifact.name !== path.basename(artifact.name)) fail(`provenance artifacts[${index}].name must be a basename`);
  if (names.has(artifact.name)) fail(`duplicate provenance artifact name: ${artifact.name}`);
  names.add(artifact.name);
  if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 ?? ""))) fail(`provenance artifacts[${index}].sha256 is invalid`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) fail(`provenance artifacts[${index}].size is invalid`);
  return {
    platform: artifact.platform,
    arch: artifact.arch,
    url: new URL(encodeURIComponent(artifact.name), base).toString(),
    sha256: artifact.sha256,
    size: artifact.size,
  };
}).sort((a, b) => `${a.platform}/${a.arch}`.localeCompare(`${b.platform}/${b.arch}`));

const provenanceName = path.basename(provenanceFile);
const manifest = {
  schemaVersion: 2,
  channel: args.channel,
  version: provenance.version,
  issuedAt,
  expiresAt,
  provenance: {
    url: new URL(encodeURIComponent(provenanceName), base).toString(),
    sha256: hashBytes(provenanceBytes),
    size: provenanceBytes.length,
  },
  artifacts,
};
const outFile = path.resolve(args.out ?? path.join(ROOT, "releases", "desktop", `update-${args.channel}.json`));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
console.log(JSON.stringify({ out: outFile, manifest }, null, 2));
