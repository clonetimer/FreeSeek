import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadHookifyRules,
  runCommandHooks,
  createHookifyRule,
  toggleHookifyRule,
  deleteHookifyRule,
  serializeHookifyRule,
} from "../src/hookify";

function writeRule(root: string, basename: string, content: string): void {
  const dir = path.join(root, ".freeseek", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, basename), content, "utf8");
}

test("hookify: 解析 action=command 规则", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  writeRule(root, "cmd.md", "---\nname: c1\nenabled: true\nevent: bash\naction: command\ncommand: echo hi\n---\nhi");
  const rules = loadHookifyRules(root).filter((r) => r.name === "c1");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action, "command");
  assert.equal(rules[0].command, "echo hi");
  fs.rmSync(root, { recursive: true, force: true });
});

test("runCommandHooks: exit 2 阻塞", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  writeRule(root, "block.md", '---\nname: block\nenabled: true\nevent: bash\naction: command\ncommand: node -e "process.exit(2)"\n---\nblocked');
  const r = await runCommandHooks(root, "bash", "run_command", { command: "x" }, true);
  assert.ok(r.blocked, "exit 2 应阻塞");
  fs.rmSync(root, { recursive: true, force: true });
});

test("runCommandHooks: exit 0 产出 note", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  writeRule(root, "ok.md", '---\nname: ok\nenabled: true\nevent: bash\naction: command\ncommand: node -e "console.log(\'done\')"\n---');
  const r = await runCommandHooks(root, "bash", "run_command", { command: "x" }, true);
  assert.ok(r.notes.some((n) => n.includes("done")), "exit 0 应产出 note");
  fs.rmSync(root, { recursive: true, force: true });
});

test("runCommandHooks: allow=false 跳过命令执行", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  writeRule(root, "block.md", '---\nname: block\nenabled: true\nevent: bash\naction: command\ncommand: node -e "process.exit(2)"\n---\nblocked');
  const r = await runCommandHooks(root, "bash", "run_command", { command: "x" }, false);
  assert.equal(r.blocked, null);
  assert.equal(r.notes.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 规则文件管理（侧边栏/命令 UI 用的纯函数）──

test("serializeHookifyRule: 生成合法的 frontmatter + 正文", () => {
  const md = serializeHookifyRule("block-rm", {
    event: "bash",
    action: "block",
    pattern: "rm\\s+-rf",
    message: "禁止递归删除",
  });
  assert.ok(md.startsWith("---\nname: block-rm"));
  assert.ok(md.includes("event: bash"));
  assert.ok(md.includes("action: block"));
  assert.ok(md.includes("pattern: rm\\s+-rf"));
  assert.ok(md.endsWith("禁止递归删除"));
});

test("createHookifyRule: 写入项目级 hooks 目录且可被加载", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  const res = createHookifyRule(root, "block-rm", { event: "bash", action: "block", pattern: "rm\\s+-rf", message: "x" });
  assert.equal(res.ok, true);
  assert.ok(res.path && res.path.endsWith(path.join(".freeseek", "hooks", "block-rm.md")));
  assert.ok(fs.existsSync(res.path!));
  const rules = loadHookifyRules(root);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, "block-rm");
  assert.equal(rules[0].action, "block");
  fs.rmSync(root, { recursive: true, force: true });
});

test("createHookifyRule: 非法名称与重复创建被拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  assert.equal(createHookifyRule(root, "bad name!", { event: "all", action: "warn" }).ok, false);
  assert.equal(createHookifyRule("", "x", { event: "all", action: "warn" }).ok, false);
  assert.equal(createHookifyRule(root, "a", { event: "all", action: "warn" }).ok, true);
  assert.equal(createHookifyRule(root, "a", { event: "all", action: "warn" }).ok, false, "重复名应失败");
  fs.rmSync(root, { recursive: true, force: true });
});

test("toggleHookifyRule: 切换 enabled 后热加载反映新状态", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  // 需带正文/pattern 才是有内容的有效规则（否则 parseRuleFile 返回 null 不被加载）
  const res = createHookifyRule(root, "r1", { event: "all", action: "warn", message: "hi" });
  assert.equal(res.ok, true);
  assert.equal(toggleHookifyRule(res.path!, false).ok, true);
  const rules = loadHookifyRules(root);
  assert.equal(rules[0].enabled, false);
  assert.equal(toggleHookifyRule(res.path!, true).ok, true);
  assert.equal(loadHookifyRules(root)[0].enabled, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("toggleHookifyRule: 无 enabled 行的文件也能插入", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  // 手写一个缺 enabled 行的规则文件
  writeRule(root, "noen.md", "---\nname: noen\nevent: bash\naction: warn\npattern: x\n---\nmsg");
  const rules = loadHookifyRules(root);
  assert.equal(rules[0].enabled, true, "缺省 enabled 视为启用");
  const source = rules[0].source;
  assert.equal(toggleHookifyRule(source, false).ok, true);
  assert.equal(loadHookifyRules(root)[0].enabled, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("deleteHookifyRule: 删除规则文件", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshook-"));
  const res = createHookifyRule(root, "del", { event: "all", action: "warn" });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(res.path!));
  assert.equal(deleteHookifyRule(res.path!).ok, true);
  assert.ok(!fs.existsSync(res.path!));
  assert.equal(loadHookifyRules(root).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});