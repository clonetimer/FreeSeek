/** Portable Desktop install primitives for D4 preflight and future platform installer adapters. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const TARGET_RE = /^(linux|win32|darwin)\/(x64|arm64)$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

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

function ensureInside(root, candidate, label) {
  const rel = path.relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))) return;
  throw new Error(`${label} escapes portable stage root`);
}

function validateSymlinkTree(stageRoot) {
  const stack = [stageRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const resolved = path.resolve(path.dirname(full), target);
        ensureInside(stageRoot, resolved, `symlink ${path.relative(stageRoot, full)}`);
      } else if (stat.isDirectory()) stack.push(full);
    }
  }
}

function compareIdentifier(left, right) {
  const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
  if (ln && rn) return Number(left) - Number(right);
  if (ln !== rn) return ln ? -1 : 1;
  return left.localeCompare(right);
}

/** Compare strict Desktop semver values including prerelease identifiers. */
export function comparePortableSemver(left, right) {
  const a = String(left).match(SEMVER_RE), b = String(right).match(SEMVER_RE);
  if (!a || !b) throw new Error(`Portable installer requires strict semver: ${!a ? left : right}`);
  for (let i = 1; i <= 3; i += 1) {
    const delta = Number(a[i]) - Number(b[i]);
    if (delta) return delta;
  }
  if (!a[4] && !b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const ai = a[4].split("."), bi = b[4].split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i += 1) {
    if (ai[i] === undefined) return -1;
    if (bi[i] === undefined) return 1;
    const delta = compareIdentifier(ai[i], bi[i]);
    if (delta) return delta;
  }
  return 0;
}

/** Validate a productized portable stage and its critical-file manifest. */
export function validatePortableStage(stageRoot, expectedTarget) {
  const root = path.resolve(stageRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Portable stage must be a real directory: ${root}`);
  validateSymlinkTree(root);
  const manifestFile = path.join(root, "freesek-release-manifest.json");
  const manifestStat = fs.lstatSync(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Portable stage manifest must be a regular file");
  const bytes = fs.readFileSync(manifestFile);
  const manifestSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Portable stage manifest is not valid JSON"); }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== "freeseek-desktop-portable-stage") throw new Error("Invalid portable stage manifest schema");
  if (!SEMVER_RE.test(String(manifest.version ?? ""))) throw new Error("Portable stage version must be strict semver");
  const target = `${manifest.platform}/${manifest.arch}`;
  if (!TARGET_RE.test(target)) throw new Error(`Invalid portable stage target: ${target}`);
  if (expectedTarget && target !== expectedTarget) throw new Error(`Portable stage target ${target} does not match expected ${expectedTarget}`);
  if (manifest.versionMatched !== true || !manifest.electronVersion || manifest.electronVersion !== manifest.expectedElectronVersion) {
    throw new Error("Portable installer preflight requires an exact Electron stage");
  }
  const embeddedRel = String(manifest.embeddedManifestPath ?? "");
  if (!embeddedRel || path.isAbsolute(embeddedRel) || embeddedRel.split(/[\\/]+/).includes("..") || embeddedRel === "freesek-release-manifest.json") {
    throw new Error("Portable stage embedded manifest path is invalid");
  }
  const embeddedManifestFile = path.resolve(root, embeddedRel);
  ensureInside(root, embeddedManifestFile, "embedded stage manifest");
  const embeddedStat = fs.lstatSync(embeddedManifestFile);
  if (!embeddedStat.isFile() || embeddedStat.isSymbolicLink()) throw new Error("Portable embedded stage manifest must be a regular file");
  const embeddedBytes = fs.readFileSync(embeddedManifestFile);
  if (!embeddedBytes.equals(bytes)) throw new Error("Portable embedded stage manifest does not match stage-root manifest bytes");
  const embeddedManifestSha256 = crypto.createHash("sha256").update(embeddedBytes).digest("hex");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Portable stage manifest has no critical files");
  const seen = new Set();
  for (const row of manifest.files) {
    const rel = String(row?.path ?? "");
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..") || seen.has(rel)) throw new Error(`Invalid portable critical file path: ${rel || "<missing>"}`);
    seen.add(rel);
    const file = path.resolve(root, rel);
    ensureInside(root, file, `critical file ${rel}`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Portable critical file must be regular: ${rel}`);
    if (!/^[a-f0-9]{64}$/i.test(String(row.sha256 ?? "")) || !Number.isSafeInteger(row.size) || row.size < 0) throw new Error(`Invalid portable critical file evidence: ${rel}`);
    const digest = hashFile(file);
    if (digest.size !== row.size || digest.sha256.toLowerCase() !== String(row.sha256).toLowerCase()) throw new Error(`Portable critical file digest mismatch: ${rel}`);
  }
  return { root, manifest, manifestSha256, embeddedManifestSha256, target };
}

function stateFile(installRoot) { return path.join(path.resolve(installRoot), "freesek-portable-install-state.json"); }
function currentRoot(installRoot) { return path.join(path.resolve(installRoot), "current"); }
function previousRoot(installRoot) { return path.join(path.resolve(installRoot), "previous"); }

function writeState(installRoot, state) {
  const root = path.resolve(installRoot);
  fs.mkdirSync(root, { recursive: true });
  const temp = path.join(root, `.install-state-${process.pid}-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, stateFile(root));
}

/** Read and validate the portable install pointer state. */
export function readPortableInstallState(installRoot) {
  const file = stateFile(installRoot);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Portable install state must be a regular file");
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("Portable install state is not valid JSON"); }
  if (state?.schemaVersion !== 1 || state.kind !== "freeseek-desktop-portable-install-state" || !TARGET_RE.test(String(state.target ?? ""))) throw new Error("Invalid portable install state schema");
  for (const key of ["current", ...(state.previous ? ["previous"] : [])]) {
    const row = state[key];
    if (!SEMVER_RE.test(String(row?.version ?? "")) || !/^[a-f0-9]{64}$/i.test(String(row?.stageManifestSha256 ?? ""))) throw new Error(`Invalid portable install state ${key}`);
  }
  return state;
}

function copyVerifiedStage(source, destination, expectedTarget) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source.root, destination, { recursive: true, force: false, preserveTimestamps: true, dereference: false });
  const copied = validatePortableStage(destination, expectedTarget);
  if (copied.manifestSha256 !== source.manifestSha256) throw new Error("Portable stage changed while being installed");
  return copied;
}

/** Fresh-install or upgrade a validated portable stage using same-filesystem atomic directory swaps. */
export function installPortableStage(stageRoot, installRoot) {
  const source = validatePortableStage(stageRoot);
  const root = path.resolve(installRoot);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("Portable install root must not be a symlink");
  fs.mkdirSync(root, { recursive: true });
  const previousState = readPortableInstallState(root);
  if (previousState) {
    if (previousState.target !== source.target) throw new Error(`Portable install target changed from ${previousState.target} to ${source.target}`);
    if (comparePortableSemver(source.manifest.version, previousState.current.version) <= 0) throw new Error(`Refusing non-upgrade portable install: ${previousState.current.version} -> ${source.manifest.version}`);
    const current = validatePortableStage(currentRoot(root), source.target);
    if (current.manifest.version !== previousState.current.version || current.manifestSha256 !== previousState.current.stageManifestSha256) throw new Error("Portable current installation does not match install state");
  } else if (fs.existsSync(currentRoot(root))) {
    throw new Error("Portable current installation exists without install state");
  }

  const incoming = path.join(root, `.incoming-${process.pid}-${crypto.randomUUID()}`);
  const candidate = copyVerifiedStage(source, incoming, source.target);
  const previous = previousRoot(root), current = currentRoot(root);
  let movedCurrent = false;
  try {
    if (previousState) {
      fs.rmSync(previous, { recursive: true, force: true });
      fs.renameSync(current, previous);
      movedCurrent = true;
    }
    fs.renameSync(incoming, current);
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true });
    if (movedCurrent && !fs.existsSync(current) && fs.existsSync(previous)) fs.renameSync(previous, current);
    throw error;
  }

  const state = {
    schemaVersion: 1,
    kind: "freeseek-desktop-portable-install-state",
    target: source.target,
    current: { version: candidate.manifest.version, stageManifestSha256: candidate.manifestSha256 },
    ...(previousState ? { previous: { ...previousState.current } } : {}),
    updatedAt: new Date().toISOString(),
  };
  try { writeState(root, state); }
  catch (error) {
    if (previousState && fs.existsSync(previous)) {
      const failed = path.join(root, `.failed-${process.pid}-${crypto.randomUUID()}`);
      if (fs.existsSync(current)) fs.renameSync(current, failed);
      fs.renameSync(previous, current);
      fs.rmSync(failed, { recursive: true, force: true });
      writeState(root, previousState);
    } else {
      fs.rmSync(current, { recursive: true, force: true });
      try { fs.unlinkSync(stateFile(root)); } catch {}
    }
    throw error;
  }
  return state;
}

/** Roll back one successful portable upgrade and remove the failed candidate slot. */
export function rollbackPortableStage(installRoot) {
  const root = path.resolve(installRoot);
  const state = readPortableInstallState(root);
  if (!state?.previous) throw new Error("Portable rollback requires a previous installed version");
  const current = validatePortableStage(currentRoot(root), state.target);
  const previous = validatePortableStage(previousRoot(root), state.target);
  if (current.manifest.version !== state.current.version || current.manifestSha256 !== state.current.stageManifestSha256) throw new Error("Portable current slot does not match install state");
  if (previous.manifest.version !== state.previous.version || previous.manifestSha256 !== state.previous.stageManifestSha256) throw new Error("Portable previous slot does not match install state");
  const failed = path.join(root, `.failed-${process.pid}-${crypto.randomUUID()}`);
  fs.renameSync(currentRoot(root), failed);
  try { fs.renameSync(previousRoot(root), currentRoot(root)); }
  catch (error) { fs.renameSync(failed, currentRoot(root)); throw error; }
  fs.rmSync(failed, { recursive: true, force: true });
  const rolledBack = {
    schemaVersion: 1,
    kind: "freeseek-desktop-portable-install-state",
    target: state.target,
    current: { ...state.previous },
    updatedAt: new Date().toISOString(),
  };
  writeState(root, rolledBack);
  return rolledBack;
}

/** Uninstall a verified portable Desktop payload without following untracked paths. */
export function uninstallPortableDesktop(installRoot) {
  const root = path.resolve(installRoot);
  if (!fs.existsSync(root)) throw new Error("Portable uninstall requires an installed root");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Portable install root must be a real directory");
  const state = readPortableInstallState(root);
  if (!state) throw new Error("Portable uninstall requires install state");
  const current = validatePortableStage(currentRoot(root), state.target);
  if (current.manifest.version !== state.current.version || current.manifestSha256 !== state.current.stageManifestSha256) throw new Error("Portable current slot does not match install state");
  if (state.previous) {
    const previous = validatePortableStage(previousRoot(root), state.target);
    if (previous.manifest.version !== state.previous.version || previous.manifestSha256 !== state.previous.stageManifestSha256) throw new Error("Portable previous slot does not match install state");
  } else if (fs.existsSync(previousRoot(root))) throw new Error("Portable previous slot exists without install state");

  const token = `${process.pid}-${crypto.randomUUID()}`;
  const removedCurrent = path.join(root, `.uninstall-current-${token}`);
  const removedPrevious = path.join(root, `.uninstall-previous-${token}`);
  const removedState = path.join(root, `.uninstall-state-${token}.json`);
  let currentMoved = false, previousMoved = false, stateMoved = false;
  try {
    fs.renameSync(currentRoot(root), removedCurrent); currentMoved = true;
    if (state.previous) { fs.renameSync(previousRoot(root), removedPrevious); previousMoved = true; }
    fs.renameSync(stateFile(root), removedState); stateMoved = true;
  } catch (error) {
    if (stateMoved && !fs.existsSync(stateFile(root))) fs.renameSync(removedState, stateFile(root));
    if (previousMoved && !fs.existsSync(previousRoot(root))) fs.renameSync(removedPrevious, previousRoot(root));
    if (currentMoved && !fs.existsSync(currentRoot(root))) fs.renameSync(removedCurrent, currentRoot(root));
    throw error;
  }
  fs.rmSync(removedCurrent, { recursive: true, force: true });
  if (previousMoved) fs.rmSync(removedPrevious, { recursive: true, force: true });
  fs.rmSync(removedState, { force: true });
  return { target: state.target, removedVersion: state.current.version, previousVersion: state.previous?.version ?? null };
}
