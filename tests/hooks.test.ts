import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPermissionRules, scanFileContent, preToolUse } from "../src/hooks";

test("applyPermissionRules: 无配置规则时返回 none", () => {
  assert.deepEqual(applyPermissionRules("run_command", { command: "ls" }), { decision: "none" });
});

test("scanFileContent: 非文件编辑工具返回空", () => {
  assert.deepEqual(scanFileContent("run_command", { command: "ls" }), []);
});

test("scanFileContent: 命中动态代码执行", () => {
  const w = scanFileContent("write_file", { content: "eval(userInput);" });
  assert.ok(w.some((x) => x.includes("动态代码执行")));
});

test("scanFileContent: 命中硬编码凭据", () => {
  const w = scanFileContent("edit_file", { newText: 'const API_KEY = "sk-1234567890abcdef";' });
  assert.ok(w.some((x) => x.includes("硬编码凭据")));
});

test("scanFileContent: 命中危险文件权限", () => {
  const w = scanFileContent("write_file", { new_string: "chmod 777 /tmp/x" });
  assert.ok(w.some((x) => x.includes("危险文件权限")));
});

test("scanFileContent: 命中 Base64 混淆", () => {
  const w = scanFileContent("write_file", { text: "atob('aGVsbG8=')" });
  assert.ok(w.some((x) => x.includes("Base64 混淆")));
});

test("scanFileContent: edits 数组内文本也被扫描", () => {
  const w = scanFileContent("edit_file", {
    edits: [{ newText: 'const token = "ghp_1234567890abcdefgh";' }],
  });
  assert.ok(w.some((x) => x.includes("硬编码凭据")));
});

test("scanFileContent: 安全内容返回空", () => {
  assert.deepEqual(scanFileContent("write_file", { content: "const x = 1; // ok" }), []);
});

test("preToolUse: osSandboxed 时跳过危险命令硬阻断", async () => {
  const r = await preToolUse("run_command", { command: "rm -rf /" }, true);
  assert.equal(r.ok, true);
});

test("preToolUse: 非沙箱命中危险模式被拦截", async () => {
  const r = await preToolUse("run_command", { command: "rm -rf /" }, false, "");
  assert.equal(r.ok, false);
  assert.ok(String(r.message ?? "").includes("危险操作被拦截"));
});

test("preToolUse: 安全命令放行", async () => {
  const r = await preToolUse("run_command", { command: "ls -la" }, false, "");
  assert.equal(r.ok, true);
});

test("preToolUse: 文件编辑触发内容安全警告", async () => {
  const r = await preToolUse("write_file", { path: "a.js", content: "eval(x)" }, false, "");
  assert.equal(r.ok, true);
  assert.ok((r.warnings ?? []).some((w) => w.includes("动态代码执行")));
});
