import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

function locateCompiledAcp(): string {
  const candidates = [
    path.join(__dirname, "..", "src", "acp-server.js"),
    path.join(__dirname, "..", "..", "src", "acp-server.js"),
    path.join(process.cwd(), "src", "acp-server.js"),
    path.join(process.cwd(), "dist", "freeseek-acp.js"),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`找不到已编译的 ACP 入口：${candidates.join(", ")}`);
}

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function startProvider(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => sse(res, "OFFICIAL_ACP_SDK_OK"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const officialClientScript = String.raw`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [agentEntry, workspace, sessions, extra, providerUrl] = process.argv.slice(1);
const wrapper = "require(process.argv[1]).runAcpCli(process.argv.slice(2)).then(c=>process.exitCode=c,e=>{console.error(e);process.exitCode=1})";
const agent = spawn(process.execPath, [
  "-e", wrapper, agentEntry,
  "--base-url", providerUrl,
  "--model", "official-acp-sdk-test",
  "--auth-type", "none",
  "--session-dir", sessions,
  "--yes"
], { stdio: ["pipe", "pipe", "pipe"] });

let agentStderr = "";
agent.stderr.setEncoding("utf8");
agent.stderr.on("data", chunk => { agentStderr += String(chunk); });

const stream = acp.ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout));
const updates = [];
try {
  const report = await acp.client({ name: "freesek-official-sdk-interop", version: "2.6.0" })
    .onNotification(acp.methods.client.session.update, context => { updates.push(context.params); })
    .connectWith(stream, async context => {
      const initialized = await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}
      });
      assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
      assert.equal(initialized.agentCapabilities.loadSession, true);
      assert.ok(initialized.agentCapabilities.sessionCapabilities.additionalDirectories);

      const created = await context.request(acp.methods.agent.session.new, {
        cwd: workspace,
        additionalDirectories: [extra],
        mcpServers: []
      });
      const sessionId = created.sessionId;
      assert.ok(sessionId.startsWith("acp-"));

      const prompt = await context.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Return the exact marker from the connected model." }]
      });
      assert.equal(prompt.stopReason, "end_turn");

      const listed = await context.request(acp.methods.agent.session.list, { cwd: workspace });
      assert.ok(listed.sessions.some(row => row.sessionId === sessionId));

      await context.request(acp.methods.agent.session.close, { sessionId });
      const resumed = await context.request(acp.methods.agent.session.resume, {
        sessionId, cwd: workspace, additionalDirectories: [extra], mcpServers: []
      });
      assert.ok(resumed.modes);

      await context.request(acp.methods.agent.session.close, { sessionId });
      const loaded = await context.request(acp.methods.agent.session.load, {
        sessionId, cwd: workspace, additionalDirectories: [extra], mcpServers: []
      });
      assert.ok(loaded.modes);
      await context.request(acp.methods.agent.session.close, { sessionId });

      return { sessionId, stopReason: prompt.stopReason, listedCount: listed.sessions.length };
    });

  const messageText = updates
    .map(row => row?.update?.content?.text ?? "")
    .join("\n");
  assert.match(messageText, /OFFICIAL_ACP_SDK_OK/);
  assert.ok(updates.some(row => row?.update?.sessionUpdate === "user_message_chunk"));
  console.log(JSON.stringify({ ok: true, ...report, updateCount: updates.length }));
} catch (error) {
  console.error(error);
  console.error(agentStderr);
  process.exitCode = 1;
} finally {
  agent.stdin.end();
  await new Promise(resolve => {
    if (agent.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { agent.kill("SIGKILL"); resolve(); }, 5000);
    agent.once("close", () => { clearTimeout(timer); resolve(); });
  });
}
`;

test("ACP v1 interoperates with the official TypeScript SDK client", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-sdk-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-sdk-sessions-"));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-sdk-extra-"));
  const provider = await startProvider();
  const agentEntry = locateCompiledAcp();
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    officialClientScript,
    agentEntry,
    workspace,
    sessions,
    extra,
    provider.url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Official ACP SDK client timed out. stdout=${stdout} stderr=${stderr}`));
      }, 60_000);
      child.once("close", code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, stderr);
    const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(report.ok, true);
    assert.equal(report.stopReason, "end_turn");
    assert.ok(report.updateCount >= 2);
    assert.ok(fs.existsSync(path.join(sessions, `events-${report.sessionId}.jsonl`)));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>(resolve => provider.server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  }
});
