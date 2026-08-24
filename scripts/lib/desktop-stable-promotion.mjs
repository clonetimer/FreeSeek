/** Pure validation rules for promoting an audited Desktop RC to Stable. */
const SHA256_RE = /^[a-f0-9]{64}$/i;
const COMMIT_RE = /^[a-f0-9]{40}$/i;
const STABLE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function sortedUnique(values) { return [...new Set(values.map(String))].sort(); }
function sameStrings(left, right) {
  const a = sortedUnique(Array.isArray(left) ? left : []), b = sortedUnique(Array.isArray(right) ? right : []);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Validate Stable promotion evidence already produced by the RC aggregate gate plus RC->Stable installer runs. */
export function validateDesktopStablePromotion({ stableSummary, rcSummary, installerReports, candidateVersion, candidateCommit }) {
  const errors = [];
  if (!STABLE_RE.test(String(candidateVersion ?? ""))) errors.push("candidate package version is not a stable semver");
  if (!COMMIT_RE.test(String(candidateCommit ?? ""))) errors.push("candidate Git commit is invalid");
  const stable = stableSummary ?? {}, rc = rcSummary ?? {};
  if (stable.schemaVersion !== 1 || stable.kind !== "freesek-desktop-rc-evidence-gate" || stable.passed !== true
    || stable.preflightOnly !== true || stable.rcEligible !== false || stable.version !== candidateVersion || stable.gitCommit !== candidateCommit
    || !Array.isArray(stable.errors) || stable.errors.length !== 0) errors.push("stable candidate aggregate preflight is incomplete");
  if (rc.schemaVersion !== 1 || rc.kind !== "freesek-desktop-rc-evidence-gate" || rc.passed !== true || rc.rcEligible !== true || rc.preflightOnly !== false
    || !COMMIT_RE.test(String(rc.gitCommit ?? "")) || rc.gitCommit === candidateCommit || typeof rc.version !== "string"
    || !new RegExp(`^${String(candidateVersion).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-rc\\.[1-9]\\d*$`).test(rc.version)) {
    errors.push("released RC summary is not an eligible direct predecessor of Stable");
  }
  if (stable.electronPin !== rc.electronPin) errors.push("Electron pin changed between RC and Stable; a new RC is required");
  if (stable.signingPolicyId !== rc.signingPolicyId || stable.signingPolicySha256 !== rc.signingPolicySha256 || !SHA256_RE.test(String(stable.signingPolicySha256 ?? ""))) {
    errors.push("Desktop signing policy changed between RC and Stable; a new RC is required");
  }
  if (!sameStrings(stable.releaseTargets, rc.releaseTargets) || !sameStrings(stable.releaseTargets, stable.packagedSmokeTargets)
    || !sameStrings(stable.releaseTargets, stable.installerEvidenceTargets) || !sameStrings(stable.releaseTargets, stable.signingEvidenceTargets)) {
    errors.push("Stable release target/evidence sets differ from the audited RC target set");
  }
  if (stable.independentInterop?.passed !== true) errors.push("Stable candidate independent ACP interoperability evidence is missing");

  const expectedTargets = sortedUnique(Array.isArray(stable.releaseTargets) ? stable.releaseTargets : []);
  const rows = Array.isArray(installerReports) ? installerReports : [];
  const seen = new Map();
  for (const row of rows) {
    const target = `${row?.platform ?? ""}/${row?.arch ?? ""}`;
    if (seen.has(target)) { errors.push(`duplicate Stable installer report for ${target}`); continue; }
    seen.set(target, row);
    if (row?.schemaVersion !== 1 || row.kind !== "freeseek-desktop-installer-rollback-evidence" || row.passed !== true
      || row.version !== candidateVersion || row.gitCommit !== candidateCommit || row.fromVersion !== rc.version || row.nativePlatformVerified !== true
      || row.freshInstallSucceeded !== true || row.uninstallScenarioExecuted !== true || row.uninstallSucceeded !== true
      || row.upgradeSucceeded !== true || row.rollbackScenarioExecuted !== true || row.rollbackRestoredPreviousVersion !== true
      || !SHA256_RE.test(String(row.installedExecutableSha256 ?? "")) || !SHA256_RE.test(String(row.installedStageManifestSha256 ?? ""))) {
      errors.push(`Stable installer report does not prove RC-to-Stable lifecycle for ${target}`);
    }
  }
  if (!sameStrings(expectedTargets, [...seen.keys()])) errors.push("Stable installer reports do not cover the exact audited release target set");
  return { errors, stableEligible: errors.length === 0, rcVersion: rc.version ?? null, stableVersion: candidateVersion ?? null };
}
