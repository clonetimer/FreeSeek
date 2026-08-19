/**
 * FreeSeek 冒烟测试（零依赖，node:test）。
 *
 * 用法：
 *   node scripts/smoke.mjs            # 类型检查 + 构建 + dist 产物完整性
 *   node scripts/smoke.mjs --package  # 额外打包 vsix 并校验
 *
 * 目的：防止「encodeBuffer 未导入」这类低级错误漏进 vsix。
 * 每次发布前跑一遍：npm run smoke 或 npm run smoke:package
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const withPackage = process.argv.includes("--package");

/** 直接以 node 运行 JS 入口（无需 shell，避免 Windows .cmd 与转义问题）。 */
function runNode(entry, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    ...opts,
  });
  return r;
}

/** 经 shell 运行（仅 vsce 这类 .cmd 命令需要）。参数拼接为单字符串避免 DEP0190 警告。 */
function runShell(cmd, args, opts = {}) {
  const r = spawnSync(`${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: 180_000,
    ...opts,
  });
  return r;
}

test("TS 类型检查（tsc --noEmit）—— 抓未导入/类型错误", () => {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const r = runNode(tsc, ["-p", "tsconfig.check.json", "--noEmit"]);
  assert.equal(r.status, 0, `tsc 失败（exit ${r.status}）:\n${r.stdout}\n${r.stderr}`);
});

test("esbuild 构建", () => {
  const r = runNode(path.join(root, "esbuild.js"));
  assert.equal(r.status, 0, `构建失败（exit ${r.status}）:\n${r.stdout}\n${r.stderr}`);
});

test("dist 产物完整性与关键标记", () => {
  for (const f of ["dist/extension.js", "dist/freeseek-headless.js", "dist/freeseek-eval.js", "dist/freeseek-bench.js", "dist/webview.js", "dist/mermaid.js"]) {
    const p = path.join(root, f);
    assert.ok(fs.existsSync(p), `${f} 缺失`);
    assert.ok(fs.statSync(p).size > 10_000, `${f} 过小（${fs.statSync(p).size} B）`);
  }
  const ext = fs.readFileSync(path.join(root, "dist/extension.js"), "utf8");
  for (const marker of ["setMode", "agent_mode", "modeSeg", "encodeBuffer", "__auto__", "browser"]) {
    assert.ok(ext.includes(marker), `dist/extension.js 缺少关键标记「${marker}」`);
  }
  const wv = fs.readFileSync(path.join(root, "dist/webview.js"), "utf8");
  for (const marker of ["modeCraftBtn", "setMode", "agent_mode"]) {
    assert.ok(wv.includes(marker), `dist/webview.js 缺少关键标记「${marker}」`);
  }
  assert.ok(fs.existsSync(path.join(root, "benchmarks/v1/manifest.json")), "内置 benchmark manifest 缺失");

  for (const file of ["freeseek-headless.js", "freeseek-eval.js", "freeseek-bench.js"]) {
    const source = fs.readFileSync(path.join(root, "dist", file), "utf8");
    const lines = source.split(/\r?\n/);
    assert.equal(lines[0], "#!/usr/bin/env node", `${file} shebang 必须位于第 1 行`);
    assert.equal(lines.filter((line) => line.startsWith("#!")).length, 1, `${file} 只能包含一个 shebang`);
  }
});

test("vsix 打包", { skip: !withPackage }, () => {
  const vsix = path.join(root, `freeseek-copilot-${pkg.version}.vsix`);
  if (fs.existsSync(vsix)) fs.rmSync(vsix);
  const r = runShell("npx", ["--no-install", "vsce", "package", "--no-dependencies"]);
  assert.equal(r.status, 0, `vsce 打包失败（exit ${r.status}）:\n${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(vsix), `vsix 未生成: ${vsix}`);
  assert.ok(fs.statSync(vsix).size > 100_000, `vsix 过小（${fs.statSync(vsix).size} B）`);
});

if (!withPackage) {
  console.log("\n提示：运行 `node scripts/smoke.mjs --package` 可额外打包并校验 vsix。");
}
