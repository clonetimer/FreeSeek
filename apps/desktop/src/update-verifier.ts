import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DesktopUpdateArtifact {
  platform: "win32" | "darwin" | "linux";
  arch: "x64" | "arm64";
  url: string;
  sha256: string;
  size: number;
}

export interface DesktopUpdateProvenanceRef {
  url: string;
  sha256: string;
  size: number;
}

export interface DesktopUpdateManifest {
  schemaVersion: 2;
  channel: "stable" | "rc" | "beta";
  version: string;
  issuedAt: string;
  expiresAt: string;
  provenance: DesktopUpdateProvenanceRef;
  artifacts: DesktopUpdateArtifact[];
}

export interface DesktopReleaseProvenanceArtifact {
  platform: DesktopUpdateArtifact["platform"];
  arch: DesktopUpdateArtifact["arch"];
  name: string;
  electronVersion: string;
  stageManifestSha256: string;
  sha256: string;
  size: number;
}

export interface DesktopReleaseProvenance {
  schemaVersion: 1;
  kind: "freeseek-desktop-release-provenance";
  version: string;
  desktopVersion: string;
  electronVersionPin: string;
  gitCommit: string;
  gitTreeState: "clean" | "dirty";
  generatedAt: string;
  artifacts: DesktopReleaseProvenanceArtifact[];
}

export interface DesktopUpdateHighWaterMark {
  version: string;
  issuedAt: string;
  manifestSha256: string;
}

function semverParts(version: string): { core: number[]; pre: Array<string | number> } {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part) : [],
  };
}

/** Compare strict SemVer precedence without adding a release-time dependency. */
export function compareDesktopSemver(a: string, b: string): number {
  const left = semverParts(a); const right = semverParts(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "string") return -1;
    if (typeof x === "string" && typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function requireHttps(value: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be an absolute URL`); }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not embed credentials`);
}

/** Verify detached Ed25519 signature and anti-rollback/replay policy for an exact manifest byte sequence. */
export function verifyDesktopUpdateManifest(input: {
  manifestBytes: Buffer;
  signature: Buffer;
  publicKey: string | Buffer;
  manifestUrl: string;
  currentVersion: string;
  highWater?: DesktopUpdateHighWaterMark | null;
  expectedChannel?: DesktopUpdateManifest["channel"];
  now?: Date;
}): { manifest: DesktopUpdateManifest; highWater: DesktopUpdateHighWaterMark; idempotent: boolean } {
  requireHttps(input.manifestUrl, "update manifest URL");
  if (!crypto.verify(null, input.manifestBytes, input.publicKey, input.signature)) throw new Error("Update manifest Ed25519 signature verification failed");
  const manifestSha256 = crypto.createHash("sha256").update(input.manifestBytes).digest("hex");
  const manifest = JSON.parse(input.manifestBytes.toString("utf8")) as DesktopUpdateManifest;
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || !manifest.provenance) throw new Error("Invalid update manifest schema");
  if (!/^(stable|rc|beta)$/.test(String(manifest.channel))) throw new Error("Invalid update channel");
  if (input.expectedChannel && manifest.channel !== input.expectedChannel) {
    throw new Error(`Update channel mismatch: expected ${input.expectedChannel}, got ${manifest.channel}`);
  }
  if (compareDesktopSemver(manifest.version, input.currentVersion) <= 0) throw new Error(`Update version ${manifest.version} is not newer than ${input.currentVersion}`);
  requireHttps(manifest.provenance.url, "release provenance URL");
  if (!/^[a-f0-9]{64}$/i.test(manifest.provenance.sha256)) throw new Error("release provenance sha256 must be a SHA-256 hex digest");
  if (!Number.isSafeInteger(manifest.provenance.size) || manifest.provenance.size <= 0) throw new Error("release provenance size must be a positive integer");
  const issuedAt = Date.parse(manifest.issuedAt); const expiresAt = Date.parse(manifest.expiresAt); const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error("Invalid update manifest time window");
  if (issuedAt > now + 5 * 60_000) throw new Error("Update manifest issuedAt is unreasonably in the future");
  if (expiresAt <= now) throw new Error("Update manifest has expired");
  const artifactTargets = new Set<string>();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    requireHttps(artifact.url, `artifacts[${index}].url`);
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error(`artifacts[${index}].sha256 must be a SHA-256 hex digest`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) throw new Error(`artifacts[${index}].size must be a positive integer`);
    if (!["win32", "darwin", "linux"].includes(artifact.platform) || !["x64", "arm64"].includes(artifact.arch)) throw new Error(`artifacts[${index}] has unsupported platform/arch`);
    const target = `${artifact.platform}/${artifact.arch}`;
    if (artifactTargets.has(target)) throw new Error(`Duplicate update artifact target: ${target}`);
    artifactTargets.add(target);
  }
  let idempotent = false;
  if (input.highWater) {
    const versionOrder = compareDesktopSemver(manifest.version, input.highWater.version);
    if (versionOrder < 0) throw new Error(`Update rollback rejected: ${manifest.version} < accepted ${input.highWater.version}`);
    if (versionOrder === 0) {
      if (input.highWater.manifestSha256 !== manifestSha256) throw new Error("Update replay/equivocation rejected: same version has different signed manifest bytes");
      idempotent = true;
    } else if (issuedAt < Date.parse(input.highWater.issuedAt)) {
      throw new Error("Update replay rejected: newer version has an older issuedAt than the accepted high-water mark");
    }
  }
  return { manifest, highWater: { version: manifest.version, issuedAt: manifest.issuedAt, manifestSha256 }, idempotent };
}


/** Verify release-provenance bytes and require an exact target/digest match with the signed update manifest. */
export function verifyDesktopUpdateProvenance(
  provenanceBytes: Buffer,
  manifest: DesktopUpdateManifest,
): DesktopReleaseProvenance {
  if (provenanceBytes.length !== manifest.provenance.size) {
    throw new Error(`Release provenance size mismatch: expected ${manifest.provenance.size}, got ${provenanceBytes.length}`);
  }
  const provenanceSha256 = crypto.createHash("sha256").update(provenanceBytes).digest("hex");
  if (provenanceSha256.toLowerCase() !== manifest.provenance.sha256.toLowerCase()) {
    throw new Error("Release provenance SHA-256 mismatch");
  }
  let provenance: DesktopReleaseProvenance;
  try { provenance = JSON.parse(provenanceBytes.toString("utf8")) as DesktopReleaseProvenance; }
  catch { throw new Error("Invalid release provenance JSON"); }
  if (provenance?.schemaVersion !== 1 || provenance.kind !== "freeseek-desktop-release-provenance" || !Array.isArray(provenance.artifacts) || !provenance.artifacts.length) {
    throw new Error("Invalid release provenance schema");
  }
  if (provenance.version !== manifest.version || provenance.desktopVersion !== manifest.version) {
    throw new Error(`Release provenance version mismatch for update ${manifest.version}`);
  }
  if (provenance.gitTreeState !== "clean") throw new Error("Release provenance must come from a clean committed worktree");
  if (!/^[a-f0-9]{40}$/i.test(provenance.gitCommit)) throw new Error("Release provenance gitCommit must be a full Git commit SHA");
  if (!Number.isFinite(Date.parse(provenance.generatedAt))) throw new Error("Release provenance generatedAt must be an ISO timestamp");
  semverParts(provenance.electronVersionPin);

  const provenanceTargets = new Map<string, DesktopReleaseProvenanceArtifact>();
  for (const [index, artifact] of provenance.artifacts.entries()) {
    if (!artifact || !["win32", "darwin", "linux"].includes(artifact.platform) || !["x64", "arm64"].includes(artifact.arch)) {
      throw new Error(`release provenance artifacts[${index}] has unsupported platform/arch`);
    }
    const target = `${artifact.platform}/${artifact.arch}`;
    if (provenanceTargets.has(target)) throw new Error(`Duplicate release provenance artifact target: ${target}`);
    if (!artifact.name || artifact.name !== path.basename(artifact.name)) throw new Error(`release provenance artifacts[${index}].name must be a basename`);
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256) || !/^[a-f0-9]{64}$/i.test(artifact.stageManifestSha256)) {
      throw new Error(`release provenance artifacts[${index}] has malformed SHA-256 evidence`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) throw new Error(`release provenance artifacts[${index}].size must be a positive integer`);
    if (artifact.electronVersion !== provenance.electronVersionPin) throw new Error(`release provenance artifacts[${index}] Electron version does not match the release pin`);
    provenanceTargets.set(target, artifact);
  }
  if (provenanceTargets.size !== manifest.artifacts.length) throw new Error("Release provenance target set does not match the signed update manifest");
  for (const artifact of manifest.artifacts) {
    const target = `${artifact.platform}/${artifact.arch}`;
    const evidence = provenanceTargets.get(target);
    if (!evidence) throw new Error(`Release provenance is missing update target ${target}`);
    if (evidence.sha256.toLowerCase() !== artifact.sha256.toLowerCase() || evidence.size !== artifact.size) {
      throw new Error(`Release provenance artifact digest/size mismatch for ${target}`);
    }
  }
  return provenance;
}

/** Select exactly one signed artifact for the current Desktop platform and architecture. */
export function selectDesktopUpdateArtifact(
  manifest: DesktopUpdateManifest,
  platform: DesktopUpdateArtifact["platform"],
  arch: DesktopUpdateArtifact["arch"],
): DesktopUpdateArtifact {
  const matches = manifest.artifacts.filter((artifact) => artifact.platform === platform && artifact.arch === arch);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one update artifact for ${platform}/${arch}, found ${matches.length}`);
  }
  return matches[0];
}

/** Verify downloaded artifact byte count and SHA-256 before any install step. */
export function verifyDesktopUpdateArtifact(file: string, artifact: DesktopUpdateArtifact): void {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Update artifact must be a regular file");
  if (stat.size !== artifact.size) throw new Error(`Update artifact size mismatch: expected ${artifact.size}, got ${stat.size}`);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (bytesRead <= 0) throw new Error("Update artifact ended before the reported size");
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally { fs.closeSync(fd); }
  const digest = hash.digest("hex");
  if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) throw new Error("Update artifact SHA-256 mismatch");
}

/** Verify the complete update candidate before callers persist high-water state or invoke an installer. */
export function verifyDesktopUpdateCandidate(input: {
  manifestBytes: Buffer;
  signature: Buffer;
  publicKey: string | Buffer;
  manifestUrl: string;
  provenanceBytes: Buffer;
  artifactFile: string;
  platform: DesktopUpdateArtifact["platform"];
  arch: DesktopUpdateArtifact["arch"];
  currentVersion: string;
  highWater?: DesktopUpdateHighWaterMark | null;
  expectedChannel?: DesktopUpdateManifest["channel"];
  now?: Date;
}): {
  manifest: DesktopUpdateManifest;
  provenance: DesktopReleaseProvenance;
  artifact: DesktopUpdateArtifact;
  highWater: DesktopUpdateHighWaterMark;
  idempotent: boolean;
} {
  const accepted = verifyDesktopUpdateManifest(input);
  const provenance = verifyDesktopUpdateProvenance(input.provenanceBytes, accepted.manifest);
  const artifact = selectDesktopUpdateArtifact(accepted.manifest, input.platform, input.arch);
  verifyDesktopUpdateArtifact(input.artifactFile, artifact);
  return { ...accepted, provenance, artifact };
}

/** Persist the accepted signed-manifest high-water mark atomically. */
export function writeDesktopUpdateHighWater(file: string, state: DesktopUpdateHighWaterMark): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Read a previously accepted signed-manifest high-water mark. */
export function readDesktopUpdateHighWater(file: string): DesktopUpdateHighWaterMark | null {
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8")) as DesktopUpdateHighWaterMark;
    if (!row?.version || !row.issuedAt || !/^[a-f0-9]{64}$/i.test(row.manifestSha256)) return null;
    return row;
  } catch { return null; }
}
