/** Pure Stable metadata-promotion rules; this module does not touch Git or the filesystem. */
const RC_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/;
const STABLE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Validate the only supported Desktop Stable metadata transition: rc.N -> same-base Stable. */
export function validateStableVersionTransition(currentVersion, targetVersion) {
  const current = RC_RE.exec(String(currentVersion ?? "")), target = STABLE_RE.exec(String(targetVersion ?? "")), errors = [];
  if (!current) errors.push("current version must be rc.N semver");
  if (!target) errors.push("target version must be stable semver");
  if (current && target && `${current[1]}.${current[2]}.${current[3]}` !== `${target[1]}.${target[2]}.${target[3]}`) errors.push("Stable promotion cannot change the base semver");
  return { valid: errors.length === 0, errors, currentVersion: String(currentVersion ?? ""), targetVersion: String(targetVersion ?? "") };
}

/** Build synchronized metadata documents for a Stable candidate while preserving the released baseline until publication. */
export function planStableMetadataPromotion({ rootPackage, rootLock, desktopPackage, projectState, targetVersion }) {
  const currentVersions = [rootPackage?.version, rootLock?.version, rootLock?.packages?.[""]?.version, desktopPackage?.version, projectState?.activeDevelopment?.version].map((value) => String(value ?? ""));
  const errors = [];
  if (new Set(currentVersions).size !== 1 || !currentVersions[0]) errors.push("current package/lock/Desktop/project-state versions are not synchronized");
  if (projectState?.activeDevelopment?.status !== "active") errors.push("project-state activeDevelopment must remain active during Stable candidate preparation");
  const transition = validateStableVersionTransition(currentVersions[0], targetVersion); errors.push(...transition.errors);
  if (errors.length) return { valid: false, errors, currentVersion: currentVersions[0] || null, targetVersion: String(targetVersion ?? ""), documents: null };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const pkg = clone(rootPackage), lock = clone(rootLock), desktop = clone(desktopPackage), state = clone(projectState);
  pkg.version = targetVersion; lock.version = targetVersion;
  if (!lock.packages || !lock.packages[""]) throw new Error("package-lock root package metadata is missing");
  lock.packages[""].version = targetVersion; desktop.version = targetVersion; state.activeDevelopment.version = targetVersion;
  return { valid: true, errors: [], currentVersion: currentVersions[0], targetVersion, documents: { rootPackage: pkg, rootLock: lock, desktopPackage: desktop, projectState: state } };
}
