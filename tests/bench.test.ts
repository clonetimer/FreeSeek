import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  builtInBenchManifestPath, compareBenchReports, filterBenchCases, loadBenchSuite, runBenchSuite, validateBuiltInFixtures,
  type BenchSuiteManifest,
} from "../src/bench";

function sse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end("data: [DONE]\n\n");
}

test("FreeSeek Bench v1 内置 suite 有稳定 fingerprint、20 个非平凡离线任务与类别覆盖", () => {
  const suite = loadBenchSuite(builtInBenchManifestPath());
  const suite2 = loadBenchSuite(builtInBenchManifestPath());
  assert.equal(suite.manifest.version, 1);
  assert.equal(suite.manifest.cases.length, 20);
  assert.equal(suite.fingerprint, suite2.fingerprint);
  assert.match(suite.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepStrictEqual(new Set(suite.manifest.cases.map((row) => row.category)), new Set(["core", "multifile", "context", "security"]));
  for (const row of suite.manifest.cases) {
    const proc = spawnSync("node", ["tests/run.js"], { cwd: row.workspace, shell: false, encoding: "utf8" });
    assert.notEqual(proc.status, 0, `${row.id} pristine fixture 必须至少失败一个 verifier`);
  }
});

test("内置 benchmark pristine 必须失败且 public gold overlays 能解开全部 20 个任务", () => {
  const result = validateBuiltInFixtures(loadBenchSuite(builtInBenchManifestPath()));
  assert.equal(result.cases, 20);
  assert.equal(result.pristineChecks, 20);
  assert.equal(result.goldChecks, 20);
  assert.deepStrictEqual(result.failures, []);
});

test("benchmark filter 对 case/category/tag 使用稳定 AND 语义", () => {
  const rows = loadBenchSuite(builtInBenchManifestPath()).manifest.cases;
  assert.equal(filterBenchCases(rows, { categories: ["security"] }).length, 2);
  assert.equal(filterBenchCases(rows, { tags: ["distractors"] }).length, 4);
  assert.deepStrictEqual(filterBenchCases(rows, { caseIds: ["context-auth-all-roles"], categories: ["context"], tags: ["auth"] }).map((x) => x.id), ["context-auth-all-roles"]);
  assert.equal(filterBenchCases(rows, { caseIds: ["context-auth-all-roles"], categories: ["security"] }).length, 0);
});

test("Bench runner 复用真实 Headless/Eval、重复运行、预算与 comparison", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-bench-suite-"));
  const workspace = path.join(root, "fixture");
  const outDir = path.join(root, "out");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "seed.txt"), "seed", "utf8");
  const manifest: BenchSuiteManifest = {
    version: 1,
    name: "bench-smoke",
    cases: [{
      id: "write-result",
      workspace: "./fixture",
      prompt: "创建 result.txt，内容为 bench-ok",
      category: "core",
      difficulty: "easy",
      tags: ["smoke"],
      weight: 2,
      allowNetwork: false,
      checks: [{ type: "file_exists", path: "result.txt" }, { type: "file_contains", path: "result.txt", text: "bench-ok" }],
      budget: { maxSteps: 5, maxToolCalls: 3, maxTokens: 100 },
    }],
  };
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    if (requests % 2 === 1) {
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${requests}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "bench-ok" }) } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]);
    } else {
      sse(res, [
        { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } },
      ]);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const loaded = loadBenchSuite(manifestPath);
    const report = await runBenchSuite(loaded, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test",
      model: "bench-model",
      outDir,
      repeat: 2,
      keepWorkspaces: false,
      io: { stdout: () => {}, stderr: () => {} },
    });
    assert.equal(report.summary.cases, 1);
    assert.equal(report.summary.attempts, 2);
    assert.equal(report.summary.weightedScore, 100);
    assert.equal(report.summary.strictPassed, 1);
    assert.equal(report.summary.totalTokens, 42);
    assert.equal(report.cases[0].budgetPassRate, 1);
    assert.equal(report.cases[0].attempts.every((row) => row.eval.pass), true);
    assert.equal(report.cases[0].attempts.every((row) => !fs.existsSync(row.eval.workspace)), true, "默认应清理复制工作区");
    assert.equal(fs.existsSync(path.join(outDir, `bench-${report.runId}.json`)), true);
    assert.match(fs.readFileSync(path.join(outDir, `bench-${report.runId}.md`), "utf8"), /Weighted score: \*\*100\.00/);
    const candidate = { ...report, runId: "candidate", summary: { ...report.summary, weightedScore: 50, strictPassed: 0, totalTokens: 30, steps: 2, toolCalls: 2, durationMs: 10 }, cases: [{ ...report.cases[0], successRate: 0.5, strictPass: false }] };
    const cmp = compareBenchReports(report, candidate);
    assert.equal(cmp.sameSuiteFingerprint, true);
    assert.equal(cmp.weightedScoreDelta, -50);
    assert.equal(cmp.sameSelection, true);
    assert.equal(cmp.sameRepeat, true);
    assert.equal(cmp.avgTokensPerAttemptDelta, -6);
    assert.deepStrictEqual(cmp.regressions.map((x) => x.id), ["write-result"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark loader 拒绝 workspace 根 symlink 逃逸 manifest 目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-bench-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-bench-outside-"));
  try {
    const link = path.join(root, "workspace");
    try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); } catch { return; }
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ version: 1, name: "bad", cases: [{ id: "escape", workspace: "./workspace", prompt: "x", category: "core", difficulty: "easy" }] }), "utf8");
    assert.throws(() => loadBenchSuite(path.join(root, "manifest.json")), /workspace 越界/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
