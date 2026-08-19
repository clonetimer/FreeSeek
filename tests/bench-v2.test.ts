import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  builtInRealBenchManifestPath,
  loadBenchSuite,
  privateBenchCaseId,
  runBenchSuite,
  type BenchSuiteManifest,
} from "../src/bench";
import { initPrivateHoldoutPack } from "../src/bench-private";
import { materializeBenchSource, validateBenchSource } from "../src/bench-source";
import { validateBenchFixtures } from "../src/bench-validate";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, shell: false, encoding: "utf8" });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  return String(result.stdout ?? "").trim();
}

function sse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end("data: [DONE]\n\n");
}

test("v2 git source 使用 immutable commit cache，gold 可验证且 offline 可重放", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-bench-git-v2-"));
  const repo = path.join(root, "repo");
  const pack = path.join(root, "pack");
  const cache = path.join(root, "cache");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(pack, "verifiers"), { recursive: true });
  try {
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "FreeSeek Test"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(repo, "value.txt"), "base\n", "utf8");
    git(repo, ["add", "value.txt"]); git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "value.txt"), "gold\n", "utf8");
    git(repo, ["commit", "-am", "gold"]);
    const gold = git(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(pack, "verifiers", "value.mjs"), [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const workspace = process.argv[2];",
      "assert.equal(fs.readFileSync(path.join(workspace, 'value.txt'), 'utf8'), 'gold\\n');",
      "console.log('ok');",
    ].join("\n"), "utf8");
    const manifest: BenchSuiteManifest = {
      version: 2, name: "git-v2", visibility: "public", cases: [{
        id: "pinned-git", source: { kind: "git", url: pathToFileURL(repo).toString(), commit: base, goldCommit: gold },
        prompt: "change base to gold", category: "core", difficulty: "easy",
        checks: [{ type: "host_node", script: "./verifiers/value.mjs" }],
      }],
    };
    const manifestPath = path.join(pack, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const suite = loadBenchSuite(manifestPath);
    const validation = validateBenchFixtures(suite, { cacheDir: cache }, true);
    assert.deepStrictEqual(validation.failures, []);
    assert.equal(validation.pristineChecks, 1);
    assert.equal(validation.goldChecks, 1);
    const materialized = materializeBenchSource(manifest.cases[0].source!, pack, { cacheDir: cache, offline: true });
    try {
      assert.equal(fs.readFileSync(path.join(materialized.workspace, "value.txt"), "utf8"), "base\n");
      assert.equal(materialized.commit, base);
    } finally { materialized.cleanup(); }
    fs.rmSync(repo, { recursive: true, force: true });
    assert.deepStrictEqual(validateBenchFixtures(suite, { cacheDir: cache, offline: true }, true).failures, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("benchmark source 拒绝 mutable ref、危险协议与 local traversal", () => {
  assert.throws(() => validateBenchSource({ kind: "git", url: "https://example.com/repo.git", commit: "main" }), /完整 immutable Git SHA/);
  assert.throws(() => validateBenchSource({ kind: "git", url: "ssh://example.com/repo.git", commit: "a".repeat(40) }), /仅允许 https:\/\/ 或 file:\/\//);
  assert.throws(() => validateBenchSource({ kind: "local", path: "../secret" }), /禁止 \.\./);
  assert.throws(() => validateBenchSource({ kind: "local", path: path.resolve("secret") }), /manifest 相对路径/);
});

test("private holdout report 默认匿名脱敏并删除 case trace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-private-holdout-"));
  const fixture = path.join(root, "fixtures", "secret-case");
  const verifierDir = path.join(root, "verifiers");
  const outDir = path.join(root, "out");
  fs.mkdirSync(fixture, { recursive: true }); fs.mkdirSync(verifierDir, { recursive: true });
  fs.writeFileSync(path.join(fixture, "seed.txt"), "private seed", "utf8");
  fs.writeFileSync(path.join(verifierDir, "secret.mjs"), [
    "import assert from 'node:assert/strict';", "import fs from 'node:fs';", "import path from 'node:path';",
    "assert.equal(fs.readFileSync(path.join(process.argv[2], 'result.txt'), 'utf8'), 'private-ok');", "console.log('private verifier output');",
  ].join("\n"), "utf8");
  const manifestPath = path.join(root, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 2, name: "secret-suite-name", visibility: "private", cases: [{
      id: "secret-case", source: { kind: "local", path: "./fixtures/secret-case" }, prompt: "SECRET PROMPT: create result.txt",
      category: "core", difficulty: "easy", tags: ["secret-tag"], allowNetwork: false,
      checks: [{ type: "host_node", script: "./verifiers/secret.mjs" }],
    }],
  }), "utf8");
  let request = 0;
  const server = http.createServer((_req, res) => {
    request++;
    if (request === 1) sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-private", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "private-ok" }) } }] }, finish_reason: "tool_calls" }] }]);
    else sse(res, [{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const suite = loadBenchSuite(manifestPath);
    const opaque = privateBenchCaseId(suite.fingerprint, "secret-case");
    const report = await runBenchSuite(suite, {
      baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test", model: "private-model", outDir,
      allowCommandChecks: true, keepPrivateTraces: false, io: { stdout: () => {}, stderr: () => {} },
    });
    assert.equal(report.cases[0].id, "secret-case", "内存结果仍供本地调用者使用真实 case id");
    const persisted = JSON.parse(fs.readFileSync(path.join(outDir, `bench-${report.runId}.json`), "utf8"));
    assert.equal(persisted.visibility, "private"); assert.equal(persisted.suite, "private-holdout");
    assert.equal(persisted.provider.baseUrl, "[redacted]");
    assert.equal(persisted.cases[0].id, opaque); assert.deepStrictEqual(persisted.cases[0].tags, []);
    assert.deepStrictEqual(persisted.cases[0].source, { kind: "local" });
    assert.equal(persisted.cases[0].attempts[0].eval.workspace, "[redacted]");
    assert.equal(persisted.cases[0].attempts[0].eval.sessionDir, "[redacted]");
    assert.equal(persisted.cases[0].attempts[0].eval.stdout, ""); assert.equal(persisted.cases[0].attempts[0].eval.stderr, "");
    assert.deepStrictEqual(persisted.cases[0].attempts[0].eval.checks, []);
    assert.doesNotMatch(JSON.stringify(persisted), /SECRET PROMPT|secret-tag|private verifier output|private seed/);
    const casesDir = path.join(outDir, "cases");
    assert.equal(fs.existsSync(casesDir) ? fs.readdirSync(casesDir).length : 0, 0, "private trace case 目录默认应清理");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("initPrivateHoldoutPack 生成仓库外 v2 private pack，verifier 与 workspace 分离", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-init-holdout-"));
  const target = path.join(root, "private-pack");
  try {
    initPrivateHoldoutPack(target);
    const suite = loadBenchSuite(path.join(target, "manifest.json"));
    assert.equal(suite.manifest.version, 2); assert.equal(suite.visibility, "private");
    const firstFingerprint = suite.fingerprint;
    fs.appendFileSync(path.join(target, "fixtures", "holdout-001", "README.md"), "secret fixture change\n");
    assert.notEqual(loadBenchSuite(path.join(target, "manifest.json")).fingerprint, firstFingerprint, "local fixture 内容必须进入 suite fingerprint");
    const row = suite.manifest.cases[0];
    assert.equal(row.source?.kind, "local");
    const verifier = row.checks?.find((check) => check.type === "host_node");
    assert.ok(verifier && verifier.type === "host_node");
    const fixture = materializeBenchSource(row.source!, target).workspace;
    const rel = path.relative(fixture, verifier.script);
    assert.equal(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel), true);
    const validation = validateBenchFixtures(loadBenchSuite(path.join(target, "manifest.json")), {}, true);
    assert.deepStrictEqual(validation.failures, [], "新建 holdout template 自身应满足 pristine-fail / gold-pass");
    assert.throws(() => initPrivateHoldoutPack(target), /拒绝覆盖/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("内置 real-v1 只保存 3 个固定 Git 历史任务，不在 load 时联网", () => {
  const suite = loadBenchSuite(builtInRealBenchManifestPath());
  assert.equal(suite.manifest.version, 2); assert.equal(suite.visibility, "public");
  assert.equal(suite.manifest.cases.length, 3); assert.match(suite.fingerprint, /^[a-f0-9]{64}$/);
  for (const row of suite.manifest.cases) {
    assert.equal(row.source?.kind, "git");
    if (row.source?.kind !== "git") continue;
    assert.match(row.source.url, /^https:\/\//); assert.match(row.source.commit, /^[a-f0-9]{40}$/i); assert.match(row.source.goldCommit ?? "", /^[a-f0-9]{40}$/i);
    assert.match(row.provenance?.repository ?? "", /^[^/]+\/[^/]+$/); assert.ok(row.provenance?.pullRequest);
  }
});
