#!/usr/bin/env node
/** Exercise real portable fresh-install/upgrade/rollback swaps without claiming final OS-installer evidence. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installPortableStage, readPortableInstallState, rollbackPortableStage, validatePortableStage } from "./lib/desktop-portable-install.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      console.log("Usage: node scripts/desktop-portable-install-preflight.mjs --previous-stage dir --candidate-stage dir [--out report.json]");
      process.exit(0);
    }
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) throw new Error(`Missing value for ${key}`);
    out[key.slice(2)] = value;
  }
  if (!out["previous-stage"] || !out["candidate-stage"]) throw new Error("--previous-stage and --candidate-stage are required");
  return out;
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
const args = parseArgs(process.argv.slice(2));
const previous = validatePortableStage(path.resolve(args["previous-stage"]));
const candidate = validatePortableStage(path.resolve(args["candidate-stage"]), previous.target);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-install-preflight-"));
let freshInstallSucceeded = false, upgradeSucceeded = false, rollbackScenarioExecuted = false, rollbackRestoredPreviousVersion = false;
let installedStageManifestSha256 = null, rollbackInstalledStageManifestSha256 = null;
try {
  const freshRoot = path.join(temp, "fresh");
  const fresh = installPortableStage(candidate.root, freshRoot);
  const freshInstalled = validatePortableStage(path.join(freshRoot, "current"), candidate.target);
  installedStageManifestSha256 = freshInstalled.embeddedManifestSha256;
  freshInstallSucceeded = fresh.current.version === candidate.manifest.version
    && readPortableInstallState(freshRoot)?.current.stageManifestSha256 === candidate.manifestSha256
    && installedStageManifestSha256 === candidate.manifestSha256;

  const upgradeRoot = path.join(temp, "upgrade");
  const first = installPortableStage(previous.root, upgradeRoot);
  if (first.current.version !== previous.manifest.version) throw new Error("Previous portable stage did not fresh-install correctly");
  const upgraded = installPortableStage(candidate.root, upgradeRoot);
  const upgradedInstalled = validatePortableStage(path.join(upgradeRoot, "current"), candidate.target);
  installedStageManifestSha256 = upgradedInstalled.embeddedManifestSha256;
  upgradeSucceeded = upgraded.current.version === candidate.manifest.version && upgraded.previous?.version === previous.manifest.version
    && installedStageManifestSha256 === candidate.manifestSha256;
  rollbackScenarioExecuted = true;
  const rolledBack = rollbackPortableStage(upgradeRoot);
  const rollbackInstalled = validatePortableStage(path.join(upgradeRoot, "current"), previous.target);
  rollbackInstalledStageManifestSha256 = rollbackInstalled.embeddedManifestSha256;
  rollbackRestoredPreviousVersion = rolledBack.current.version === previous.manifest.version
    && rolledBack.current.stageManifestSha256 === previous.manifestSha256
    && rollbackInstalledStageManifestSha256 === previous.manifestSha256
    && !rolledBack.previous;

  const report = {
    schemaVersion: 1,
    kind: "freeseek-desktop-portable-installer-preflight",
    passed: freshInstallSucceeded && upgradeSucceeded && rollbackScenarioExecuted && rollbackRestoredPreviousVersion,
    target: candidate.target,
    platform: candidate.manifest.platform,
    arch: candidate.manifest.arch,
    fromVersion: previous.manifest.version,
    toVersion: candidate.manifest.version,
    previousStageManifestSha256: previous.manifestSha256,
    candidateStageManifestSha256: candidate.manifestSha256,
    installedStageManifestSha256,
    rollbackInstalledStageManifestSha256,
    freshInstallSucceeded,
    upgradeSucceeded,
    rollbackScenarioExecuted,
    rollbackRestoredPreviousVersion,
    evidenceId: sha256(`${previous.manifestSha256}:${candidate.manifestSha256}:${candidate.target}`),
    note: "Preflight only: directory-swap driver evidence is not freesek-desktop-installer-rollback-evidence and is not accepted by the RC aggregate gate.",
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (args.out) { const out = path.resolve(args.out); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, { encoding: "utf8", mode: 0o600 }); }
  process.stdout.write(text);
  if (!report.passed) process.exitCode = 1;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
