import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";

const COMMIT_RC = "a".repeat(40), COMMIT_STABLE = "b".repeat(40), POLICY_SHA = "c".repeat(64);
const TARGETS = ["darwin/arm64", "linux/x64", "win32/x64"];
function aggregate(version: string, commit: string, rc: boolean) {
  return {
    schemaVersion: 1, kind: "freesek-desktop-rc-evidence-gate", version, gitCommit: commit, electronPin: "43.3.0",
    releaseTargets: TARGETS, signingPolicyId: "desktop-prod-2026", signingPolicySha256: POLICY_SHA,
    packagedSmokeTargets: TARGETS, installerEvidenceTargets: TARGETS, signingEvidenceTargets: TARGETS,
    independentInterop: { passed: true }, passed: true, rcEligible: rc, preflightOnly: !rc, errors: [],
  };
}
function installers(version = "0.20.0", commit = COMMIT_STABLE, fromVersion = "0.20.0-rc.1") {
  return TARGETS.map((target) => { const [platform, arch] = target.split("/"); return {
    schemaVersion: 1, kind: "freeseek-desktop-installer-rollback-evidence", passed: true, version, gitCommit: commit, fromVersion,
    platform, arch, nativePlatformVerified: true, installedExecutableSha256: "d".repeat(64), installedStageManifestSha256: "e".repeat(64),
    freshInstallSucceeded: true, uninstallScenarioExecuted: true, uninstallSucceeded: true, upgradeSucceeded: true,
    rollbackScenarioExecuted: true, rollbackRestoredPreviousVersion: true,
  }; });
}

const STABLE_PROMOTION_MODULE = path.join(process.cwd(), "scripts/lib/desktop-stable-promotion.mjs");

// 不能用动态 import(绝对路径)：esbuild(CJS) 保留真实 import()，Windows 下 ESM loader 拒绝 'e:' 协议；
// 直接 require 绝对路径（Node>=22.12 支持 require ESM）在 esbuild 与 tsc 两种布局下均可用。
// eslint-disable-next-line @typescript-eslint/no-var-requires
async function validate(input: any) {
  const mod = require(STABLE_PROMOTION_MODULE);
  return mod.validateDesktopStablePromotion(input);
}

test("Desktop Stable gate requires a fully audited RC and fresh Stable lifecycle evidence on the same target/pin/policy set", async () => {
  const result = await validate({ stableSummary: aggregate("0.20.0", COMMIT_STABLE, false), rcSummary: aggregate("0.20.0-rc.1", COMMIT_RC, true), installerReports: installers(), candidateVersion: "0.20.0", candidateCommit: COMMIT_STABLE });
  assert.equal(result.stableEligible, true); assert.deepEqual(result.errors, []); assert.equal(result.rcVersion, "0.20.0-rc.1");
});

test("Desktop Stable gate rejects a Stable candidate that changed Electron pin or signer policy after RC", async () => {
  const stable = aggregate("0.20.0", COMMIT_STABLE, false); stable.electronPin = "43.4.1"; stable.signingPolicySha256 = "f".repeat(64);
  const result = await validate({ stableSummary: stable, rcSummary: aggregate("0.20.0-rc.1", COMMIT_RC, true), installerReports: installers(), candidateVersion: "0.20.0", candidateCommit: COMMIT_STABLE });
  assert.equal(result.stableEligible, false); assert.ok(result.errors.some((x: string) => x.includes("Electron pin changed"))); assert.ok(result.errors.some((x: string) => x.includes("signing policy changed")));
});

test("Desktop Stable gate rejects installer evidence that did not actually upgrade from the audited RC", async () => {
  const rows = installers(); rows[0].fromVersion = "0.20.0-beta.3";
  const result = await validate({ stableSummary: aggregate("0.20.0", COMMIT_STABLE, false), rcSummary: aggregate("0.20.0-rc.1", COMMIT_RC, true), installerReports: rows, candidateVersion: "0.20.0", candidateCommit: COMMIT_STABLE });
  assert.equal(result.stableEligible, false); assert.ok(result.errors.some((x: string) => x.includes("RC-to-Stable lifecycle")));
});

test("Desktop Stable gate rejects missing native target coverage and prerelease candidate versions", async () => {
  const result = await validate({ stableSummary: aggregate("0.20.0-rc.2", COMMIT_STABLE, false), rcSummary: aggregate("0.20.0-rc.1", COMMIT_RC, true), installerReports: installers().slice(0, 2), candidateVersion: "0.20.0-rc.2", candidateCommit: COMMIT_STABLE });
  assert.equal(result.stableEligible, false); assert.ok(result.errors.some((x: string) => x.includes("not a stable semver"))); assert.ok(result.errors.some((x: string) => x.includes("exact audited release target set")));
});
