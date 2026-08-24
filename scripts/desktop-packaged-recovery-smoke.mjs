#!/usr/bin/env node
/** Packaged crash/kill → restart → same-session recovery evidence for a native Desktop target. */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePortableStage } from "./lib/desktop-portable-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node scripts/desktop-packaged-recovery-smoke.mjs --stage dir --arch x64|arm64 --out report.json"); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["stage", "arch", "out"]) if (!out[key]) fail(`--${key} is required`);
  if (!/^(x64|arm64)$/.test(out.arch)) fail("--arch must be x64 or arm64");
  return out;
}
function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return String(result.stdout ?? "").trim();
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(file, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (value?.passed === false) throw new Error(`${label} failed: ${String(value.error ?? "unknown Electron E2E failure")}`);
        if (predicate(value)) return value;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`${label} failed:`)) throw error;
      }
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}: ${file}`);
}
function launchCommand(executable) {
  const forceRealDisplay = process.env.FREESEEK_DESKTOP_USE_REAL_DISPLAY === "1";
  if (process.platform === "linux" && !forceRealDisplay && spawnSync("which", ["xvfb-run"]).status === 0) return { bin: "xvfb-run", args: ["-a", executable] };
  return { bin: executable, args: [] };
}
function launchPackaged(executable, configFile) {
  const env = { ...process.env, FREESEEK_DESKTOP_E2E_CONFIG: configFile };
  delete env.FREESEEK_REPO_ROOT; delete env.FREESEEK_ACP_ENTRY; delete env.FREESEEK_NODE_BIN; delete env.FREESEEK_API_KEY;
  delete env.FREESEEK_ALLOW_ELECTRON_VERSION_MISMATCH; delete env.FREESEEK_DESKTOP_E2E_NO_SANDBOX;
  const command = launchCommand(executable);
  const child = spawn(command.bin, command.args, { cwd: ROOT, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
  child.once("close", (code, signal) => { closed = true; resolveClosed({ code, signal }); });
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; }); child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }), closed: () => closed, closedPromise };
}
function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
}
async function waitForClose(launch, timeoutMs) {
  if (launch.closed()) return { code: launch.child.exitCode, signal: launch.child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("packaged recovery launch timed out waiting for process close")), timeoutMs);
    launch.closedPromise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
async function closeProvider(provider, hangingResponses) {
  for (const res of hangingResponses) { try { res.destroy(); } catch {} }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try { provider.close(finish); provider.closeAllConnections?.(); provider.closeIdleConnections?.(); } catch { finish(); }
    const timer = setTimeout(finish, 1_000); timer.unref?.();
  });
}
async function startProvider(mode) {
  const hangingResponses = new Set();
  const provider = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
    if (mode === "hang") {
      hangingResponses.add(res);
      res.on("close", () => hangingResponses.delete(res));
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "RECOVERY_E2E_OK" }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address !== "object") throw new Error("recovery mock provider failed to listen");
  return { provider, hangingResponses, baseUrl: `http://127.0.0.1:${address.port}` };
}
async function cleanupTemp(temp) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); return; }
    catch (error) {
      if (attempt === 7) throw error;
      await sleep(150 * (attempt + 1));
    }
  }
}
function writeConfig(file, payload) { fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8"); }

try {
  const args = parseArgs(process.argv.slice(2));
  if (process.arch !== args.arch) fail(`native recovery architecture mismatch: runtime ${process.arch}, requested ${args.arch}`);
  if (git(["status", "--porcelain"])) fail("packaged recovery evidence requires a clean committed worktree");
  const gitCommit = git(["rev-parse", "HEAD"]), target = `${process.platform}/${args.arch}`;
  const stage = validatePortableStage(path.resolve(args.stage), target), executable = path.resolve(stage.root, String(stage.manifest.electronExecutable ?? ""));
  if (!fs.existsSync(executable)) fail(`packaged executable missing: ${executable}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-desktop-recovery-e2e-"));
  const workspace = path.join(temp, "workspace"), userData = path.join(temp, "user-data"), interruptResult = path.join(temp, "interrupt.json"), resumeResult = path.join(temp, "resume.json");
  const interruptConfig = path.join(temp, "interrupt-config.json"), resumeConfig = path.join(temp, "resume-config.json"), recoveryFile = path.join(userData, "recovery.json");
  fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, "artifact.txt"), "RECOVERY_E2E\n", "utf8");
  let interruptProvider;
  let resumeProvider;
  try {
    interruptProvider = await startProvider("hang");
    const baseRequest = { workspace, provider: { model: "desktop-recovery-e2e", format: "openai", toolMode: "native", authType: "none" }, allowShell: false, allowNetwork: true, enableSkills: true, skillDirs: [], enableMultiAgent: false, additionalDirectories: [], mcpServers: [] };
    const interruptRequest = { ...baseRequest, provider: { ...baseRequest.provider, baseUrl: interruptProvider.baseUrl } };
    writeConfig(interruptConfig, { workspace, userData, resultFile: interruptResult, request: interruptRequest, mode: "recovery-interrupt" });
    const first = launchPackaged(executable, interruptConfig);
    let second;
    try {
      const armed = await waitFor(interruptResult, (value) => value?.passed === true && value?.result?.interruptionArmed === true, 30_000, "recovery interruption result");
      const sessionId = String(armed.result.sessionId ?? ""); if (!sessionId) throw new Error("recovery interruption did not return a session id");
      const marker = await waitFor(recoveryFile, (value) => value?.inFlight === true && value?.sessionId === sessionId, 10_000, "recovery journal marker");
      if (path.resolve(String(marker.workspace ?? "")) !== path.resolve(workspace)) throw new Error("recovery marker workspace mismatch");
      killProcessTree(first.child);
      await waitForClose(first, 10_000);
      await closeProvider(interruptProvider.provider, interruptProvider.hangingResponses);
      interruptProvider = undefined;
      await sleep(250);
      if (!fs.existsSync(recoveryFile)) throw new Error("recovery marker disappeared after forced process termination");

      resumeProvider = await startProvider("success");
      const resumeRequest = { ...baseRequest, provider: { ...baseRequest.provider, baseUrl: resumeProvider.baseUrl } };
      writeConfig(resumeConfig, { workspace, userData, resultFile: resumeResult, request: resumeRequest, mode: "recovery-resume", expectedSessionId: sessionId });
      second = launchPackaged(executable, resumeConfig);
      let resumed;
      try {
        resumed = await waitFor(resumeResult, (value) => value?.passed === true, 30_000, "recovery resume result");
      } catch (error) {
        const output = second.output();
        throw new Error(`${error instanceof Error ? error.message : String(error)}; packaged output=${JSON.stringify(output)}`);
      }
      const secondClose = await waitForClose(second, 10_000);
      if (secondClose.code !== 0) throw new Error(`recovery resume launch failed: ${JSON.stringify(second.output())}`);
      const result = resumed.result ?? {};
      if (result.appIsPackaged !== true || result.recoveredSameSession !== true || result.sessionId !== sessionId || result.stopReason !== "end_turn") throw new Error(`packaged recovery contract mismatch: ${JSON.stringify(resumed)}`);
      if (fs.existsSync(recoveryFile)) throw new Error("recovery marker was not cleared after successful recovery");
      const report = {
        schemaVersion: 1, kind: "freesek-desktop-packaged-recovery-e2e", passed: true,
        version: String(stage.manifest.version), gitCommit, platform: process.platform, arch: args.arch, target,
        electronVersion: String(stage.manifest.electronVersion), expectedElectronVersion: String(stage.manifest.expectedElectronVersion), versionMatched: stage.manifest.versionMatched === true,
        stageManifestSha256: stage.manifestSha256, appIsPackaged: true, testNoSandbox: false,
        interruptedMarkerObserved: true, markerSurvivedForcedTermination: true, recoveredSameSession: true, markerClearedAfterRecovery: true, recoveredSessionId: sessionId,
      };
      const out = path.resolve(args.out); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } finally {
      if (!first.closed()) { killProcessTree(first.child); try { await waitForClose(first, 5_000); } catch {} }
      if (second && !second.closed()) { killProcessTree(second.child); try { await waitForClose(second, 5_000); } catch {} }
    }
  } finally {
    if (interruptProvider) await closeProvider(interruptProvider.provider, interruptProvider.hangingResponses);
    if (resumeProvider) await closeProvider(resumeProvider.provider, resumeProvider.hangingResponses);
    try { await cleanupTemp(temp); }
    catch (cleanupError) { console.warn(`warning: recovery temp cleanup deferred: ${temp}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
  }
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
