import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { compareEvalReports, runEvalManifest, type EvalManifest } from "../src/eval";

function sse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end("data: [DONE]\n\n");
}

test("Eval Harness 复制 workspace、运行真实 Headless、执行声明式 checks 并汇总 token/trace", async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-eval-source-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-eval-out-"));
  fs.writeFileSync(path.join(source, "seed.txt"), "seed", "utf8");
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    if (requests === 1) {
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "eval-ok" }) } }] }, finish_reason: "tool_calls" }] },
        // OpenAI include_usage 的最终 chunk 常见 choices=[]；必须仍被采集。
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]);
      return;
    }
    sse(res, [
      { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } },
    ]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const manifest: EvalManifest = {
      name: "smoke-suite",
      cases: [{
        id: "write-smoke",
        workspace: source,
        prompt: "创建 result.txt",
        checks: [
          { type: "file_exists", path: "result.txt" },
          { type: "file_contains", path: "result.txt", text: "eval-ok" },
          { type: "tool_called", name: "write_file", min: 1, max: 1 },
          { type: "event_count", eventType: "model/result", min: 2, max: 2 },
          { type: "turn_reason", reason: "completed" },
          { type: "command", argv: [process.execPath, "-e", "process.stdout.write('check-ok')"], stdoutIncludes: "check-ok" },
        ],
      }],
    };
    const report = await runEvalManifest(manifest, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      model: "test-model",
      outDir,
      allowCommandChecks: true,
      keepWorkspaces: true,
      io: { stdout: () => {}, stderr: () => {} },
    });
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.passed, 1);
    assert.equal(report.summary.totalTokens, 35);
    assert.equal(report.cases[0].trace.modelRequests, 2);
    assert.equal(report.cases[0].trace.toolCalls, 1);
    assert.equal(report.cases[0].checks.every((x) => x.pass), true);
    assert.equal(fs.readFileSync(path.join(report.cases[0].workspace, "result.txt"), "utf8"), "eval-ok");
    assert.equal(fs.readFileSync(path.join(source, "seed.txt"), "utf8"), "seed", "源 workspace 不应被 eval 修改");
    assert.equal(fs.existsSync(path.join(source, "result.txt")), false);
    assert.equal(fs.existsSync(path.join(outDir, `report-${report.runId}.json`)), true);

    const candidate = { ...report, runId: "candidate", summary: { ...report.summary, passRate: 1, passed: 1, durationMs: report.summary.durationMs - 10, totalTokens: 30, promptTokens: 26, completionTokens: 4, toolCalls: 1, steps: 2 } };
    const cmp = compareEvalReports(report, candidate);
    assert.equal(cmp.metrics.totalTokens, -5);
    assert.equal(cmp.metrics.durationMs, -10);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
