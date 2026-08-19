import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRepoMap, planRepositoryContext } from "../src/context-planner";
import { builtInBenchManifestPath, loadBenchSuite } from "../src/bench";

test("Context Planner v1 用符号/路径评分并扩展局部依赖，预算保持有界", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-plan-"));
  try {
    fs.mkdirSync(path.join(root, "src", "billing"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "money"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "legacy"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "billing", "invoice.ts"), [
      'import { roundMoney } from "../money/round";',
      "export function calculateInvoice(lines: Array<{price:number; qty:number}>) {",
      "  const total = lines.reduce((sum, line) => sum + line.price * line.qty, 0);",
      "  return roundMoney(total);",
      "}",
    ].join("\n"));
    fs.writeFileSync(path.join(root, "src", "money", "round.ts"), "export function roundMoney(value:number) { return Math.round(value * 100) / 100; }\n");
    fs.writeFileSync(path.join(root, "src", "legacy", "invoice.ts"), "export function calculateInvoice(){ return 0 }\n");
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, `noise-${i}.ts`), `export const noise${i} = ${i};\n`);

    const map = buildRepoMap(root);
    const invoice = map.files.find((file) => file.path === "src/billing/invoice.ts");
    assert.ok(invoice);
    assert.deepStrictEqual(invoice.resolvedImports, ["src/money/round.ts"]);
    assert.ok(invoice.symbols.some((symbol) => symbol.name === "calculateInvoice"));

    const plan = planRepositoryContext(root, "invoice totals have a one-cent bug in calculateInvoice; locate the production calculation path", {
      budgetTokens: 1200,
      maxFiles: 5,
    });
    assert.equal(plan.selected[0].path, "src/billing/invoice.ts");
    assert.ok(plan.selected.some((file) => file.path === "src/money/round.ts"), "局部依赖应进入候选上下文");
    assert.ok(plan.selected.findIndex((file) => file.path === "src/legacy/invoice.ts") !== 0, "legacy 不应压过生产路径");
    assert.ok(plan.estimatedTokens <= 1200, `planner 注入必须受 token budget 约束，实际=${plan.estimatedTokens}`);
    assert.match(plan.rendered, /FreeSeek Context Planner v1/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Context Planner v1 在公开 context regression 的 4/4 任务中 top-3 命中生产文件", () => {
  const suite = loadBenchSuite(builtInBenchManifestPath());
  const expected: Record<string, string> = {
    "context-invoice-rounding": "src/billing/calc.js",
    "context-auth-all-roles": "src/server/middleware/authorize.js",
    "context-feature-flag-default": "src/features/checkout/flags.js",
    "context-locale-fallback": "src/i18n/runtime/fallback.js",
  };
  let hits = 0;
  for (const row of suite.manifest.cases.filter((item) => item.category === "context")) {
    const plan = planRepositoryContext(row.workspace!, row.prompt, { budgetTokens: 1500, maxFiles: 6 });
    const top3 = plan.selected.slice(0, 3).map((file) => file.path);
    if (top3.includes(expected[row.id])) hits++;
    assert.ok(top3.includes(expected[row.id]), `${row.id}: top3=${top3.join(", ")}`);
  }
  assert.equal(hits, 4);
});

test("Context Planner 跳过 symlink，避免 repo map 把工作区外内容带进模型上下文", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-outside-"));
  try {
    fs.writeFileSync(path.join(root, "safe.ts"), "export const safe = true;\n");
    fs.writeFileSync(path.join(outside, "secret.ts"), "export const superSecret = 'outside';\n");
    try { fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir"); } catch { return; }
    const map = buildRepoMap(root);
    assert.deepStrictEqual(map.files.map((file) => file.path), ["safe.ts"]);
    const plan = planRepositoryContext(root, "superSecret", { budgetTokens: 512 });
    assert.doesNotMatch(plan.rendered, /linked\/secret\.ts|outside/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Context Planner v1.1 根据 hidden-path probes 修正 tests/docs/example 的 ranking miss", () => {
  const suite = loadBenchSuite(builtInBenchManifestPath());
  const probes: Record<string, { query: string; target: string }> = {
    "context-invoice-rounding": {
      query: "账单出现 1 分钱误差。规则：先累加所有 price * qty，最后只对总额四舍五入到 2 位。定位并修复生产实现，不要修改 tests 或 legacy。",
      target: "src/billing/calc.js",
    },
    "context-auth-all-roles": {
      query: "生产授权业务规则从“满足任一角色”改成“必须同时拥有全部 required roles”；空 required 应允许已认证用户。修复正确模块，不要修改 legacy/tests。",
      target: "src/server/middleware/authorize.js",
    },
    "context-feature-flag-default": {
      query: "线上发现 newCheckout 在没有配置时被意外打开。默认必须关闭，但显式 {newCheckout:true} 仍应打开。定位生产 checkout flag resolver，不要修改 example config/tests。",
      target: "src/features/checkout/flags.js",
    },
    "context-locale-fallback": {
      query: "修复 runtime locale fallback。zh-Hant-TW 应依次尝试 zh-Hant-TW, zh-Hant, zh, en；en 不应重复。定位正确 runtime 实现，build 目录不要改。不要修改 tests。",
      target: "src/i18n/runtime/fallback.js",
    },
  };
  let v1Top1 = 0;
  let v11Top1 = 0;
  for (const row of suite.manifest.cases.filter((item) => item.category === "context")) {
    const probe = probes[row.id];
    assert.ok(probe, row.id);
    const v1 = planRepositoryContext(row.workspace!, probe.query, { mode: "v1", budgetTokens: 1500, maxFiles: 6 });
    const v11 = planRepositoryContext(row.workspace!, probe.query, { mode: "v1.1", budgetTokens: 1500, maxFiles: 6 });
    if (v1.selected[0]?.path === probe.target) v1Top1++;
    if (v11.selected[0]?.path === probe.target) v11Top1++;
    assert.equal(v11.selected[0]?.path, probe.target, `${row.id}: ${v11.selected.map((file) => file.path).join(", ")}`);
  }
  assert.equal(v1Top1, 0, "该 probe 集应稳定复现 v1 的 ranking miss，防止实验失去区分度");
  assert.equal(v11Top1, 4);
});


test("Context Planner v1.2 保持 v1.1 retrieval 排序，只改变 evidence/tool-discipline 呈现", () => {
  const suite = loadBenchSuite(builtInBenchManifestPath());
  for (const row of suite.manifest.cases.filter((item) => item.category === "context")) {
    const v11 = planRepositoryContext(row.workspace!, row.prompt, { mode: "v1.1", budgetTokens: 1500, maxFiles: 6 });
    const v12 = planRepositoryContext(row.workspace!, row.prompt, { mode: "v1.2", budgetTokens: 1500, maxFiles: 6 });
    assert.deepStrictEqual(v12.selected.map((file) => file.path), v11.selected.map((file) => file.path), `${row.id}: v1.2 不应改变 retrieval 排序`);
    assert.match(v12.rendered, /FreeSeek Context Evidence v1\.2/);
    assert.match(v12.rendered, /Tool discipline/);
    assert.match(v12.rendered, /Do not repeat broad list_directory\/search_files\/grep/);
    assert.doesNotMatch(v12.rendered, /任务：/);
    assert.ok(v12.estimatedTokens <= 1500);
  }
});

test("Context Planner v1.2 把用户明确排除路径呈现为 edit boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-context-v12-exclude-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "target.ts"), "export const target = true;\n");
    fs.writeFileSync(path.join(root, "tests", "target.test.ts"), "target\n");
    const plan = planRepositoryContext(root, "修复生产 target，不要修改 tests", { mode: "v1.2", budgetTokens: 800 });
    assert.match(plan.rendered, /User exclusion boundary: `__tests__`, `test`, `tests`|User exclusion boundary: `test`, `tests`, `__tests__`|User exclusion boundary:/);
    assert.match(plan.rendered, /Do not modify these paths/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
