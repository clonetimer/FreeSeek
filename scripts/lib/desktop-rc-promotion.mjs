/** Pure RC metadata-promotion rules; this module does not touch Git or the filesystem. */
const PRE_RC_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(dev|alpha|beta)\.([1-9]\d*)$/;
const RC_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/;

function parse(version) {
  const text = String(version ?? "");
  let m = PRE_RC_RE.exec(text);
  if (m) return { version: text, base: `${m[1]}.${m[2]}.${m[3]}`, kind: m[4], serial: Number(m[5]) };
  m = RC_RE.exec(text);
  if (m) return { version: text, base: `${m[1]}.${m[2]}.${m[3]}`, kind: "rc", serial: Number(m[4]) };
  return null;
}

/** Validate a direct FreeSeek pre-RC/RC metadata transition. */
export function validateRcVersionTransition(currentVersion, targetVersion) {
  const current = parse(currentVersion), target = parse(targetVersion);
  const errors = [];
  if (!current) errors.push("current version must be dev.N, alpha.N, beta.N or rc.N semver");
  if (!target || target.kind !== "rc") errors.push("target version must be rc.N semver");
  if (current && target && current.base !== target.base) errors.push("RC promotion cannot change the base semver");
  if (current && target && current.kind !== "rc" && target.serial !== 1) errors.push("first RC after a pre-RC build must be rc.1");
  if (current && target && current.kind === "rc" && target.serial !== current.serial + 1) errors.push("published RC promotion must advance exactly one RC serial");
  return { errors, valid: errors.length === 0, current, target };
}

/** Build synchronized metadata documents for an RC candidate without committing/tagging anything. */
export function planRcMetadataPromotion({ rootPackage, rootLock, desktopPackage, projectState, targetVersion }) {
  const currentVersions = [
    rootPackage?.version,
    rootLock?.version,
    rootLock?.packages?.[""]?.version,
    desktopPackage?.version,
    projectState?.activeDevelopment?.version,
  ].map((value) => String(value ?? ""));
  const errors = [];
  if (new Set(currentVersions).size !== 1 || !currentVersions[0]) errors.push("current package/lock/Desktop/project-state versions are not synchronized");
  if (projectState?.activeDevelopment?.status !== "active") errors.push("project-state activeDevelopment must remain active during RC candidate preparation");
  const transition = validateRcVersionTransition(currentVersions[0], targetVersion);
  errors.push(...transition.errors);
  if (errors.length) return { errors, valid: false, currentVersion: currentVersions[0] || null, targetVersion: String(targetVersion ?? ""), documents: null };

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const pkg = clone(rootPackage), lock = clone(rootLock), desktop = clone(desktopPackage), state = clone(projectState);
  pkg.version = targetVersion;
  lock.version = targetVersion;
  if (!lock.packages || !lock.packages[""]) throw new Error("package-lock root package metadata is missing");
  lock.packages[""].version = targetVersion;
  desktop.version = targetVersion;
  state.activeDevelopment.version = targetVersion;
  return {
    errors: [], valid: true, currentVersion: currentVersions[0], targetVersion,
    documents: { rootPackage: pkg, rootLock: lock, desktopPackage: desktop, projectState: state },
  };
}
