/**
 * Headless kernel 端到端烟测：不加载 VS Code，复用真实 Agent/Registry/Runtime/EventLog。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { runHeadless } from "../src/headless";
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

test("Headless 复用同一 Runtime：无认证本地 Provider 也可运行，并记录完整 turn/step/tool 生命周期", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-sessions-"));
  const sessionId = "headless-e2e";
  let requests = 0;

  const server = http.createServer((_req, res) => {
    requests++;
    if (requests === 1) {
      sse(res, [{
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_write_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "headless.txt", content: "ok" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }]);
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] }]);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const code = await runHeadless([
      "--prompt", "创建 headless.txt",
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--model", "test-model",
      "--auth-type", "none",
      "--workspace", root,
      "--session-dir", sessions,
      "--session-id", sessionId,
      "--yes",
    ]);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(path.join(root, "headless.txt"), "utf8"), "ok");
    assert.equal(requests, 2, "应完成一次工具轮和一次最终答复轮");

    const events = readSessionEvents(sessions, sessionId).filter((e) => e.actor === "main");
    const types = events.map((e) => e.type);
    assert.equal(types.filter((x) => x === "turn/start").length, 1);
    assert.equal(types.filter((x) => x === "turn/end").length, 1);
    assert.equal(types.filter((x) => x === "step/start").length, 2);
    assert.equal(types.filter((x) => x === "step/end").length, 2);
    assert.equal(types.filter((x) => x === "tool/call").length, 1);
    assert.equal(types.filter((x) => x === "tool/result").length, 1);
    const assistantToolEvent = events.find((e) => e.type === "assistant/message" && (e.data as any)?.message?.tool_calls);
    assert.equal((assistantToolEvent?.data as any).message.tool_calls[0].function.name, "write_file",
      "OpenAI 首个 tool name 分片不能被重复拼接并污染 durable replay");
    const startSeq = events.find((e) => e.type === "turn/start")!.seq;
    const endSeq = events.find((e) => e.type === "turn/end")!.seq;
    assert.ok(endSeq > startSeq, "turn/end 必须晚于 turn/start");

    // 在第一次写入后的 tool/result 边界做历史 fork：应物化到独立 workspace，且包含该时刻代码状态。
    const boundary = events.find((e) => e.type === "tool/result")!.seq;
    const forkId = "headless-e2e-fork";
    const forkCode = await runHeadless([
      "--prompt", "继续并给出一句总结",
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--api-key", "test-key",
      "--model", "test-model",
      "--session-dir", sessions,
      "--session-id", forkId,
      "--fork", sessionId,
      "--at", String(boundary),
      "--yes",
    ]);
    assert.equal(forkCode, 0);
    assert.equal(requests, 3, "fork 应额外完成一次模型请求");
    const forkWorkspace = path.join(sessions, "fork-workspaces", forkId);
    assert.equal(fs.readFileSync(path.join(forkWorkspace, "headless.txt"), "utf8"), "ok");
    assert.equal(fs.readFileSync(path.join(root, "headless.txt"), "utf8"), "ok", "fork 不得改源工作区");
    const forkEvents = readSessionEvents(sessions, forkId);
    const forkMeta = forkEvents.find((e) => e.type === "session/fork");
    assert.ok((forkMeta?.data as any)?.checkpointHash, "fork durable metadata 应记录 checkpoint anchor");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("Headless --context-planner v1 在首个模型请求前注入候选上下文并写 durable trace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-context-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-context-sessions-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "payment.ts"), "export function settlePayment(total:number) { return Math.round(total * 100) / 100; }\n");
  let requestBody = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk) => { requestBody += chunk; });
    req.on("end", () => sse(res, [{ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] }]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const code = await runHeadless([
      "--prompt", "检查 settlePayment 的金额舍入逻辑",
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--api-key", "test-key",
      "--model", "test-model",
      "--workspace", root,
      "--session-dir", sessions,
      "--session-id", "context-e2e",
      "--context-planner", "v1",
      "--context-plan-budget", "900",
    ], { stdout: () => {}, stderr: () => {} });
    assert.equal(code, 0);
    const body = JSON.parse(requestBody);
    const planner = body.messages.find((message: any) => message.role === "system" && String(message.content).includes("FreeSeek Context Planner v1"));
    assert.ok(planner, "首个 provider request 应带 planner system fragment");
    assert.match(planner.content, /src\/payment\.ts/);
    const events = readSessionEvents(sessions, "context-e2e");
    const planEvent = events.find((event) => event.type === "context/plan");
    assert.ok(planEvent);
    assert.equal((planEvent?.data as any).selectedFiles[0].path, "src/payment.ts");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("Headless --context-planner v1.1 传递 ranking 修正版并写 variant trace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-context-v11-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-context-v11-sessions-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "payment.ts"), "export function settlePayment(total:number) { return Math.round(total * 100) / 100; }\n");
  fs.writeFileSync(path.join(root, "tests", "payment.test.ts"), "// settlePayment production rounding test\n");
  let requestBody = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk) => { requestBody += chunk; });
    req.on("end", () => sse(res, [{ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] }]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const code = await runHeadless([
      "--prompt", "检查生产 settlePayment 的金额舍入逻辑，不要修改 tests",
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--api-key", "test-key",
      "--model", "test-model",
      "--workspace", root,
      "--session-dir", sessions,
      "--session-id", "context-v11-e2e",
      "--context-planner", "v1.1",
      "--context-plan-budget", "900",
    ], { stdout: () => {}, stderr: () => {} });
    assert.equal(code, 0);
    const body = JSON.parse(requestBody);
    const planner = body.messages.find((message: any) => message.role === "system" && String(message.content).includes("FreeSeek Context Planner v1.1"));
    assert.ok(planner);
    assert.match(planner.content, /src\/payment\.ts/);
    const events = readSessionEvents(sessions, "context-v11-e2e");
    const planEvent = events.find((event) => event.type === "context/plan");
    assert.equal((planEvent?.data as any)?.variant, "v1.1");
    assert.equal((planEvent?.data as any)?.selectedFiles?.[0]?.path, "src/payment.ts");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("Headless --enable-multi-agent uses the shared Agent kernel and records subagent lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-multi-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-multi-sessions-"));
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    if (requests === 1) {
      sse(res, [{ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call_spawn_1",
        type: "function",
        function: { name: "spawn_agent", arguments: JSON.stringify({ task: "inspect the workspace", role: "explore" }) },
      }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    if (requests === 2) {
      sse(res, [{ choices: [{ delta: { content: "SUBAGENT_OK" }, finish_reason: "stop" }] }]);
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "MAIN_OK" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const code = await runHeadless([
      "--prompt", "delegate one exploration task then summarize",
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--model", "test-model",
      "--auth-type", "none",
      "--workspace", root,
      "--session-dir", sessions,
      "--session-id", "multi-e2e",
      "--enable-multi-agent",
      "--yes",
    ], { stdout: () => {}, stderr: () => {} });
    assert.equal(code, 0);
    assert.equal(requests, 3, "main -> subagent -> main should produce three provider requests");
    const events = readSessionEvents(sessions, "multi-e2e");
    const sub = events.find((event) => event.type === "subagent");
    assert.ok(sub, "durable EventLog should record subagent dispatch");
    assert.equal((sub?.data as any)?.name, "explore");
    const toolResult = events.find((event) => event.type === "tool/result" && (event.data as any)?.name === "spawn_agent");
    assert.match(String((toolResult?.data as any)?.result ?? ""), /SUBAGENT_OK/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("Headless mounts MCP config into the shared ToolRegistry and executes approved dynamic tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-mcp-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-mcp-sessions-"));
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
  if (msg.method === "tools/call") return send(msg.id, { content: [{ type: "text", text: "MCP_OK:" + String(msg.params?.arguments?.text ?? "") }] });
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } }) + "\\n");
});
`);
  const mcpConfig = path.join(root, "mcp.json");
  fs.writeFileSync(mcpConfig, JSON.stringify([{ name: "demo", transport: "stdio", command: process.execPath, args: [mcpScript] }]));

  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    if (requests === 1) {
      sse(res, [{ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call_mcp_1",
        type: "function",
        function: { name: "mcp__demo__echo", arguments: JSON.stringify({ text: "runtime" }) },
      }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "MCP_MAIN_OK" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const code = await runHeadless([
      "--prompt", "call the MCP echo tool",
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--model", "test-model",
      "--auth-type", "none",
      "--workspace", root,
      "--session-dir", sessions,
      "--session-id", "mcp-e2e",
      "--mcp-config", mcpConfig,
      "--yes",
    ], { stdout: () => {}, stderr: () => {} });
    assert.equal(code, 0);
    assert.equal(requests, 2);
    const events = readSessionEvents(sessions, "mcp-e2e");
    const resultEvent = events.find((event) => event.type === "tool/result" && (event.data as any)?.name === "mcp__demo__echo");
    assert.match(String((resultEvent?.data as any)?.result ?? ""), /MCP_OK:runtime/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

test("Headless H3 management works without provider/prompt and persists operator disable intent", async () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-h3-sessions-"));
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-h3-ext-"));
  const packageDir = path.join(extensions, "demo"); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.tools", version: "1.0.0", trust: "trusted", capabilities: { tools: true }, entry: "index.cjs",
  }));
  fs.writeFileSync(path.join(packageDir, "index.cjs"), `module.exports = function(ctx) {
    ctx.registerTool({ name:"echo", description:"echo", parameters:{type:"object"}, runtime:{effect:"read",concurrency:"parallel",readOnlyAllowed:true,approval:"auto"}, execute:async()=>"ok" });
  };\n`);
  const run = async (op: string, id?: string) => {
    let stdout = "", stderr = "";
    const argv = ["--extension-dir", extensions, "--session-dir", sessions, "--extension-manage", op];
    if (id) argv.push("--extension-id", id);
    const code = await runHeadless(argv, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    return { code, stdout, stderr };
  };
  try {
    const listed = await run("list");
    assert.equal(listed.code, 0); assert.equal(listed.stderr, "");
    assert.equal(JSON.parse(listed.stdout).extensions[0].health, "ok");
    const disabled = await run("disable", "demo.tools");
    assert.equal(disabled.code, 0); assert.equal(JSON.parse(disabled.stdout).health, "disabled");
    assert.equal(fs.existsSync(packageDir), true);
    const restarted = await run("list");
    const row = JSON.parse(restarted.stdout).extensions[0];
    assert.equal(row.id, "demo.tools"); assert.equal(row.enabled, false); assert.equal(row.health, "disabled");
    const audit = await run("audit", "demo.tools");
    assert.ok(JSON.parse(audit.stdout).events.some((event: any) => event.source === "management" && event.operation === "config"));
  } finally {
    fs.rmSync(sessions, { recursive: true, force: true }); fs.rmSync(extensions, { recursive: true, force: true });
  }
});

test("Headless H4 accepts startup-only sandbox policy and reports a running untrusted worker", { skip: !H4.ok && H4.reason }, async () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-h4-sessions-"));
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-h4-ext-"));
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-headless-h4-data-"));
  const packageDir = path.join(extensions, "demo"); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.untrusted", version: "1.0.0", trust: "untrusted",
    capabilities: { tools: true, filesystem: "read" }, entry: "index.cjs",
  }));
  fs.writeFileSync(path.join(packageDir, "index.cjs"), `module.exports = function(ctx) {
    ctx.registerTool({ name:"echo", description:"echo", parameters:{}, runtime:{effect:"read",concurrency:"parallel",readOnlyAllowed:true,approval:"auto"}, execute:async()=>"ok" });
  };\n`);
  const policy = path.join(sessions, "sandbox-policy.json");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, grants: { "demo.untrusted": { filesystem: { read: [allowed] } } } }));
  let stdout = "", stderr = "";
  try {
    const code = await runHeadless([
      "--extension-dir", extensions,
      "--extension-sandbox-policy", policy,
      "--session-dir", sessions,
      "--extension-manage", "list",
    ], { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    assert.equal(code, 0, stderr);
    const row = JSON.parse(stdout).extensions.find((entry: any) => entry.id === "demo.untrusted");
    assert.equal(row?.health, "ok");
    assert.equal(row?.runtime?.sandbox?.state, "running");
    assert.match(String(row?.runtime?.sandbox?.isolation ?? ""), /net-chroot-node-permission-broker-v1/);
  } finally {
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.rmSync(extensions, { recursive: true, force: true });
    fs.rmSync(allowed, { recursive: true, force: true });
  }
});
