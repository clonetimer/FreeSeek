import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { AcpAgentServer } from "../src/hosts/acp/server";
import { NdJsonRpcPeer } from "../src/hosts/acp/protocol";
import { configureStandaloneProvider } from "../src/hosts/standalone-provider";
import { readSessionEvents } from "../src/eventlog";
import { probeLinuxExtensionSandbox } from "../src/kernel/extensions/sandbox-supervisor";

/** H4 untrusted sandbox 仅 Linux（需 Node>=22 + namespace/chroot）；其他平台 fail-closed。 */
const H4 = probeLinuxExtensionSandbox();

function sse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "close",
  });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function peerPair(): { server: NdJsonRpcPeer; client: NdJsonRpcPeer } {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  return {
    server: new NdJsonRpcPeer(clientToServer, serverToClient),
    client: new NdJsonRpcPeer(serverToClient, clientToServer),
  };
}

function configureMockProvider(port: number): void {
  configureStandaloneProvider({
    id: "acp-test",
    name: "ACP test",
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: "",
    model: "test-model",
    format: "openai",
    toolMode: "native",
    authType: "none",
  });
}

test("ACP v1 stdio host supports initialize/new/prompt/list/close/resume over the shared kernel", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-sessions-"));
  let requests = 0;
  const provider = http.createServer((_req, res) => {
    requests++;
    sse(res, [{ choices: [{ delta: { content: requests === 1 ? "FIRST_OK" : "RESUME_OK" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  const pair = peerPair();
  const updates: any[] = [];
  pair.client.start((method, params) => {
    if (method === "session/update") { updates.push(params); return {}; }
    throw new Error(`unexpected client-side method: ${method}`);
  });
  const server = new AcpAgentServer(pair.server, {
    sessionDir: sessions,
    agentVersion: "test",
    autoApprove: true,
  });
  server.start();

  try {
    const initialized = await pair.client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test-client", version: "1" },
    }) as any;
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentCapabilities.loadSession, true);
    assert.equal(initialized.agentCapabilities.sessionCapabilities.resume != null, true);
    assert.equal(initialized.agentCapabilities.sessionCapabilities.list != null, true);
    assert.equal(initialized.agentCapabilities.sessionCapabilities.close != null, true);

    const created = await pair.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
    assert.match(created.sessionId, /^acp-/);
    const sessionId = created.sessionId as string;

    const first = await pair.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "first turn" }],
    }) as any;
    assert.equal(first.stopReason, "end_turn");
    assert.ok(updates.some((row) => row?.update?.sessionUpdate === "agent_message_chunk" && row?.update?.content?.text === "FIRST_OK"));

    const listed = await pair.client.request("session/list", { cwd: root }) as any;
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].sessionId, sessionId);
    assert.equal(listed.sessions[0].cwd, fs.realpathSync(root));
    assert.equal(listed.sessions[0].title, "first turn");
    await assert.rejects(
      () => pair.client.request("session/list", { cwd: root, cursor: "not-a-valid-cursor" }),
      (error: any) => error?.code === -32602 && /invalid ACP session cursor/.test(String(error?.message))
    );

    await pair.client.request("session/close", { sessionId });
    await assert.rejects(
      () => pair.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "must resume" }] }),
      /not active; call session\/resume first/
    );

    await pair.client.request("session/resume", { sessionId, cwd: root, mcpServers: [] });
    const resumed = await pair.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "resource_link", uri: "file:///README.md", name: "README" }, { type: "text", text: "resume turn" }],
    }) as any;
    assert.equal(resumed.stopReason, "end_turn");
    assert.equal(requests, 2);

    await pair.client.request("session/close", { sessionId });
    const beforeLoad = updates.length;
    await pair.client.request("session/load", { sessionId, cwd: root, mcpServers: [] });
    const replay = updates.slice(beforeLoad).map((row: any) => row?.update);
    assert.ok(replay.some((row: any) => row?.sessionUpdate === "user_message_chunk" && row?.content?.text === "first turn"));
    assert.ok(replay.some((row: any) => row?.sessionUpdate === "agent_message_chunk" && row?.content?.text === "FIRST_OK"));
    assert.equal(requests, 2, "session/load must replay EventLog without calling the provider");

    const events = readSessionEvents(sessions, sessionId);
    assert.equal(events.filter((event) => event.type === "turn/start").length, 2);
    assert.equal(events.filter((event) => event.type === "turn/end").length, 2);
    assert.ok(events.some((event) => event.type === "session_title"));
    assert.ok(events.some((event) => event.type === "assistant/message"));
  } finally {
    await server.close("test-end");
    pair.client.close("test-end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("ACP session owns MCP runtime, requests permission through the client, and never persists MCP secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-mcp-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-mcp-sessions-"));
  const mcpScript = path.join(root, "mock-mcp.cjs");
  fs.writeFileSync(mcpScript, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } });
  if (msg.method === "tools/list") return send(msg.id, { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
  if (msg.method === "resources/list") return send(msg.id, { resources: [] });
  if (msg.method === "prompts/list") return send(msg.id, { prompts: [] });
  if (msg.method === "tools/call") return send(msg.id, { content: [{ type: "text", text: "ACP_MCP_OK:" + String(msg.params?.arguments?.text ?? "") }] });
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } }) + "\\n");
});
`);

  let providerRequests = 0;
  const provider = http.createServer((_req, res) => {
    providerRequests++;
    if (providerRequests === 1) {
      sse(res, [{ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call_acp_mcp",
        type: "function",
        function: { name: "mcp__demo__echo", arguments: JSON.stringify({ text: "runtime" }) },
      }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "MCP_DONE" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  const pair = peerPair();
  const permissions: any[] = [];
  const updates: any[] = [];
  pair.client.start((method, params) => {
    if (method === "session/update") { updates.push(params); return {}; }
    if (method === "session/request_permission") {
      permissions.push(params);
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    }
    throw new Error(`unexpected client-side method: ${method}`);
  });
  const server = new AcpAgentServer(pair.server, {
    sessionDir: sessions,
    agentVersion: "test",
  });
  server.start();

  const acpMcp = [{
    name: "demo",
    command: path.basename(process.execPath),
    args: [mcpScript],
    env: [{ name: "TOP_SECRET_FOR_TEST", value: "do-not-persist" }],
  }];

  try {
    await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await pair.client.request("session/new", { cwd: root, mcpServers: acpMcp }) as any;
    const sessionId = created.sessionId as string;
    const result = await pair.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "call MCP echo" }],
    }) as any;
    assert.equal(result.stopReason, "end_turn");
    assert.equal(providerRequests, 2);
    assert.ok(permissions.length >= 1, "MCP external access must be approved through the ACP client");
    assert.ok(permissions.every((row) => row.sessionId === sessionId));
    assert.ok(permissions.some((row) => row.toolCall?.toolCallId === "call_acp_mcp"));
    assert.ok(updates.some((row) => row?.update?.sessionUpdate === "tool_call" && row?.update?.title === "mcp__demo__echo"));
    assert.ok(updates.some((row) => row?.update?.sessionUpdate === "tool_call_update" && String(row?.update?.rawOutput).includes("ACP_MCP_OK:runtime")));

    const events = readSessionEvents(sessions, sessionId);
    const toolResult = events.find((event) => event.type === "tool/result" && (event.data as any)?.name === "mcp__demo__echo");
    assert.match(String((toolResult?.data as any)?.result ?? ""), /ACP_MCP_OK:runtime/);

    const metadataFile = path.join(sessions, "acp-sessions", `${sessionId}.json`);
    const metadataText = fs.readFileSync(metadataFile, "utf8");
    assert.match(metadataText, /"mcpServerNames"/);
    assert.match(metadataText, /"demo"/);
    assert.doesNotMatch(metadataText, /TOP_SECRET_FOR_TEST|do-not-persist|mock-mcp\.cjs/);

    await pair.client.request("session/close", { sessionId });
    await assert.rejects(
      () => pair.client.request("session/resume", { sessionId, cwd: root }),
      /must re-supply mcpServers/
    );
    await assert.rejects(
      () => pair.client.request("session/resume", { sessionId, cwd: root, mcpServers: [] }),
      /must match the original server names/
    );
    await pair.client.request("session/resume", { sessionId, cwd: root, mcpServers: acpMcp });
  } finally {
    await server.close("test-end");
    pair.client.close("test-end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("ACP session/cancel aborts an in-flight provider turn and returns stopReason=cancelled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-cancel-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-cancel-sessions-"));
  let providerArrived!: () => void;
  const arrived = new Promise<void>((resolve) => { providerArrived = resolve; });
  const provider = http.createServer((req, res) => {
    providerArrived();
    req.on("close", () => res.destroy());
    // Deliberately never answer: the ACP cancel signal must abort the fetch/turn.
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  const pair = peerPair();
  pair.client.start((method) => {
    if (method === "session/update") return {};
    throw new Error(`unexpected client-side method: ${method}`);
  });
  const server = new AcpAgentServer(pair.server, { sessionDir: sessions, agentVersion: "test", autoApprove: true });
  server.start();

  try {
    await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await pair.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
    const prompt = pair.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "wait for cancellation" }],
    }) as Promise<any>;
    await arrived;
    pair.client.notify("session/cancel", { sessionId });
    const result = await Promise.race([
      prompt,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancel did not finish within 3s")), 3000)),
    ]);
    assert.equal(result.stopReason, "cancelled");
  } finally {
    await server.close("test-end");
    pair.client.close("test-end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("ACP form elicitation is capability-gated and bridges ask_user through elicitation/create", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-elicit-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-elicit-sessions-"));
  const seenToolSets: string[][] = [];
  let providerRequests = 0;
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as any;
      seenToolSets.push((parsed.tools ?? []).map((tool: any) => tool?.function?.name).filter(Boolean));
      providerRequests++;
      if (providerRequests === 1) {
        sse(res, [{ choices: [{ delta: { content: "NO_ELICITATION" }, finish_reason: "stop" }] }]);
        return;
      }
      if (providerRequests === 2) {
        sse(res, [{ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call_ask_user",
          type: "function",
          function: {
            name: "ask_user",
            arguments: JSON.stringify({
              question: "Choose deployment mode",
              options: [
                { label: "safe", description: "Require approvals" },
                { label: "fast", description: "Move quickly" },
              ],
            }),
          },
        }] }, finish_reason: "tool_calls" }] }]);
        return;
      }
      sse(res, [{ choices: [{ delta: { content: "ELICIT_DONE" }, finish_reason: "stop" }] }]);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  const pair = peerPair();
  const elicitationRequests: any[] = [];
  pair.client.start((method, params) => {
    if (method === "session/update") return {};
    if (method === "elicitation/create") {
      elicitationRequests.push(params);
      return { action: "accept", content: { value: "safe" } };
    }
    throw new Error(`unexpected client-side method: ${method}`);
  });
  const server = new AcpAgentServer(pair.server, { sessionDir: sessions, agentVersion: "test", autoApprove: true });
  server.start();

  try {
    await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const first = await pair.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
    await pair.client.request("session/prompt", { sessionId: first.sessionId, prompt: [{ type: "text", text: "no elicitation" }] });
    assert.equal(seenToolSets[0]?.includes("ask_user"), false, "ask_user must not be advertised without negotiated form elicitation");
    await pair.client.request("session/close", { sessionId: first.sessionId });

    // Capability negotiation happens per ACP connection. Reinitialize a fresh server/connection.
    await server.close("reinitialize-with-elicitation");
    pair.client.close("reinitialize-with-elicitation");

    const pair2 = peerPair();
    pair2.client.start((method, params) => {
      if (method === "session/update") return {};
      if (method === "elicitation/create") {
        elicitationRequests.push(params);
        return { action: "accept", content: { value: "safe" } };
      }
      throw new Error(`unexpected client-side method: ${method}`);
    });
    const server2 = new AcpAgentServer(pair2.server, { sessionDir: sessions, agentVersion: "test", autoApprove: true });
    server2.start();
    try {
      await pair2.client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
      const second = await pair2.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
      const result = await pair2.client.request("session/prompt", {
        sessionId: second.sessionId,
        prompt: [{ type: "text", text: "ask me" }],
      }) as any;
      assert.equal(result.stopReason, "end_turn");
      assert.equal(seenToolSets[1]?.includes("ask_user"), true, "ask_user must be advertised after form elicitation negotiation");
      assert.equal(elicitationRequests.length, 1);
      const elicitation = elicitationRequests[0];
      assert.equal(elicitation.sessionId, second.sessionId);
      assert.equal(elicitation.mode, "form");
      assert.match(elicitation.message, /Choose deployment mode/);
      assert.deepEqual(elicitation.requestedSchema?.properties?.value?.enum, ["safe", "fast"]);
      assert.ok(elicitation.requestedSchema?.required?.includes("value"));
    } finally {
      await server2.close("test-end");
      pair2.client.close("test-end");
    }
  } finally {
    // server/pair may already be closed above; close is intentionally idempotent at the transport boundary.
    try { await server.close("test-end"); } catch { /* already closed */ }
    try { pair.client.close("test-end"); } catch { /* already closed */ }
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("ACP additionalDirectories are durable, scoped, and immutable across resume", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-roots-primary-"));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-roots-extra-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-roots-other-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-roots-sessions-"));
  const extraFile = path.join(extra, "shared.txt");
  fs.writeFileSync(extraFile, "EXTRA_ROOT_OK\n", "utf8");
  let providerRequests = 0;
  const provider = http.createServer((_req, res) => {
    providerRequests++;
    if (providerRequests === 1) {
      sse(res, [{ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call_read_extra",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: extraFile }) },
      }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "ROOTS_DONE" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  const pair = peerPair();
  const updates: any[] = [];
  pair.client.start((method, params) => {
    if (method === "session/update") { updates.push(params); return {}; }
    throw new Error(`unexpected client-side method: ${method}`);
  });
  const server = new AcpAgentServer(pair.server, { sessionDir: sessions, agentVersion: "test", autoApprove: true });
  server.start();

  try {
    const initialized = await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }) as any;
    assert.ok(initialized.agentCapabilities.sessionCapabilities.additionalDirectories != null);
    const created = await pair.client.request("session/new", {
      cwd: root,
      additionalDirectories: [extra, extra],
      mcpServers: [],
    }) as any;
    assert.equal(created.modes.currentModeId, "coder");
    const sessionId = created.sessionId as string;
    const result = await pair.client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "read shared root" }],
    }) as any;
    assert.equal(result.stopReason, "end_turn");
    assert.ok(updates.some((row) => row?.update?.sessionUpdate === "tool_call_update" && String(row?.update?.rawOutput).includes("EXTRA_ROOT_OK")));

    const listed = await pair.client.request("session/list", { cwd: root }) as any;
    assert.deepEqual(listed.sessions[0].additionalDirectories, [fs.realpathSync(extra)]);
    const metadata = JSON.parse(fs.readFileSync(path.join(sessions, "acp-sessions", `${sessionId}.json`), "utf8"));
    assert.deepEqual(metadata.additionalDirectories, [fs.realpathSync(extra)]);

    await pair.client.request("session/set_mode", { sessionId, modeId: "plan" });
    assert.ok(updates.some((row) => row?.update?.sessionUpdate === "current_mode_update" && row?.update?.currentModeId === "plan"));
    await pair.client.request("session/close", { sessionId });
    await assert.rejects(
      () => pair.client.request("session/resume", { sessionId, cwd: root, mcpServers: [] }),
      /must re-supply the same authorized roots/
    );
    await assert.rejects(
      () => pair.client.request("session/resume", { sessionId, cwd: root, additionalDirectories: [other], mcpServers: [] }),
      /must match the original roots/
    );
    const resumed = await pair.client.request("session/resume", {
      sessionId,
      cwd: root,
      additionalDirectories: [extra],
      mcpServers: [],
    }) as any;
    assert.equal(resumed.modes.currentModeId, "plan");
  } finally {
    await server.close("test-end");
    pair.client.close("test-end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("ACP skills and multi-agent tools follow explicit host launch policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-policy-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-policy-sessions-"));
  const toolSets: string[][] = [];
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as any;
      toolSets.push((parsed.tools ?? []).map((tool: any) => tool?.function?.name).filter(Boolean));
      sse(res, [{ choices: [{ delta: { content: "POLICY_OK" }, finish_reason: "stop" }] }]);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  async function runPolicy(options: { enableSkills: boolean; enableMultiAgent: boolean }): Promise<void> {
    const pair = peerPair();
    pair.client.start((method) => {
      if (method === "session/update") return {};
      throw new Error(`unexpected client-side method: ${method}`);
    });
    const server = new AcpAgentServer(pair.server, {
      sessionDir: sessions,
      agentVersion: "test",
      autoApprove: true,
      enableSkills: options.enableSkills,
      enableMultiAgent: options.enableMultiAgent,
    });
    server.start();
    try {
      await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await pair.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
      await pair.client.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "inspect policy" }] });
    } finally {
      await server.close("policy-end");
      pair.client.close("policy-end");
    }
  }

  try {
    await runPolicy({ enableSkills: false, enableMultiAgent: false });
    await runPolicy({ enableSkills: true, enableMultiAgent: true });
    assert.equal(toolSets[0]?.includes("load_skill"), false);
    assert.equal(toolSets[0]?.includes("spawn_agent"), false);
    assert.equal(toolSets[0]?.includes("spawn_agents"), false);
    assert.equal(toolSets[0]?.includes("send_message"), false);
    assert.equal(toolSets[1]?.includes("load_skill"), true);
    assert.equal(toolSets[1]?.includes("spawn_agent"), true);
    assert.equal(toolSets[1]?.includes("spawn_agents"), true);
    assert.equal(toolSets[1]?.includes("send_message"), true);
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("ACP General HMR exposes trusted extension tools and switches generation only on a later turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-hmr-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-hmr-sessions-"));
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-hmr-ext-"));
  const packageDir = path.join(extensions, "demo");
  fs.mkdirSync(packageDir);
  const writeExtension = (version: string, result: string) => {
    fs.writeFileSync(path.join(packageDir, "freeseek-extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "demo.tools",
      version,
      trust: "trusted",
      capabilities: { tools: true },
      entry: "index.cjs",
    }));
    fs.writeFileSync(path.join(packageDir, "index.cjs"), `module.exports = function(ctx) {
      ctx.registerTool({ name: "echo", description: "HMR echo", parameters: { type: "object" },
        runtime: { effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto" },
        execute: async () => ${JSON.stringify(result)} });
    };\n`);
  };
  writeExtension("1.0.0", "HMR_V1");

  let request = 0;
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as any;
      request++;
      if (request === 1 || request === 3) {
        const names = (parsed.tools ?? []).map((tool: any) => tool?.function?.name);
        assert.ok(names.includes("ext__demo_tools__echo"));
        sse(res, [{ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: `call_hmr_${request}`,
          type: "function",
          function: { name: "ext__demo_tools__echo", arguments: "{}" },
        }] }, finish_reason: "tool_calls" }] }]);
        return;
      }
      const toolMessage = [...(parsed.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
      assert.match(String(toolMessage?.content ?? ""), request === 2 ? /HMR_V1/ : /HMR_V2/);
      sse(res, [{ choices: [{ delta: { content: request === 2 ? "TURN1_OK" : "TURN2_OK" }, finish_reason: "stop" }] }]);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  const pair = peerPair();
  pair.client.start((method) => {
    if (method === "session/update") return {};
    throw new Error(`unexpected client-side method: ${method}`);
  });
  const server = new AcpAgentServer(pair.server, {
    sessionDir: sessions,
    agentVersion: "test",
    autoApprove: true,
    extensionDirs: [extensions],
  });
  server.start();
  try {
    await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await pair.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
    await pair.client.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "hmr v1" }] });
    writeExtension("1.1.0", "HMR_V2");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await pair.client.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "hmr v2" }] });
    assert.equal(request, 4);
  } finally {
    await server.close("hmr-test-end");
    pair.client.close("hmr-test-end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.rmSync(extensions, { recursive: true, force: true });
  }
});

test("ACP H4 projects an untrusted sandbox tool through the normal Agent ToolRegistry", { skip: !H4.ok && H4.reason }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h4-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h4-sessions-"));
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h4-ext-"));
  const packageDir = path.join(extensions, "demo"); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.untrusted", version: "1.0.0", trust: "untrusted",
    capabilities: { tools: true, filesystem: "none" }, entry: "index.cjs",
  }));
  fs.writeFileSync(path.join(packageDir, "index.cjs"), `module.exports = function(ctx) {
    ctx.registerTool({ name: "echo", description: "sandbox echo", parameters: { type: "object" },
      runtime: { effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto", timeoutMs: 1500 },
      execute: async () => "H4_SANDBOX_OK:" + process.pid });
  };\n`);

  let request = 0;
  const provider = http.createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as any; request++;
      if (request === 1) {
        const names = (parsed.tools ?? []).map((tool: any) => tool?.function?.name);
        assert.ok(names.includes("ext__demo_untrusted__echo"));
        sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_h4", type: "function",
          function: { name: "ext__demo_untrusted__echo", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }]);
        return;
      }
      const toolMessage = [...(parsed.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
      assert.match(String(toolMessage?.content ?? ""), /H4_SANDBOX_OK/);
      sse(res, [{ choices: [{ delta: { content: "H4_DONE" }, finish_reason: "stop" }] }]);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); assert.ok(address && typeof address === "object"); configureMockProvider(address.port);

  const pair = peerPair(); pair.client.start((method) => method === "session/update" ? {} : Promise.reject(new Error(`unexpected client method ${method}`)));
  const server = new AcpAgentServer(pair.server, { sessionDir: sessions, agentVersion: "test", autoApprove: true, extensionDirs: [extensions] });
  server.start();
  try {
    await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const listed = await pair.client.request("freesek/extensions/list", {}) as any;
    const managed = listed.extensions.find((row: any) => row.id === "demo.untrusted");
    assert.equal(managed?.runtime?.sandbox?.state, "running");
    const created = await pair.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
    const completed = await pair.client.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "use sandbox" }] }) as any;
    assert.equal(completed.stopReason, "end_turn"); assert.equal(request, 2);
  } finally {
    await server.close("h4-test-end"); pair.client.close("h4-test-end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(sessions, { recursive: true, force: true }); fs.rmSync(extensions, { recursive: true, force: true });
  }
});

test("ACP H2 mounts declarative skills and enforces generation policy inside ToolRuntime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h2-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h2-sessions-"));
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h2-ext-"));
  const packageDir = path.join(extensions, "demo");
  const skillDir = path.join(packageDir, "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: h2-skill\ndescription: H2 test\n---\n# H2_SKILL_OK\n");
  fs.writeFileSync(path.join(packageDir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "demo.h2",
    version: "1.0.0",
    trust: "trusted",
    capabilities: { skills: true, hooks: true },
    contributions: { skillRoots: ["skills"] },
    entry: "index.cjs",
  }));
  fs.writeFileSync(path.join(packageDir, "index.cjs"), `module.exports = function(ctx) {
    ctx.registerPolicy({ name: "blockread", evaluate: async (toolName) =>
      toolName === "read_file" ? { blocked: "H2_POLICY_BLOCK" } : {} });
  };\n`);
  fs.writeFileSync(path.join(root, "blocked.txt"), "SHOULD_NOT_BE_READ");

  let request = 0;
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as any;
      request++;
      if (request === 1) {
        assert.ok((parsed.tools ?? []).some((tool: any) => tool?.function?.name === "load_skill"));
        sse(res, [{ choices: [{ delta: { tool_calls: [{
          index: 0, id: "call_h2_skill", type: "function",
          function: { name: "load_skill", arguments: JSON.stringify({ name: "h2-skill" }) },
        }] }, finish_reason: "tool_calls" }] }]);
        return;
      }
      if (request === 2) {
        const toolMessage = [...(parsed.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
        assert.match(String(toolMessage?.content ?? ""), /H2_SKILL_OK/);
        sse(res, [{ choices: [{ delta: { content: "SKILL_DONE" }, finish_reason: "stop" }] }]);
        return;
      }
      if (request === 3) {
        sse(res, [{ choices: [{ delta: { tool_calls: [{
          index: 0, id: "call_h2_policy", type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "blocked.txt" }) },
        }] }, finish_reason: "tool_calls" }] }]);
        return;
      }
      const toolMessage = [...(parsed.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
      assert.match(String(toolMessage?.content ?? ""), /H2_POLICY_BLOCK/);
      assert.doesNotMatch(String(toolMessage?.content ?? ""), /SHOULD_NOT_BE_READ/);
      sse(res, [{ choices: [{ delta: { content: "POLICY_DONE" }, finish_reason: "stop" }] }]);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  configureMockProvider(address.port);

  const pair = peerPair();
  pair.client.start((method) => {
    if (method === "session/update") return {};
    throw new Error(`unexpected client-side method: ${method}`);
  });
  const server = new AcpAgentServer(pair.server, {
    sessionDir: sessions,
    agentVersion: "test",
    autoApprove: true,
    extensionDirs: [extensions],
  });
  server.start();
  try {
    await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await pair.client.request("session/new", { cwd: root, mcpServers: [] }) as any;
    await pair.client.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "load h2 skill" }] });
    await pair.client.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "read blocked file" }] });
    assert.equal(request, 4);
  } finally {
    await server.close("h2-test-end");
    pair.client.close("h2-test-end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.rmSync(extensions, { recursive: true, force: true });
  }
});

test("ACP H3 exposes FreeSeek-namespaced Extension management without changing ACP v1 session methods", async () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h3-sessions-"));
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-acp-h3-ext-"));
  const packageDir = path.join(extensions, "demo"); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.tools", version: "1.0.0", trust: "trusted",
    capabilities: { tools: true }, entry: "index.cjs",
  }));
  fs.writeFileSync(path.join(packageDir, "index.cjs"), `module.exports = function(ctx) {
    ctx.registerTool({ name: "echo", description: "echo", parameters: { type: "object" },
      runtime: { effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto" }, execute: async () => "H3" });
  };\n`);

  const pair = peerPair();
  pair.client.start((method) => { throw new Error(`unexpected client-side method: ${method}`); });
  const server = new AcpAgentServer(pair.server, { sessionDir: sessions, agentVersion: "test", extensionDirs: [extensions] });
  server.start();
  try {
    await pair.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const listed = await pair.client.request("freesek/extensions/list", {}) as any;
    assert.deepEqual(listed.trustRoots, [path.resolve(extensions)]);
    assert.equal(listed.extensions[0]?.id, "demo.tools");
    assert.equal(listed.extensions[0]?.health, "ok");

    const disabled = await pair.client.request("freesek/extensions/config", { id: "demo.tools", enabled: false }) as any;
    assert.equal(disabled.health, "disabled");
    assert.equal(fs.existsSync(packageDir), true, "H3 disable/remove must never delete package bytes");
    const disabledList = await pair.client.request("freesek/extensions/list", {}) as any;
    assert.equal(disabledList.extensions[0]?.enabled, false);

    const enabled = await pair.client.request("freesek/extensions/config", { id: "demo.tools", enabled: true }) as any;
    assert.equal(enabled.health, "ok");
    const before = enabled.runtime.activeGeneration;
    const reloaded = await pair.client.request("freesek/extensions/reload", { id: "demo.tools" }) as any;
    assert.ok(reloaded.runtime.activeGeneration > before);

    const audit = await pair.client.request("freesek/extensions/audit", { id: "demo.tools", limit: 100 }) as any;
    assert.ok(audit.events.some((row: any) => row.source === "management" && row.operation === "config"));
    assert.ok(audit.events.some((row: any) => row.source === "management" && row.operation === "reload"));
    await assert.rejects(
      () => pair.client.request("freesek/extensions/audit", { limit: 501 }),
      (error: any) => error?.code === -32602
    );
  } finally {
    await server.close("h3-management-test-end"); pair.client.close("h3-management-test-end");
    fs.rmSync(sessions, { recursive: true, force: true }); fs.rmSync(extensions, { recursive: true, force: true });
  }
});
