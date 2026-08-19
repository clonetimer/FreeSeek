import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const script = path.resolve(process.cwd(), "scripts", "deepseek-context-ab.mjs");

test("DeepSeek A/B dry-run never prints the API key", () => {
  const secret = "sk-test-should-never-appear";
  const run = spawnSync(process.execPath, [script, "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DEEPSEEK_API_KEY: secret },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes(secret), false);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.baseUrl, "https://api.deepseek.com");
  assert.equal(plan.model, "deepseek-v4-flash");
  assert.equal(plan.baselinePlanner, "v1.1");
  assert.equal(plan.candidatePlanner, "v1.2");
  assert.equal(plan.apiKey, "<environment:configured>");
});

test("DeepSeek A/B wrapper intentionally rejects --api-key argv", () => {
  const run = spawnSync(process.execPath, [script, "--api-key", "sk-leak"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown option: --api-key/);
});
