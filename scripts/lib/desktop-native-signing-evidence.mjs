/** Shared validation for native Windows/macOS Desktop signing evidence collectors. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { validatePortableStage } from "./desktop-portable-install.mjs";

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

/** Hash a regular file without reading the entire artifact into memory. */
export function hashNativeEvidenceFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Native signing evidence requires a regular file: ${file}`);
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (bytesRead <= 0) throw new Error(`Unexpected EOF while hashing ${file}`);
      hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), size: stat.size };
}

function readRegularJson(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`${label} missing: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink regular file`);
  const bytes = fs.readFileSync(absolute);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} must be valid JSON`); }
  return { absolute, bytes, value };
}

function gitCommit(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to resolve current Git commit for native signing evidence");
  return String(result.stdout ?? "").trim();
}

/** Validate provenance/policy/artifact/stage bindings before invoking an OS-native signature verifier. */
export function loadNativeSigningEvidenceContext(input) {
  const root = path.resolve(input.root);
  const provenanceFile = readRegularJson(input.provenance, "release provenance");
  const policyFile = readRegularJson(input.signingPolicy, "Desktop signing policy");
  const artifact = path.resolve(input.artifact);
  if (!fs.existsSync(artifact)) throw new Error(`release artifact missing: ${artifact}`);
  const actualArtifact = hashNativeEvidenceFile(artifact);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = String(pkg.version), commit = gitCommit(root);
  const provenance = provenanceFile.value, policy = policyFile.value;
  if (provenance?.schemaVersion !== 1 || provenance.kind !== "freeseek-desktop-release-provenance" || provenance.gitTreeState !== "clean") throw new Error("Native signing evidence requires clean release provenance");
  if (provenance.version !== version || provenance.desktopVersion !== version || provenance.gitCommit !== commit) throw new Error("Release provenance does not bind the current candidate version/commit");
  if (policy?.schemaVersion !== 1 || policy.kind !== "freesek-desktop-signing-policy" || !Array.isArray(policy.targets)) throw new Error("Invalid Desktop signing policy");
  if (!provenance.signingPolicy || provenance.signingPolicy.policyId !== policy.policyId || provenance.signingPolicy.size !== policyFile.bytes.length || String(provenance.signingPolicy.sha256).toLowerCase() !== sha256(policyFile.bytes)) throw new Error("Release provenance does not bind the supplied Desktop signing policy");

  const target = `${input.platform}/${input.arch}`;
  const artifactRows = Array.isArray(provenance.artifacts) ? provenance.artifacts.filter((row) => `${row?.platform}/${row?.arch}` === target) : [];
  if (artifactRows.length !== 1) throw new Error(`Expected exactly one ${target} artifact in release provenance`);
  const releaseArtifact = artifactRows[0];
  if (releaseArtifact.name !== path.basename(artifact)) throw new Error(`Artifact basename does not match release provenance for ${target}`);
  if (actualArtifact.sha256.toLowerCase() !== String(releaseArtifact.sha256).toLowerCase() || actualArtifact.size !== releaseArtifact.size) throw new Error(`Artifact does not match release provenance for ${target}`);

  const stage = validatePortableStage(path.resolve(input.stage), target);
  if (stage.manifest.version !== version || stage.manifestSha256 !== releaseArtifact.stageManifestSha256) throw new Error(`Portable stage does not match release provenance for ${target}`);
  const policyRows = policy.targets.filter((row) => `${row?.platform}/${row?.arch}` === target);
  if (policyRows.length !== 1 || policyRows[0].signatureKind !== input.signatureKind) throw new Error(`Desktop signing policy does not authorize ${input.signatureKind} for ${target}`);
  const executable = path.resolve(stage.root, String(stage.manifest.electronExecutable ?? ""));
  const relativeExecutable = path.relative(stage.root, executable);
  if (!relativeExecutable || relativeExecutable.startsWith(`..${path.sep}`) || path.isAbsolute(relativeExecutable)) throw new Error("Portable stage executable path escapes stage root");
  const executableDigest = hashNativeEvidenceFile(executable);
  return {
    version, gitCommit: commit, target, stage, executable, executableDigest,
    artifact: actualArtifact, releaseArtifact, policy: policyRows[0],
    provenanceSha256: sha256(provenanceFile.bytes), signingPolicySha256: sha256(policyFile.bytes),
  };
}
