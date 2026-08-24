#!/usr/bin/env node
/**
 * Independent interoperability driver using the external acpx CLI client.
 * acpx owns the ACP protocol/session implementation; this adapter only supplies
 * FreeSeek as a structured custom agent and validates acpx's raw JSON stream.
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function versionOf(bin) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return "unknown";
  return (result.stdout || result.stderr).trim().split(/\s+/).pop() || "unknown";
}

async function main() {
  const bin = process.env.FREESEEK_ACPX_BIN || "acpx";
  const command = required("FREESEEK_ACP_AGENT_COMMAND");
  const args = JSON.parse(required("FREESEEK_ACP_AGENT_ARGS_JSON"));
  const workspace = required("FREESEEK_ACP_WORKSPACE");
  writeFileSync(join(workspace, ".acpxrc.json"), JSON.stringify({
    defaultPermissions: "approve-all",
    nonInteractivePermissions: "fail",
    authPolicy: "skip",
    agents: { freesek: { argv: [command, ...args] } },
  }, null, 2) + "\n", "utf8");

  const child = spawn(bin, [
    "--cwd", workspace,
    "--format", "json",
    "--json-strict",
    "--approve-all",
    "freesek",
    "exec",
    "Return the external interoperability marker.",
  ], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`acpx exited ${exitCode}: ${stderr.slice(-2000)}`);

  const frames = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const methods = new Set(frames.map((row) => row?.method).filter(Boolean));
  const hasError = frames.some((row) => row?.error);
  const init = methods.has("initialize") || frames.some((row) => row?.result?.protocolVersion === 1);
  const newSession = methods.has("session/new") || frames.some((row) => typeof row?.result?.sessionId === "string");
  const prompt = methods.has("session/prompt") || frames.some((row) => typeof row?.result?.stopReason === "string");
  const sessionUpdate = methods.has("session/update");
  if (hasError) throw new Error(`acpx stream contained ACP error: ${stdout.slice(-3000)}`);

  process.stdout.write(JSON.stringify({
    freesekAcpInterop: 1,
    implementationOwner: "openclaw",
    implementationId: "acpx",
    clientVersion: versionOf(bin),
    initialize: init,
    newSession,
    prompt,
    sessionUpdate,
    advancedCapabilities: [],
  }) + "\n");
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
