#!/usr/bin/env node
/**
 * Independent interoperability driver using the official ACP TypeScript SDK.
 * The protocol implementation is provided by @agentclientprotocol/sdk; this
 * file only adapts the FreeSeek evidence environment to that public client API.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function loadSdk() {
  try {
    return await import("@agentclientprotocol/sdk");
  } catch (error) {
    throw new Error(
      "@agentclientprotocol/sdk is not installed. Install the pinned interop client dependency before running this driver.",
      { cause: error },
    );
  }
}

function packageVersion(moduleUrl) {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 6; i++) {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "unknown";
    } catch {
      dir = dirname(dir);
    }
  }
  return "unknown";
}

async function main() {
  const sdk = await loadSdk();
  const command = required("FREESEEK_ACP_AGENT_COMMAND");
  const args = JSON.parse(required("FREESEEK_ACP_AGENT_ARGS_JSON"));
  const workspace = required("FREESEEK_ACP_WORKSPACE");
  const extra = mkdtempSync(join(tmpdir(), "freesek-acp-sdk-extra-"));
  const updates = [];

  const child = spawn(command, args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await spawned;

  const stream = sdk.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const connection = new sdk.ClientSideConnection(
    () => ({
      sessionUpdate(params) {
        updates.push(params);
        return Promise.resolve();
      },
      requestPermission() {
        return Promise.resolve({ outcome: { outcome: "cancelled" } });
      },
    }),
    stream,
  );

  let sessionId = "";
  let initialized = false;
  let newSession = false;
  let prompted = false;
  let resumed = false;
  try {
    const init = await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "freesek-official-sdk-interop", version: "1" },
    });
    initialized = init?.protocolVersion === 1;

    const created = await connection.newSession({
      cwd: workspace,
      mcpServers: [],
      additionalDirectories: [extra],
    });
    sessionId = created.sessionId;
    newSession = typeof sessionId === "string" && sessionId.length > 0;

    const prompt = await connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Return the external interoperability marker." }],
    });
    prompted = typeof prompt?.stopReason === "string";

    if (typeof connection.closeSession === "function" && typeof connection.resumeSession === "function") {
      await connection.closeSession({ sessionId });
      const resume = await connection.resumeSession({
        sessionId,
        cwd: workspace,
        mcpServers: [],
        additionalDirectories: [extra],
      });
      resumed = resume !== undefined;
    }

    const sdkUrl = await import.meta.resolve("@agentclientprotocol/sdk");
    process.stdout.write(JSON.stringify({
      freesekAcpInterop: 1,
      implementationOwner: "agentclientprotocol",
      implementationId: "typescript-sdk",
      clientVersion: packageVersion(sdkUrl),
      initialize: initialized,
      newSession,
      prompt: prompted,
      sessionUpdate: updates.length > 0,
      advancedCapabilities: ["additionalDirectories", ...(resumed ? ["resume"] : [])],
    }) + "\n");
  } finally {
    try { child.stdin.end(); } catch {}
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(extra, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
