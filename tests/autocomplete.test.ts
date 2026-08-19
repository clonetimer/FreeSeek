/**
 * 输入框补全模块（src/webview/autocomplete.ts）契约测试（零依赖，node:test）。
 * 注意：autocomplete.ts 依赖 components 渲染层（含 DOM/DOMPurify），无法在纯 node 环境 import，
 * 因此本测试用源码契约校验（fs 读文件断言），与 sidebar-entries.test.ts 同风格。
 * 覆盖：SLASH_COMMANDS 完整性/唯一性；send 引用的命令都在其中；跨文件接入一致性；技术债清理。
 */
import { test } from 'node:test';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 测试 runner 始终以仓库根为 cwd；不要依赖 bundle/tsc 输出目录的 __dirname。
const root = process.cwd();
const mainTs = fs.readFileSync(path.join(root, "src/webview/main.ts"), "utf8");
const autoTs = fs.readFileSync(path.join(root, "src/webview/autocomplete.ts"), "utf8");

// 从 autocomplete.ts 源码提取 SLASH_COMMANDS 数组中的命令名（避免 import 触发 DOM 依赖链）。
const slashNames: string[] = [];
for (const m of autoTs.matchAll(/name: "(\/[a-z]+)"/g)) slashNames.push(m[1]);

test("SLASH_COMMANDS 完整且命令名唯一", () => {
  assert.equal(new Set(slashNames).size, slashNames.length, "slash 命令名存在重复");
  const expected = ["/init", "/review", "/summarize", "/skills", "/compact", "/memory", "/model", "/clear"];
  for (const n of expected) {
    assert.ok(slashNames.includes(n), `缺少 slash 命令 ${n}`);
  }
});

test("autocomplete.ts 内每个命令都有 name 和 hint 字段", () => {
  // 每个 { name: "/x", hint: "..." } 行都带 hint
  const rows = autoTs.match(/name: "\/[a-z]+", hint: "[^"]*"/g) || [];
  assert.equal(rows.length, slashNames.length, "有命令缺 hint 字段或格式不符");
});

test("send 用到的 /clear /compact /memory /model 都在 SLASH_COMMANDS 中", () => {
  for (const cmd of ["/clear", "/compact", "/memory", "/model"]) {
    assert.ok(slashNames.includes(cmd), `send 引用的 ${cmd} 不在 SLASH_COMMANDS`);
  }
});

test("main.ts 正确导入 SLASH_COMMANDS 与 initAutocomplete 并接入", () => {
  assert.ok(
    mainTs.includes(`import { initAutocomplete, showFileAutocomplete, SLASH_COMMANDS } from "./autocomplete"`),
    "main.ts 未从 ./autocomplete 导入"
  );
  assert.ok(mainTs.includes("initAutocomplete({"), "main.ts 未调用 initAutocomplete");
  assert.ok(mainTs.includes("showFileAutocomplete("), "main.ts 未调用 showFileAutocomplete");
});

test("autocomplete.ts 逻辑层不在模块顶层访问 document", () => {
  // 逻辑层不应在顶层访问 document；渲染已全部在 components-autocomplete.ts。
  const topBlock = autoTs.slice(0, autoTs.indexOf("function detectTrigger"));
  assert.ok(!topBlock.includes("document."), "autocomplete.ts 顶层不应访问 document");
});

test("main.ts 行数豁免头已随拆分下调（1520→1420）", () => {
  // main.ts 仍是超 600 上限的豁免文件，但拆分自动补全后豁免值应从 1520 降到 1420。
  const m = mainTs.slice(0, 200).match(/check:max-lines (\d+)/);
  assert.ok(m, "main.ts 缺少行数豁免头");
  assert.ok(Number(m[1]) < 1520, `豁免值应小于拆分前的 1520，当前为 ${m[1]}`);
});
