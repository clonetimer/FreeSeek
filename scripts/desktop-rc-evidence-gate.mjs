#!/usr/bin/env node
/** Aggregate Desktop RC evidence without manufacturing platform/signing/installer results. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_RE = /^(linux|win32|darwin)\/(x64|arm64)$/;

function parseArgs(argv) {
  const out = { devSmoke: [], nativePreflight: [], packagedSmoke: [], recovery: [], interop: [], installer: [], signing: [], nativeBundles: [], allowNonRc: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-non-rc") out.allowNonRc = true;
    else if (arg === "--provenance") out.provenance = argv[++i];
    else if (arg === "--signing-policy") out.signingPolicy = argv[++i];
    else if (arg === "--dev-smoke") out.devSmoke.push(argv[++i]);
    else if (arg === "--native-preflight-report") out.nativePreflight.push(argv[++i]);
    else if (arg === "--packaged-smoke") out.packagedSmoke.push(argv[++i]);
    else if (arg === "--recovery-report") out.recovery.push(argv[++i]);
    else if (arg === "--interop-report") out.interop.push(argv[++i]);
    else if (arg === "--installer-report") out.installer.push(argv[++i]);
    else if (arg === "--signing-report") out.signing.push(argv[++i]);
    else if (arg === "--native-target-bundle") out.nativeBundles.push(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/desktop-rc-evidence-gate.mjs --provenance file --signing-policy file [--native-target-bundle dir...] [--dev-smoke file --native-preflight-report file... --packaged-smoke file... --recovery-report file... --installer-report file... --signing-report file...] --interop-report file... [--allow-non-rc]");
      process.exit(0);
    } else { console.error(`Unknown option: ${arg}`); process.exit(2); }
  }
  if (!out.provenance) { console.error("--provenance is required"); process.exit(2); }
  if (!out.signingPolicy) { console.error("--signing-policy is required"); process.exit(2); }
  return out;
}
function readJson(file, label, errors) {
  if (!file) { errors.push(`${label}: missing file argument`); return null; }
  try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }
  catch (error) { errors.push(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`); return null; }
}
function digestFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(path.resolve(file))).digest("hex"); }
function targetOf(row) { return row?.platform && row?.arch ? `${row.platform}/${row.arch}` : ""; }

function readSigningPolicy(file, errors) {
  const policy = readJson(file, "Desktop signing policy", errors);
  let sha256 = ""; let size = 0; const targets = new Map();
  try { const bytes = fs.readFileSync(path.resolve(file)); sha256 = crypto.createHash("sha256").update(bytes).digest("hex"); size = bytes.length; }
  catch (error) { errors.push(`Desktop signing policy: unreadable bytes (${error instanceof Error ? error.message : String(error)})`); return { policy, sha256, size, targets }; }
  if (!policy || policy.schemaVersion !== 1 || policy.kind !== "freesek-desktop-signing-policy" || !policy.policyId || !Array.isArray(policy.targets) || !policy.targets.length) {
    errors.push("Desktop signing policy schema/kind is invalid"); return { policy, sha256, size, targets };
  }
  for (const [index, row] of policy.targets.entries()) {
    const target = targetOf(row);
    if (!TARGET_RE.test(target)) { errors.push(`Desktop signing policy targets[${index}] has invalid target ${target || "<missing>"}`); continue; }
    if (targets.has(target)) { errors.push(`Desktop signing policy has duplicate target ${target}`); continue; }
    const expectedSignatureKind = row.platform === "win32" ? "authenticode" : row.platform === "darwin" ? "apple-codesign" : "ed25519-update-manifest";
    if (row.signatureKind !== expectedSignatureKind) errors.push(`Desktop signing policy ${target} must use ${expectedSignatureKind}`);
    if (row.platform === "linux" && !/^[a-f0-9]{64}$/i.test(String(row.publicKeySha256 ?? ""))) errors.push(`Desktop signing policy ${target} requires publicKeySha256`);
    if (row.platform === "win32" && !/^[a-f0-9]{64}$/i.test(String(row.certificateSha256 ?? ""))) errors.push(`Desktop signing policy ${target} requires certificateSha256`);
    if (row.platform === "darwin" && (!/^[A-Z0-9]{10}$/.test(String(row.teamIdentifier ?? "")) || row.notarizationRequired !== true)) errors.push(`Desktop signing policy ${target} requires Team ID and notarizationRequired=true`);
    targets.set(target, row);
  }
  return { policy, sha256, size, targets };
}

function uniqueReports(files, label, errors) {
  const result = new Map();
  for (const file of files) {
    const row = readJson(file, `${label} ${file}`, errors);
    if (!row) continue;
    const target = targetOf(row);
    if (!TARGET_RE.test(target)) { errors.push(`${label} ${file}: invalid target ${target || "<missing>"}`); continue; }
    if (result.has(target)) { errors.push(`${label}: duplicate target ${target}`); continue; }
    result.set(target, row);
  }
  return result;
}

function expandNativeBundles(args, errors) {
  for (const input of args.nativeBundles) {
    const root = path.resolve(input), summaryFile = path.join(root, "native-target-evidence.json");
    try {
      const stat = fs.lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("bundle root must be a real directory");
    } catch (error) { errors.push(`native target bundle ${input}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    const summary = readJson(summaryFile, `native target bundle ${input}`, errors);
    if (!summary || summary.schemaVersion !== 1 || summary.kind !== "freesek-desktop-native-target-evidence-bundle" || summary.passed !== true) { errors.push(`native target bundle ${input}: invalid bundle summary`); continue; }
    const expected = {
      nativePreflight: "native-preflight.json", devSmoke: "dev-smoke.json", packagedSmoke: "packaged-smoke.json", recoverySmoke: "recovery-smoke.json", signingEvidence: "signing-evidence.json", installerEvidence: "installer-evidence.json",
    };
    if (Object.entries(expected).some(([key, value]) => summary[key] !== value)) { errors.push(`native target bundle ${input}: report filenames are not canonical`); continue; }
    args.nativePreflight.push(path.join(root, expected.nativePreflight)); args.devSmoke.push(path.join(root, expected.devSmoke));
    args.packagedSmoke.push(path.join(root, expected.packagedSmoke)); args.recovery.push(path.join(root, expected.recoverySmoke));
    args.signing.push(path.join(root, expected.signingEvidence)); args.installer.push(path.join(root, expected.installerEvidence));
  }
}

const args = parseArgs(process.argv.slice(2));
const errors = [];
expandNativeBundles(args, errors);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const desktopPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "desktop", "package.json"), "utf8"));
const version = String(pkg.version);
const electronPin = String(desktopPkg.devDependencies?.electron ?? "");
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
const gitCommit = git.status === 0 ? String(git.stdout ?? "").trim() : "";
const isRcVersion = /^\d+\.\d+\.\d+-rc\.\d+$/.test(version);
if (!isRcVersion && !args.allowNonRc) errors.push(`committed version ${version} is not an RC version`);
if (!/^[a-f0-9]{40}$/i.test(gitCommit)) errors.push("unable to resolve current Git commit");

const provenance = readJson(args.provenance, "release provenance", errors);
const signingPolicy = readSigningPolicy(args.signingPolicy, errors);
const provenanceSha256 = (() => { try { return digestFile(args.provenance); } catch { return ""; } })();
const targets = new Map();
if (provenance) {
  if (provenance.schemaVersion !== 1 || provenance.kind !== "freeseek-desktop-release-provenance") errors.push("release provenance schema/kind is invalid");
  if (provenance.version !== version || provenance.desktopVersion !== version) errors.push(`release provenance version does not match candidate ${version}`);
  if (provenance.gitCommit !== gitCommit) errors.push("release provenance Git commit does not match current candidate");
  if (provenance.gitTreeState !== "clean") errors.push("release provenance must be generated from a clean worktree");
  if (provenance.electronVersionPin !== electronPin) errors.push(`release provenance Electron pin does not match ${electronPin}`);
  if (!provenance.signingPolicy || provenance.signingPolicy.policyId !== signingPolicy.policy?.policyId || String(provenance.signingPolicy.sha256 ?? "").toLowerCase() !== signingPolicy.sha256 || provenance.signingPolicy.size !== signingPolicy.size) errors.push("release provenance does not bind the supplied Desktop signing policy");
  if (!Array.isArray(provenance.artifacts) || !provenance.artifacts.length) errors.push("release provenance has no artifacts");
  for (const artifact of provenance.artifacts ?? []) {
    const target = targetOf(artifact);
    if (!TARGET_RE.test(target)) { errors.push(`release provenance artifact has invalid target ${target || "<missing>"}`); continue; }
    if (targets.has(target)) { errors.push(`release provenance has duplicate target ${target}`); continue; }
    if (artifact.electronVersion !== electronPin || !/^[a-f0-9]{64}$/i.test(String(artifact.stageManifestSha256 ?? "")) || !/^[a-f0-9]{64}$/i.test(String(artifact.sha256 ?? ""))) errors.push(`release provenance evidence is incomplete for ${target}`);
    targets.set(target, artifact);
  }
  if (signingPolicy.targets.size !== targets.size || [...targets.keys()].some((target) => !signingPolicy.targets.has(target))) errors.push("Desktop signing policy targets do not exactly match release provenance targets");
}

const devReports = args.devSmoke.map((file) => ({ file, row: readJson(file, `dev smoke ${file}`, errors) })).filter((entry) => entry.row);
const validDev = devReports.some(({ row }) => row.kind === "freesek-desktop-electron-e2e"
  && row.passed === true && row.packagedMode === false && row.versionMatched === true && row.testNoSandbox === false
  && row.electronVersion === electronPin && row.expectedElectronVersion === electronPin
  && row.freesekVersion === version && String(row.gitCommit ?? "").toLowerCase() === gitCommit.toLowerCase());
if (!validDev) errors.push("no exact candidate development Electron smoke evidence");

const nativePreflight = uniqueReports(args.nativePreflight, "native preflight", errors);
const packaged = uniqueReports(args.packagedSmoke, "packaged smoke", errors);
const recovery = uniqueReports(args.recovery, "recovery evidence", errors);
const installers = uniqueReports(args.installer, "installer evidence", errors);
const signing = uniqueReports(args.signing, "signing evidence", errors);
for (const [target, artifact] of targets) {
  const preflight = nativePreflight.get(target);
  const expectedElectronAsset = `electron-v${electronPin}-${artifact.platform}-${artifact.arch}.zip`;
  if (!preflight) errors.push(`missing official Electron native preflight for ${target}`);
  else if (preflight.schemaVersion !== 1 || preflight.kind !== "freesek-desktop-native-target-preflight" || preflight.passed !== true
    || preflight.version !== version || preflight.gitCommit !== gitCommit || preflight.electronVersion !== electronPin || preflight.electronArchiveAsset !== expectedElectronAsset
    || !/^[a-f0-9]{64}$/i.test(String(preflight.electronArchiveSha256 ?? "")) || !/^[a-f0-9]{64}$/i.test(String(preflight.electronShasumsSha256 ?? ""))
    || preflight.stageManifestSha256 !== artifact.stageManifestSha256 || preflight.target !== target) {
    errors.push(`official Electron native preflight is incomplete for ${target}`);
  }
  const smoke = packaged.get(target);
  if (!smoke) errors.push(`missing packaged smoke for ${target}`);
  else {
    const secureBackend = String(smoke.secretBackend ?? "");
    if (smoke.kind !== "freesek-desktop-electron-e2e" || smoke.passed !== true || smoke.packagedMode !== true || smoke.appIsPackaged !== true
      || smoke.versionMatched !== true || smoke.testNoSandbox !== false || smoke.electronVersion !== electronPin || smoke.expectedElectronVersion !== electronPin
      || smoke.freesekVersion !== version || String(smoke.gitCommit ?? "").toLowerCase() !== gitCommit.toLowerCase()
      || smoke.stageManifestSha256 !== artifact.stageManifestSha256
      || smoke.secretStoreRequested !== true || smoke.secretStoreVerified !== true || smoke.secretDiagnosticsClean !== true || !secureBackend || secureBackend === "basic_text") {
      errors.push(`packaged smoke does not satisfy exact runtime/secret gate for ${target}`);
    }
  }
  const recoveryReport = recovery.get(target);
  if (!recoveryReport) errors.push(`missing packaged recovery evidence for ${target}`);
  else if (recoveryReport.schemaVersion !== 1 || recoveryReport.kind !== "freesek-desktop-packaged-recovery-e2e" || recoveryReport.passed !== true
    || recoveryReport.version !== version || recoveryReport.gitCommit !== gitCommit || recoveryReport.appIsPackaged !== true || recoveryReport.versionMatched !== true
    || recoveryReport.testNoSandbox !== false || recoveryReport.electronVersion !== electronPin || recoveryReport.expectedElectronVersion !== electronPin
    || recoveryReport.stageManifestSha256 !== artifact.stageManifestSha256 || recoveryReport.interruptedMarkerObserved !== true
    || recoveryReport.markerSurvivedForcedTermination !== true || recoveryReport.recoveredSameSession !== true || recoveryReport.markerClearedAfterRecovery !== true) {
    errors.push(`packaged crash/recovery evidence is incomplete for ${target}`);
  }
  const install = installers.get(target);
  if (!install) errors.push(`missing installer upgrade/rollback evidence for ${target}`);
  else {
    const expectedInstallerKind = artifact.platform === "linux" ? "portable-tar-gzip-v1" : "portable-zip-v1";
    if (install.schemaVersion !== 1 || install.kind !== "freeseek-desktop-installer-rollback-evidence" || install.passed !== true
      || install.version !== version || install.gitCommit !== gitCommit || install.artifactSha256 !== artifact.sha256 || install.provenanceSha256 !== provenanceSha256
      || install.installerKind !== expectedInstallerKind || install.nativePlatformVerified !== true
      || install.candidateStageManifestSha256 !== artifact.stageManifestSha256 || install.installedStageManifestSha256 !== artifact.stageManifestSha256
      || !/^[a-f0-9]{64}$/i.test(String(install.installedExecutableSha256 ?? "")) || !/^[a-f0-9]{64}$/i.test(String(install.rollbackInstalledStageManifestSha256 ?? ""))
      || !String(install.fromVersion ?? "") || install.fromVersion === version
      || install.freshInstallSucceeded !== true || install.uninstallScenarioExecuted !== true || install.uninstallSucceeded !== true
      || install.upgradeSucceeded !== true || install.rollbackScenarioExecuted !== true || install.rollbackRestoredPreviousVersion !== true) {
      errors.push(`installer upgrade/rollback evidence is incomplete for ${target}`);
    }
  }
  const sign = signing.get(target);
  if (!sign) errors.push(`missing signing evidence for ${target}`);
  else {
    const expectedSignatureKind = artifact.platform === "win32" ? "authenticode" : artifact.platform === "darwin" ? "apple-codesign" : "ed25519-update-manifest";
    const policy = signingPolicy.targets.get(target);
    const signerIdentityMatchesPolicy = !!policy && sign.signerIdentityMatched === true && sign.signingPolicySha256 === signingPolicy.sha256
      && (artifact.platform === "linux" ? String(sign.publicKeySha256 ?? "").toLowerCase() === String(policy.publicKeySha256 ?? "").toLowerCase()
        : artifact.platform === "win32" ? String(sign.certificateSha256 ?? "").toLowerCase() === String(policy.certificateSha256 ?? "").toLowerCase()
        : sign.teamIdentifier === policy.teamIdentifier);
    const installedExecutableMatchesSigned = artifact.platform === "linux" || (!!install
      && /^[a-f0-9]{64}$/i.test(String(sign.signedExecutableSha256 ?? ""))
      && String(install.installedExecutableSha256 ?? "").toLowerCase() === String(sign.signedExecutableSha256).toLowerCase());
    if (sign.schemaVersion !== 1 || sign.kind !== "freeseek-desktop-signing-evidence" || sign.passed !== true
      || sign.version !== version || sign.gitCommit !== gitCommit || sign.artifactSha256 !== artifact.sha256
      || sign.provenanceSha256 !== provenanceSha256 || sign.stageManifestSha256 !== artifact.stageManifestSha256 || sign.signatureVerified !== true
      || sign.signatureKind !== expectedSignatureKind || !signerIdentityMatchesPolicy || !installedExecutableMatchesSigned
      || (artifact.platform === "darwin" && (sign.notarized !== true || policy?.notarizationRequired !== true))) {
      errors.push(`signing/notarization evidence is incomplete for ${target}`);
    }
  }
}
for (const [target] of nativePreflight) if (!targets.has(target)) errors.push(`native preflight target ${target} is not in release provenance`);
for (const [target] of packaged) if (!targets.has(target)) errors.push(`packaged smoke target ${target} is not in release provenance`);
for (const [target] of recovery) if (!targets.has(target)) errors.push(`recovery evidence target ${target} is not in release provenance`);
for (const [target] of installers) if (!targets.has(target)) errors.push(`installer evidence target ${target} is not in release provenance`);
for (const [target] of signing) if (!targets.has(target)) errors.push(`signing evidence target ${target} is not in release provenance`);

let interopSummary = null;
if (args.interop.length < 2) errors.push("at least two independent ACP interop reports are required");
else if (/^[a-f0-9]{40}$/i.test(gitCommit)) {
  const gate = spawnSync(process.execPath, [path.join(ROOT, "scripts", "acp-interop-gate.mjs"), ...args.interop.map((file) => path.resolve(file)), "--min-clients", "2", "--expected-version", version, "--expected-commit", gitCommit], { cwd: ROOT, encoding: "utf8" });
  try { interopSummary = JSON.parse(String(gate.stdout ?? "{}")); } catch { interopSummary = null; }
  if (gate.status !== 0 || interopSummary?.passed !== true) errors.push("candidate-bound independent ACP interoperability gate failed");
}

const summary = {
  schemaVersion: 1,
  kind: "freesek-desktop-rc-evidence-gate",
  version,
  gitCommit,
  electronPin,
  releaseTargets: [...targets.keys()].sort(),
  signingPolicyId: signingPolicy.policy?.policyId ?? null,
  signingPolicySha256: signingPolicy.sha256 || null,
  exactDevSmoke: validDev,
  nativePreflightTargets: [...nativePreflight.keys()].sort(),
  packagedSmokeTargets: [...packaged.keys()].sort(),
  recoveryEvidenceTargets: [...recovery.keys()].sort(),
  installerEvidenceTargets: [...installers.keys()].sort(),
  signingEvidenceTargets: [...signing.keys()].sort(),
  independentInterop: interopSummary,
  passed: errors.length === 0,
  rcEligible: errors.length === 0 && isRcVersion,
  preflightOnly: !isRcVersion,
  errors,
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (errors.length) process.exitCode = 1;
