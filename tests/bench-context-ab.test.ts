import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { loadBenchSuite, type BenchSuiteManifest } from "../src/bench";
import { runContextPlannerAb } from "../src/bench-context-ab";

function sse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end("data: [DONE]\n\n");
}

test("Context Planner A/B 固定 off→v1，并对 private comparison case id 脱敏", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-ab-"));
  const workspace = path.join(root, "fixture");
  const outDir = path.join(root, "out");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "target.ts"), "export const answer = 41;\n", "utf8");
  const manifest: BenchSuiteManifest = {
    version: 1,
    name: "secret-context-suite",
    visibility: "private",
    cases: [{
      id: "secret-context-case",
      workspace: "./fixture",
      prompt: "修复 src/target.ts，并创建 result.txt，内容为 context-ok",
      category: "context",
      difficulty: "easy",
      allowNetwork: false,
      checks: [{ type: "file_contains", path: "result.txt", text: "context-ok" }],
    }],
  };
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasPlan = messages.some((row: any) => typeof row?.content === "string" && row.content.includes("freesek-context-plan:v1"));
    const hasToolResult = messages.some((row: any) => row?.role === "tool");
    if (!hasPlan) {
      sse(res, [{ choices: [{ delta: { content: "legacy search did not solve it" }, finish_reason: "stop" }] }]);
      return;
    }
    if (!hasToolResult) {
      sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "write1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "context-ok" }) } }] }, finish_reason: "tool_calls" }] }]);
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const suite = loadBenchSuite(manifestPath);
    const result = await runContextPlannerAb(suite, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test",
      model: "ab-model",
      outDir,
      repeat: 1,
      allowCommandChecks: false,
      contextPlanBudget: 1000,
      io: { stdout: () => {}, stderr: () => {} },
    });
    assert.equal(result.baseline.agent.contextPlanner, "off");
    assert.equal(result.candidate.agent.contextPlanner, "v1");
    assert.equal(result.baseline.summary.weightedScore, 0);
    assert.equal(result.candidate.summary.weightedScore, 100);
    assert.equal(result.comparison.weightedScoreDelta, 100);
    assert.deepStrictEqual(result.comparison.improvements.map((row) => row.id), ["secret-context-case"]);
    const persisted = fs.readFileSync(result.comparisonPath, "utf8");
    assert.doesNotMatch(persisted, /secret-context-case/);
    assert.match(persisted, /holdout-[a-f0-9]{12}/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Context Planner A/B 可显式比较 v1→v1.1", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-ab-v11-"));
  const workspace = path.join(root, "fixture");
  const outDir = path.join(root, "out");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "tests"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "target.ts"), "export const answer = 41;\n", "utf8");
  fs.writeFileSync(path.join(workspace, "tests", "target.test.ts"), "// answer target\n", "utf8");
  const manifest: BenchSuiteManifest = {
    version: 1,
    name: "planner-v11-suite",
    cases: [{
      id: "planner-v11-case",
      workspace: "./fixture",
      prompt: "修复生产 answer，不要修改 tests，并创建 result.txt 内容为 v11-ok",
      category: "context",
      difficulty: "easy",
      allowNetwork: false,
      checks: [{ type: "file_contains", path: "result.txt", text: "v11-ok" }],
    }],
  };
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasV11 = messages.some((row: any) => typeof row?.content === "string" && row.content.includes("freesek-context-plan:v1.1"));
    const hasToolResult = messages.some((row: any) => row?.role === "tool");
    if (!hasV11) return sse(res, [{ choices: [{ delta: { content: "v1 baseline" }, finish_reason: "stop" }] }]);
    if (!hasToolResult) return sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "write-v11", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "v11-ok" }) } }] }, finish_reason: "tool_calls" }] }]);
    return sse(res, [{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const suite = loadBenchSuite(manifestPath);
    const result = await runContextPlannerAb(suite, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test",
      model: "ab-model",
      outDir,
      repeat: 1,
      allowCommandChecks: false,
      contextPlanBudget: 1000,
      baselinePlanner: "v1",
      candidatePlanner: "v1.1",
      io: { stdout: () => {}, stderr: () => {} },
    });
    assert.equal(result.baseline.agent.contextPlanner, "v1");
    assert.equal(result.candidate.agent.contextPlanner, "v1.1");
    assert.equal(result.baseline.summary.weightedScore, 0);
    assert.equal(result.candidate.summary.weightedScore, 100);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("Context Presentation A/B 可比较 v1.1→v1.2，并把 post-plan search/read/mutation 纳入报告", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-ab-v12-"));
  const workspace = path.join(root, "fixture");
  const outDir = path.join(root, "out");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "target.ts"), "export const answer = 41;\n", "utf8");
  const manifest: BenchSuiteManifest = {
    version: 1,
    name: "planner-v12-presentation-suite",
    cases: [{
      id: "planner-v12-case",
      workspace: "./fixture",
      prompt: "修复生产 answer，并创建 result.txt 内容为 v12-ok",
      category: "context",
      difficulty: "easy",
      allowNetwork: false,
      checks: [{ type: "file_contains", path: "result.txt", text: "v12-ok" }],
    }],
  };
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasV12 = messages.some((row: any) => typeof row?.content === "string" && row.content.includes("freesek-context-plan:v1.2"));
    const toolMessages = messages.filter((row: any) => row?.role === "tool").map((row: any) => String(row.content ?? ""));
    const hasSearch = toolMessages.some((text: string) => text.includes('name="grep"'));
    const hasWrite = toolMessages.some((text: string) => text.includes('name="write_file"'));
    if (hasWrite) return sse(res, [{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
    if (!hasV12 && !hasSearch) {
      return sse(res, [{ choices: [{ delta: { tool_calls: [{
        index: 0, id: "search-v11", type: "function",
        function: { name: "grep", arguments: JSON.stringify({ pattern: "answer" }) },
      }] }, finish_reason: "tool_calls" }] }]);
    }
    return sse(res, [{ choices: [{ delta: { tool_calls: [{
      index: 0, id: hasV12 ? "write-v12" : "write-v11", type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "v12-ok" }) },
    }] }, finish_reason: "tool_calls" }] }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const suite = loadBenchSuite(manifestPath);
    const result = await runContextPlannerAb(suite, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test",
      model: "ab-model",
      outDir,
      repeat: 1,
      allowCommandChecks: false,
      contextPlanBudget: 1000,
      baselinePlanner: "v1.1",
      candidatePlanner: "v1.2",
      io: { stdout: () => {}, stderr: () => {} },
    });
    assert.equal(result.baseline.summary.weightedScore, 100);
    assert.equal(result.candidate.summary.weightedScore, 100);
    assert.equal(result.baseline.summary.contextExploratorySearchCalls, 1);
    assert.equal(result.candidate.summary.contextExploratorySearchCalls, 0);
    assert.equal(result.comparison.avgContextExploratorySearchCallsDelta, -1);
    assert.equal(result.comparison.avgToolCallsPerAttemptDelta, -1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
