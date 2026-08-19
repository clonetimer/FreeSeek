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
