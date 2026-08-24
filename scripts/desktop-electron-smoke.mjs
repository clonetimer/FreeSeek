#!/usr/bin/env node
/** Real Electron BrowserWindow → preload → IPC → Desktop Runtime → ACP child E2E. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electron = process.env.FREESEEK_ELECTRON_BIN || resolve(ROOT, "apps/desktop/node_modules/electron/dist/electron");
if (!existsSync(electron)) {
  console.error(`Electron runtime unavailable: ${electron}`);
  console.error("Install the Electron version pinned by apps/desktop/package.json or set FREESEEK_ELECTRON_BIN.");
  process.exit(2);
}
const desktopPackage = JSON.parse(readFileSync(resolve(ROOT, "apps/desktop/package.json"), "utf8"));
const rootPackage = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const gitProbe = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
const runnerGitCommit = gitProbe.status === 0 ? String(gitProbe.stdout || "").trim() : "";
const pinnedElectronVersion = String(desktopPackage.devDependencies?.electron || "").trim();
const testNoSandbox = process.env.FREESEEK_DESKTOP_E2E_NO_SANDBOX === "1";
const packagedMode = process.env.FREESEEK_DESKTOP_PACKAGED_E2E === "1";
const verifySecretStore = process.env.FREESEEK_DESKTOP_E2E_VERIFY_SECRET === "1";
const e2eProviderSecret = "DESKTOP_E2E_OS_SECRET";
const evidenceOut = process.env.FREESEEK_DESKTOP_E2E_EVIDENCE_OUT?.trim();
const electronFlags = testNoSandbox ? ["--no-sandbox"] : [];
let electronVersion = "";
let expectedElectronVersion = pinnedElectronVersion;
let versionMatched = false;
let evidencePlatform = process.platform;
let evidenceArch = process.arch;
let freesekVersion = String(rootPackage.version);
let stageManifestSha256 = "";
if (packagedMode) {
  const executableDir = dirname(electron);
  const manifestCandidates = [
    resolve(executableDir, "freesek-release-manifest.json"),
    resolve(executableDir, "../../..", "freesek-release-manifest.json"),
  ];
  const manifestFile = manifestCandidates.find((candidate) => existsSync(candidate));
  if (!manifestFile) {
    console.error(`Packaged Desktop release manifest unavailable near executable: ${electron}`);
    process.exit(2);
  }
  const stageManifestBytes = readFileSync(manifestFile);
  const stageManifest = JSON.parse(stageManifestBytes.toString("utf8"));
  stageManifestSha256 = createHash("sha256").update(stageManifestBytes).digest("hex");
  freesekVersion = String(stageManifest.version || "");
  if (stageManifest.kind !== "freeseek-desktop-portable-stage") {
    console.error(`Unexpected packaged Desktop manifest kind: ${stageManifest.kind}`);
    process.exit(2);
  }
  electronVersion = String(stageManifest.electronVersion || "").trim();
  evidencePlatform = String(stageManifest.platform || process.platform);
  evidenceArch = String(stageManifest.arch || process.arch);
  if (evidencePlatform !== process.platform || evidenceArch !== process.arch) {
    console.error(`Packaged Desktop target mismatch: stage ${evidencePlatform}/${evidenceArch}, runtime ${process.platform}/${process.arch}`);
    process.exit(2);
  }
  expectedElectronVersion = String(stageManifest.expectedElectronVersion || pinnedElectronVersion).trim();
  versionMatched = stageManifest.versionMatched === true && electronVersion === expectedElectronVersion;
} else {
  const versionProbe = spawnSync(electron, [...electronFlags, "--version"], { cwd: ROOT, encoding: "utf8" });
  if (versionProbe.status !== 0) {
    console.error(`Unable to probe Electron runtime version: ${electron}`);
    console.error(versionProbe.stderr || versionProbe.stdout || `exit=${versionProbe.status}`);
    process.exit(2);
  }
  electronVersion = String(versionProbe.stdout || versionProbe.stderr || "").trim().replace(/^v/, "");
  versionMatched = !!expectedElectronVersion && electronVersion === expectedElectronVersion;
}
if (!versionMatched && process.env.FREESEEK_ALLOW_ELECTRON_VERSION_MISMATCH !== "1") {
  console.error(`Electron version mismatch: expected ${expectedElectronVersion || "<unset>"}, got ${electronVersion || "<unknown>"}`);
  console.error("Set FREESEEK_ALLOW_ELECTRON_VERSION_MISMATCH=1 only for compatibility preflight; mismatched runtime evidence is not an RC gate pass.");
  process.exit(2);
}
if (!versionMatched) {
  console.error(`[desktop-smoke] compatibility preflight only: Electron ${electronVersion}, RC pin ${expectedElectronVersion}`);
}
if (testNoSandbox) {
  console.error("[desktop-smoke] --no-sandbox enabled explicitly for isolated test execution; this is not a production launch configuration");
}

function runNode(script) {
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
let acpEvidence = "";
if (!packagedMode) {
  runNode(resolve(ROOT, "scripts/desktop-build.mjs"));
  runNode(resolve(ROOT, "scripts/build-acp-verification.mjs"));
  const productionAcp = resolve(ROOT, "dist/freeseek-acp.js");
  const verificationAcp = resolve(ROOT, ".freesek/acp-verification/freeseek-acp-verification.cjs");
  acpEvidence = existsSync(productionAcp) ? productionAcp : verificationAcp;
  if (!existsSync(acpEvidence)) throw new Error(`ACP entry missing: ${productionAcp} or ${verificationAcp}`);
}
const temp = mkdtempSync(join(tmpdir(), "freesek-desktop-electron-e2e-"));
const workspace = join(temp, "workspace");
const userData = join(temp, "user-data");
const resultFile = join(temp, "result.json");
const configFile = join(temp, "config.json");
spawnSync(process.execPath, ["-e", `require('node:fs').mkdirSync(${JSON.stringify(workspace)},{recursive:true})`]);
writeFileSync(join(workspace, "artifact.txt"), "DESKTOP_ARTIFACT_E2E\n", "utf8");

const provider = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ELECTRON_DESKTOP_E2E_OK" }, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
const address = provider.address();
if (!address || typeof address !== "object") throw new Error("mock provider failed to listen");
writeFileSync(configFile, JSON.stringify({
  workspace,
  userData,
  resultFile,
  request: {
    workspace,
    provider: { baseUrl: `http://127.0.0.1:${address.port}`, model: "desktop-electron-e2e", format: "openai", toolMode: "native", authType: "none", ...(verifySecretStore ? { apiKey: e2eProviderSecret } : {}) },
    allowShell: false,
    allowNetwork: true,
    enableSkills: true,
    skillDirs: [],
    enableMultiAgent: false,
    additionalDirectories: [],
    mcpServers: [],
  },
  verifySecretStore,
}, null, 2));

const appDir = resolve(ROOT, "apps/desktop");
const env = packagedMode
  ? { ...process.env, FREESEEK_DESKTOP_E2E_CONFIG: configFile }
  : { ...process.env, FREESEEK_REPO_ROOT: ROOT, FREESEEK_ACP_ENTRY: acpEvidence, FREESEEK_DESKTOP_E2E_CONFIG: configFile };
if (packagedMode) {
  delete env.FREESEEK_REPO_ROOT;
  delete env.FREESEEK_ACP_ENTRY;
  delete env.FREESEEK_NODE_BIN;
  delete env.FREESEEK_API_KEY;
}
const launchArgs = packagedMode ? [...electronFlags] : [...electronFlags, appDir];
const forceRealDisplay = process.env.FREESEEK_DESKTOP_USE_REAL_DISPLAY === "1";
const command = process.platform === "linux" && !forceRealDisplay && spawnSync("which", ["xvfb-run"]).status === 0
  ? { bin: "xvfb-run", args: ["-a", electron, ...launchArgs] }
  : { bin: electron, args: launchArgs };
const child = spawn(command.bin, command.args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
child.stdout?.on("data", (chunk) => { stdout += chunk; });
child.stderr?.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Electron E2E timed out\nstdout=${stdout}\nstderr=${stderr}`)); }, 30_000);
  child.once("exit", (code) => { clearTimeout(timer); resolveExit(code); });
});
try {
  if (!existsSync(resultFile)) throw new Error(`Electron E2E produced no result; exit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
  const evidence = JSON.parse(readFileSync(resultFile, "utf8"));
  if (exitCode !== 0 || evidence.passed !== true) throw new Error(`Electron E2E failed: ${JSON.stringify(evidence)}\nstdout=${stdout}\nstderr=${stderr}`);
  const result = evidence.result || {};
  const secretDiagnosticsClean = !verifySecretStore || !`${stdout}\n${stderr}`.includes(e2eProviderSecret);
  if (!secretDiagnosticsClean) throw new Error("Electron E2E detected provider secret bytes in child stdout/stderr diagnostics");
  if (result.brand !== "FreeSeek" || result.bridge !== true || result.stopReason !== "end_turn" || result.listedSession !== true || result.historySession !== true || result.resumedSameSession !== true || result.replayedHistory !== true || result.settingsRoundTrip !== true || result.artifactPreview !== true || result.appIsPackaged !== packagedMode || (verifySecretStore && result.secretStoreVerified !== true) || !String(result.sessionUpdateText).includes("ELECTRON_DESKTOP_E2E_OK")) {
    throw new Error(`Electron E2E contract mismatch: ${JSON.stringify(evidence)}`);
  }
  const report = {
    schemaVersion: 1,
    kind: "freesek-desktop-electron-e2e",
    passed: true,
    platform: evidencePlatform,
    arch: evidenceArch,
    freesekVersion,
    gitCommit: runnerGitCommit || null,
    stageManifestSha256: stageManifestSha256 || null,
    electron,
    electronVersion,
    expectedElectronVersion,
    versionMatched,
    testNoSandbox,
    packagedMode,
    secretStoreRequested: verifySecretStore,
    secretDiagnosticsClean,
    ...result,
  };
  if (evidenceOut) {
    const file = resolve(evidenceOut);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  provider.close();
  rmSync(temp, { recursive: true, force: true });
}
