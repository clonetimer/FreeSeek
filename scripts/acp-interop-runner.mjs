#!/usr/bin/env node
/**
 * Evidence wrapper for an independent ACP client driver.
 *
 * The external driver must launch the FreeSeek agent using the environment
 * variables below and print one JSON line shaped as:
 * {"freesekAcpInterop":1,"implementationOwner":"...","implementationId":"...","clientVersion":"...","initialize":true,"newSession":true,"prompt":true,"sessionUpdate":true,"advancedCapabilities":[]}
 * An exit code alone is never accepted as interoperability evidence.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

function usage() {
  return [
    "Usage: node scripts/acp-interop-runner.mjs --name <client> --command <driver> [--output <json>] [-- <driver args...>]",
    "",
    "The driver receives:",
    "  FREESEEK_ACP_AGENT_COMMAND",
    "  FREESEEK_ACP_AGENT_ARGS_JSON",
    "  FREESEEK_ACP_WORKSPACE",
    "  FREESEEK_ACP_SESSION_DIR",
    "",
    "The driver must exercise an independent ACP client implementation and emit",
    '{"freesekAcpInterop":1,"implementationOwner":"...","implementationId":"...","clientVersion":"...","initialize":true,"newSession":true,"prompt":true,"sessionUpdate":true,"advancedCapabilities":[]}.',
  ].join("\n");
}

function parseArgs(argv) {
  const split = argv.indexOf("--");
  const own = split >= 0 ? argv.slice(0, split) : argv;
  const driverArgs = split >= 0 ? argv.slice(split + 1) : [];
  const value = (name) => {
    const i = own.indexOf(name);
    if (i < 0) return "";
    if (!own[i + 1]) throw new Error(`${name} requires a value`);
    return own[i + 1];
  };
  const name = value("--name");
  const command = value("--command");
  if (!name || !command) throw new Error(usage());
  return { name, command, driverArgs, output: value("--output") };
}

function startMockProvider() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "EXTERNAL_INTEROP_OK" }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveStart({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const workspace = mkdtempSync(join(tmpdir(), "freesek-acp-external-workspace-"));
  const sessions = mkdtempSync(join(tmpdir(), "freesek-acp-external-sessions-"));
  const provider = await startMockProvider();
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const gitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (gitResult.status !== 0) throw new Error("Unable to resolve FreeSeek Git commit for ACP interoperability evidence");
  const gitCommit = String(gitResult.stdout ?? "").trim();
  if (!/^[a-f0-9]{40}$/i.test(gitCommit)) throw new Error("Invalid FreeSeek Git commit for ACP interoperability evidence");
  const build = JSON.parse(readFileSync(join(root, ".freesek", "acp-verification", "build.json"), "utf8"));
  if (!build?.agentBin) throw new Error("ACP verification build missing; run scripts/build-acp-verification.mjs first");
  const agentArgs = [
    build.agentBin,
    "--base-url", provider.url,
    "--model", "external-interop",
    "--auth-type", "none",
    "--yes",
    "--no-skills",
    "--session-dir", sessions,
  ];
  let stdout = "";
  let stderr = "";
  const startedAt = new Date().toISOString();
  try {
    const child = spawn(args.command, args.driverArgs, {
      cwd: root,
      env: {
        ...process.env,
        FREESEEK_ACP_AGENT_COMMAND: process.execPath,
        FREESEEK_ACP_AGENT_ARGS_JSON: JSON.stringify(agentArgs),
        FREESEEK_ACP_WORKSPACE: workspace,
        FREESEEK_ACP_SESSION_DIR: sessions,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolveExit(code ?? 1));
    });
    const evidence = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((row) => row?.freesekAcpInterop === 1);
    const accepted = exitCode === 0
      && evidence?.initialize === true
      && evidence?.newSession === true
      && evidence?.prompt === true
      && evidence?.sessionUpdate === true
      && typeof evidence?.implementationOwner === "string" && evidence.implementationOwner.length > 0
      && typeof evidence?.implementationId === "string" && evidence.implementationId.length > 0
      && typeof evidence?.clientVersion === "string" && evidence.clientVersion.length > 0
      && Array.isArray(evidence?.advancedCapabilities);
    const report = {
      schemaVersion: 1,
      kind: "freesek-acp-external-interop",
      client: args.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      accepted,
      freesekVersion: String(rootPackage.version),
      gitCommit,
      agentBuildKind: build.kind ?? "unknown",
      evidence: evidence ?? null,
      stdoutTail: stdout.slice(-4000),
      stderrTail: stderr.slice(-4000),
    };
    if (args.output) writeFileSync(resolve(args.output), JSON.stringify(report, null, 2) + "\n", "utf8");
    if (!accepted) throw new Error(`external ACP client evidence rejected for ${args.name}`);
  } finally {
    await provider.close().catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
