#!/usr/bin/env node
/** Generate checksum and build-provenance evidence for already-built Desktop release artifacts. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_RE = /^(linux|win32|darwin)\/(x64|arm64)$/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { artifacts: [], stageManifests: [], allowDirty: false, out: path.join(ROOT, "releases", "desktop") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") { out.allowDirty = true; continue; }
    if (arg === "--artifact") { out.artifacts.push(argv[++index] ?? fail("--artifact requires platform/arch=path")); continue; }
    if (arg === "--stage-manifest") { out.stageManifests.push(argv[++index] ?? fail("--stage-manifest requires platform/arch=path")); continue; }
    if (arg === "--out") { out.out = argv[++index] ?? fail("--out requires a directory"); continue; }
    if (arg === "--signing-policy") { out.signingPolicy = argv[++index] ?? fail("--signing-policy requires a file"); continue; }
    if (arg === "--version") { out.version = argv[++index] ?? fail("--version requires a value"); continue; }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/desktop-release-evidence.mjs --artifact linux/x64=file --stage-manifest linux/x64=manifest.json [--artifact ... --stage-manifest ...] --signing-policy policy.json [--out dir] [--version X.Y.Z] [--allow-dirty]");
      process.exit(0);
    }
    fail(`unknown argument: ${arg}`);
  }
  if (!out.artifacts.length) fail("at least one --artifact platform/arch=path is required");
  if (out.stageManifests.length !== out.artifacts.length) fail("each --artifact requires exactly one matching --stage-manifest");
  if (!out.signingPolicy) fail("--signing-policy is required");
  return out;
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed`);
  return String(result.stdout ?? "").trim();
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (bytesRead <= 0) throw new Error(`Unexpected EOF while hashing ${file}`);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), size: stat.size };
}

function parseTargetFile(spec, label) {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) fail(`invalid ${label} value: ${spec}`);
  const target = spec.slice(0, separator);
  const targetMatch = target.match(TARGET_RE);
  if (!targetMatch) fail(`unsupported Desktop target: ${target}`);
  const file = path.resolve(spec.slice(separator + 1));
  if (!fs.existsSync(file)) fail(`${label} file missing: ${file}`);
  const lstat = fs.lstatSync(file);
  if (lstat.isSymbolicLink()) fail(`${label} file must not be a symlink: ${file}`);
  if (!lstat.isFile()) fail(`${label} file must be a regular file: ${file}`);
  return { target, platform: targetMatch[1], arch: targetMatch[2], file };
}

function readSigningPolicy(file) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) fail(`signing-policy file missing: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`signing-policy must be a non-symlink regular file: ${absolute}`);
  const bytes = fs.readFileSync(absolute);
  let policy;
  try { policy = JSON.parse(bytes.toString("utf8")); } catch { fail(`invalid signing-policy JSON: ${absolute}`); }
  if (policy?.schemaVersion !== 1 || policy.kind !== "freesek-desktop-signing-policy" || !policy.policyId || !Array.isArray(policy.targets) || !policy.targets.length) fail("invalid Desktop signing-policy schema");
  const targets = new Map();
  for (const [index, row] of policy.targets.entries()) {
    const target = `${row?.platform ?? ""}/${row?.arch ?? ""}`;
    if (!TARGET_RE.test(target)) fail(`signing-policy targets[${index}] has invalid target ${target}`);
    if (targets.has(target)) fail(`signing-policy has duplicate target ${target}`);
    const expectedKind = row.platform === "win32" ? "authenticode" : row.platform === "darwin" ? "apple-codesign" : "ed25519-update-manifest";
    if (row.signatureKind !== expectedKind) fail(`signing-policy ${target} must use ${expectedKind}`);
    if (row.platform === "linux" && !/^[a-f0-9]{64}$/i.test(String(row.publicKeySha256 ?? ""))) fail(`signing-policy ${target} requires publicKeySha256`);
    if (row.platform === "win32" && !/^[a-f0-9]{64}$/i.test(String(row.certificateSha256 ?? ""))) fail(`signing-policy ${target} requires certificateSha256`);
    if (row.platform === "darwin" && (!/^[A-Z0-9]{10}$/.test(String(row.teamIdentifier ?? "")) || row.notarizationRequired !== true)) fail(`signing-policy ${target} requires a 10-character Team ID and notarizationRequired=true`);
    targets.set(target, row);
  }
  return { bytes, policy, targets, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

const args = parseArgs(process.argv.slice(2));
const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const desktopPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "desktop", "package.json"), "utf8"));
const version = String(rootPackage.version);
const electronVersionPin = String(desktopPackage.devDependencies?.electron || "");
if (String(desktopPackage.version) !== version) fail(`Desktop version ${desktopPackage.version} does not match root version ${version}`);
if (args.version && args.version !== version) fail(`--version ${args.version} does not match committed package version ${version}`);

const gitCommit = runGit(["rev-parse", "HEAD"]);
const gitStatus = runGit(["status", "--porcelain"]);
const gitTreeState = gitStatus ? "dirty" : "clean";
if (gitTreeState !== "clean" && !args.allowDirty) fail("Desktop release evidence requires a clean committed worktree");
if (gitTreeState !== "clean") console.error("[desktop-release-evidence] dirty-worktree override: evidence is non-RC");

const manifests = new Map();
for (const spec of args.stageManifests) {
  const row = parseTargetFile(spec, "stage-manifest");
  if (manifests.has(row.target)) fail(`duplicate Desktop stage-manifest target: ${row.target}`);
  const bytes = fs.readFileSync(row.file);
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail(`invalid Desktop stage manifest JSON: ${row.file}`); }
  if (manifest?.kind !== "freeseek-desktop-portable-stage" || manifest.schemaVersion !== 1) fail(`invalid Desktop stage manifest schema: ${row.file}`);
  if (manifest.version !== version) fail(`stage manifest version ${manifest.version} does not match committed version ${version}`);
  if (manifest.platform !== row.platform || manifest.arch !== row.arch) fail(`stage manifest target mismatch for ${row.target}`);
  if (manifest.expectedElectronVersion !== electronVersionPin) fail(`stage manifest Electron pin ${manifest.expectedElectronVersion} does not match Desktop pin ${electronVersionPin}`);
  if (manifest.electronVersion !== electronVersionPin || manifest.versionMatched !== true) fail(`stage manifest for ${row.target} is not built with exact Electron ${electronVersionPin}`);
  manifests.set(row.target, { manifest, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
}

const signingPolicy = readSigningPolicy(args.signingPolicy);

const seenTargets = new Set();
const seenNames = new Set();
const artifacts = args.artifacts.map((spec) => parseTargetFile(spec, "artifact")).map((artifact) => {
  if (seenTargets.has(artifact.target)) fail(`duplicate Desktop artifact target: ${artifact.target}`);
  seenTargets.add(artifact.target);
  const buildManifest = manifests.get(artifact.target);
  if (!buildManifest) fail(`missing matching stage manifest for ${artifact.target}`);
  const name = path.basename(artifact.file);
  if (seenNames.has(name)) fail(`duplicate Desktop artifact basename: ${name}`);
  seenNames.add(name);
  const digest = hashFile(artifact.file);
  return {
    platform: artifact.platform,
    arch: artifact.arch,
    name,
    electronVersion: buildManifest.manifest.electronVersion,
    stageManifestSha256: buildManifest.sha256,
    ...digest,
  };
}).sort((left, right) => left.name.localeCompare(right.name));
if (seenTargets.size !== manifests.size) fail("stage manifest targets must match artifact targets exactly");
if (seenTargets.size !== signingPolicy.targets.size || [...seenTargets].some((target) => !signingPolicy.targets.has(target))) fail("signing-policy targets must match artifact targets exactly");

const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: true });
const sums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n") + "\n";
fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), sums, "utf8");
const provenance = {
  schemaVersion: 1,
  kind: "freeseek-desktop-release-provenance",
  version,
  desktopVersion: String(desktopPackage.version),
  electronVersionPin,
  gitCommit,
  gitTreeState,
  generatedAt: new Date().toISOString(),
  evidenceHost: { platform: process.platform, arch: process.arch, node: process.version },
  signingPolicy: { policyId: String(signingPolicy.policy.policyId), sha256: signingPolicy.sha256, size: signingPolicy.bytes.length },
  artifacts,
};
fs.writeFileSync(path.join(out, "freesek-desktop-provenance.json"), JSON.stringify(provenance, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ out, provenance }, null, 2));
