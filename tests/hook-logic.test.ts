/**
 * Hooks / Hookify 处理逻辑补测（零依赖，node:test）。
 * 覆盖此前未充分覆盖的纯逻辑分支：
 *  - evaluateHookifyRules：block/warn、all 事件、command 在 evaluate 中被跳过、工具名/事件不匹配跳过
 *  - 多条件 conditions 与 6 种 operator（经 evaluateHookifyRules 间接覆盖 ruleMatches/applyOperator）
 *  - EVENT_FIELDS 多候选主字段（command/code/content/new_string/new_text）
 *  - validateHookifyPattern / listHookifyRules
 *  - runCommandHooks 的 exit 非0非2（warn）分支、命中前 ruleMatches 异常静默跳过、未命中事件不执行
 *  - userPromptSubmitHook：prompt 事件 block/warn/无
 *  - sessionStartHook：AGENTS.md/CLAUDE.md/.agent/rules 检测
 *  - preCompactHook：goal 优先 + 回退最近 user 消息 + 空消息
 *  - subagentStartHook / subagentStopHook
 *  - preToolUse 的 deny 硬阻断 / allow 跳过危险命令 / run_code 走 bash 事件
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { evaluateHookifyRules, validateHookifyPattern, listHookifyRules, loadHookifyRules, runCommandHooks } from "../src/hookify";
import { userPromptSubmitHook, sessionStartHook, preCompactHook, subagentStartHook, subagentStopHook, preToolUse } from "../src/hooks";
import { ChatMessage } from "../src/provider";

function withRules(basename: string, content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fshooklogic-"));
  const dir = path.join(root, ".freeseek", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, basename), content, "utf8");
  // 同时清空全局 hooks 目录影响
  return root;
}

const blockBash = (name: string, body = "no") =>
  `---\nname: ${name}\nenabled: true\nevent: bash\naction: block\npattern: rm\\s+-rf\n---\n${body}`;
const warnBash = (name: string, pat: string, body = "warn") =>
  `---\nname: ${name}\nenabled: true\nevent: bash\naction: warn\npattern: ${pat}\n---\n${body}`;

// ---------- evaluateHookifyRules ----------
test("evaluateHookifyRules: bash 事件 block 命中", () => {
  const root = withRules("b.md", blockBash("b1", "blocked-msg"));
  const r = evaluateHookifyRules("bash", "run_command", { command: "rm -rf /x" }, root);
  assert.ok(r.blocked?.includes("b1"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("evaluateHookifyRules: 未命中不报", () => {
  const root = withRules("b.md", blockBash("b1"));
  const r = evaluateHookifyRules("bash", "run_command", { command: "ls -la" }, root);
  assert.equal(r.blocked, null);
  assert.equal(r.warnings.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("evaluateHookifyRules: warn 命中返回 warnings", () => {
  const root = withRules("w.md", warnBash("w1", "npm test"));
  const r = evaluateHookifyRules("bash", "run_command", { command: "npm test" }, root);
  assert.equal(r.blocked, null);
  assert.ok(r.warnings.some((w) => w.includes("w1")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("evaluateHookifyRules: all 事件对任意工具生效", () => {
  const rule = (name: string) =>
    `---\nname: ${name}\nenabled: true\nevent: all\naction: warn\npattern: SECRET\\s*=\n---\nleak`;
  const root = withRules("a.md", rule("a1"));
  const r = evaluateHookifyRules("file", "write_file", { content: "SECRET = x" }, root);
  assert.ok(r.warnings.some((w) => w.includes("a1")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("evaluateHookifyRules: command 规则在 evaluate 中被跳过", () => {
  const root = withRules(
    "c.md",
    '---\nname: c1\nenabled: true\nevent: bash\naction: command\ncommand: node -e "process.exit(2)"\n---\nx'
  );
  const r = evaluateHookifyRules("bash", "run_command", { command: "anything" }, root);
  assert.equal(r.blocked, null);
  assert.equal(r.warnings.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("evaluateHookifyRules: 事件与工具名不匹配时跳过", () => {
  const root = withRules("b.md", blockBash("b1"));
  // bash 事件但给 write_file 工具 → 不在 EVENT_TOOLS.bash 内，不命中
  const r = evaluateHookifyRules("bash", "write_file", { new_string: "rm -rf /x" }, root);
  assert.equal(r.blocked, null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- 多条件 conditions + 各 operator ----------
function condRule(name: string, event: string, conditions: string): string {
  return `---\nname: ${name}\nenabled: true\nevent: ${event}\naction: warn\nconditions:\n${conditions}\n---\ncond`;
}

test("evaluateHookifyRules: 多条件全部满足才命中", () => {
  const cond = condRule("c", "file",
    "  - field: file_path\n    operator: regex_match\n    pattern: \\.tsx?$\n  - field: new_string\n    operator: regex_match\n    pattern: API_KEY");
  const root = withRules("c.md", cond);
  const hit = evaluateHookifyRules("file", "edit_file", { file_path: "a.ts", new_string: "API_KEY=1" }, root);
  assert.ok(hit.warnings.length > 0);
  const miss = evaluateHookifyRules("file", "edit_file", { file_path: "a.py", new_string: "API_KEY=1" }, root);
  assert.equal(miss.warnings.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("evaluateHookifyRules: 6 种 operator 均可用", () => {
  // 以 command="hello" 为锚，各 operator 语义需与之匹配
  const cases: [string, string][] = [
    ["contains", "hello"],
    ["equals", "hello"],
    ["starts_with", "he"],
    ["ends_with", "lo"],
    ["not_contains", "zzz"],
    ["regex_match", "hel"],
  ];
  for (const [op, pat] of cases) {
    const cond = condRule("o", "bash",
      `  - field: command\n    operator: ${op}\n    pattern: ${pat}`);
    const root = withRules("o.md", cond);
    const r = evaluateHookifyRules("bash", "run_command", { command: "hello" }, root);
    assert.ok(r.warnings.length > 0, `operator ${op} 应命中（command=hello, pattern=${pat}）`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateHookifyRules: regex_match operator 大小写不敏感", () => {
  const cond = condRule("r", "bash", "  - field: command\n    operator: regex_match\n    pattern: FOO");
  const root = withRules("r.md", cond);
  const r = evaluateHookifyRules("bash", "run_command", { command: "FOObar" }, root);
  assert.ok(r.warnings.length > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- EVENT_FIELDS 多候选主字段 ----------
test("EVENT_FIELDS: run_code 用 code 字段", () => {
  const root = withRules("b.md", warnBash("bc", "danger"));
  const r = evaluateHookifyRules("bash", "run_code", { code: "danger()" }, root);
  assert.ok(r.warnings.some((w) => w.includes("bc")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("EVENT_FIELDS: write_file 用 content / edit_file 用 new_string", () => {
  const warnFile = (name: string, pat: string, body = "warn") =>
    `---\nname: ${name}\nenabled: true\nevent: file\naction: warn\npattern: ${pat}\n---\n${body}`;
  const root = withRules("f.md", warnFile("fw", "leak"));
  const w = evaluateHookifyRules("file", "write_file", { content: "leak" }, root);
  assert.ok(w.warnings.length > 0, "write_file 应命中 content 字段");
  const e = evaluateHookifyRules("file", "edit_file", { new_string: "leak" }, root);
  assert.ok(e.warnings.length > 0, "edit_file 应命中 new_string 字段");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- validateHookifyPattern / listHookifyRules ----------
test("validateHookifyPattern: 合法/非法", () => {
  assert.equal(validateHookifyPattern("a.*b"), true);
  assert.equal(validateHookifyPattern("("), false);
});

test("listHookifyRules: 返回 5 字段", () => {
  const root = withRules("b.md", blockBash("b1"));
  const list = listHookifyRules(root);
  assert.equal(list.length, 1);
  const r0 = list[0];
  assert.deepEqual(Object.keys(r0).sort(), ["action", "enabled", "event", "name", "source"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("loadHookifyRules: 不排除 disabled（过滤在 evaluate/run 时做）", () => {
  const root = withRules("b.md", blockBash("b1").replace("enabled: true", "enabled: false"));
  const rules = loadHookifyRules(root);
  // load 阶段只解析，不按 enabled 过滤；disabled 由 evaluateHookifyRules 跳过
  assert.equal(rules.length, 1);
  assert.equal(rules[0].enabled, false);
  // evaluate 时 disabled 不生效
  const r = evaluateHookifyRules("bash", "run_command", { command: "rm -rf /x" }, root);
  assert.equal(r.blocked, null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- runCommandHooks 补充分支 ----------
test("runCommandHooks: exit 非0非2 记为 warning note", async () => {
  const root = withRules(
    "w.md",
    '---\nname: w\nenabled: true\nevent: bash\naction: command\ncommand: node -e "console.log(\'warn-msg\'); process.exit(3)"\n---\nwmsg'
  );
  const r = await runCommandHooks(root, "bash", "run_command", { command: "x" }, true);
  assert.equal(r.blocked, null);
  assert.ok(r.notes.some((n) => n.includes("warn-msg") && n.includes("exit=3")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("runCommandHooks: 未命中事件不执行命令", async () => {
  // command 规则写在 bash 事件，但事件给 file → 不应执行 node 退出逻辑
  const root = withRules(
    "w.md",
    '---\nname: w\nenabled: true\nevent: bash\naction: command\ncommand: node -e "process.exit(2)"\n---\nx'
  );
  const r = await runCommandHooks(root, "file", "write_file", { content: "x" }, true);
  assert.equal(r.blocked, null);
  assert.equal(r.notes.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("runCommandHooks: 命中前 ruleMatches 异常（非法正则）静默跳过", async () => {
  const root = withRules(
    "w.md",
    '---\nname: w\nenabled: true\nevent: bash\naction: command\npattern: (\ncommand: node -e "process.exit(2)"\n---\nx'
  );
  // pattern: ( 为非法正则，applyOperator 抛错被 catch → 不命中 → 命令不执行
  const r = await runCommandHooks(root, "bash", "run_command", { command: "anything" }, true);
  assert.equal(r.blocked, null);
  assert.equal(r.notes.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- userPromptSubmitHook ----------
test("userPromptSubmitHook: prompt 事件 block 命中", async () => {
  const root = withRules(
    "p.md",
    '---\nname: p\nenabled: true\nevent: prompt\naction: block\npattern: forbidden\n---\nno'
  );
  const r = await userPromptSubmitHook("this is forbidden", root);
  assert.ok(r.note.includes("p"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("userPromptSubmitHook: 安全 prompt 返回空 note", async () => {
  const root = withRules("p.md",
    '---\nname: p\nabled: true\nevent: prompt\naction: block\npattern: forbidden\n---\nno');
  const r = await userPromptSubmitHook("hello", root);
  assert.equal(r.note, "");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- sessionStartHook ----------
test("sessionStartHook: 检测 AGENTS.md / CLADUDE.md / .agent/rules", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fssess-"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "", "utf8");
  fs.mkdirSync(path.join(root, ".agent", "rules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "rules", "a.md"), "", "utf8");
  const msg = await sessionStartHook(root);
  assert.ok(msg.includes("AGENTS.md"));
  assert.ok(msg.includes(".agent/rules"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("sessionStartHook: 无约定文件返回空", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fssess-"));
  const msg = await sessionStartHook(root);
  assert.equal(msg, "");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- preCompactHook ----------
test("preCompactHook: goal 优先于最近 user 消息", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fspc-"));
  const msgs: ChatMessage[] = [
    { role: "user", content: "旧目标" },
    { role: "user", content: "新消息" },
  ];
  const out = await preCompactHook(msgs, root, { objective: "目标A", phase: "active" } as any);
  assert.ok(out.includes("钉住"));
  const pinned = fs.readFileSync(path.join(root, ".agent", ".last_compact_state.md"), "utf8");
  assert.equal(pinned, "目标A");
  fs.rmSync(root, { recursive: true, force: true });
});

test("preCompactHook: 无 goal 时回退最近 user 消息", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fspc-"));
  const msgs: ChatMessage[] = [
    { role: "user", content: "早期" },
    { role: "assistant", content: "回答" },
    { role: "user", content: "最近消息" },
  ];
  await preCompactHook(msgs, root);
  const pinned = fs.readFileSync(path.join(root, ".agent", ".last_compact_state.md"), "utf8");
  assert.equal(pinned, "最近消息");
  fs.rmSync(root, { recursive: true, force: true });
});

test("preCompactHook: 空消息返回空", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fspc-"));
  const out = await preCompactHook([], root);
  assert.equal(out, "");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- subagent hooks ----------
test("subagentStartHook / subagentStopHook 返回字符串", () => {
  assert.ok(subagentStartHook("worker").includes("worker"));
  assert.ok(subagentStopHook("worker").includes("worker"));
});

// ---------- preToolUse 补充分支 ----------
test("preToolUse: deny 规则硬阻断（优先级最高）", async () => {
  const r = await preToolUse("run_command", { command: "ls" }, false, "", [], ["run_command"]);
  assert.equal(r.ok, false);
  assert.ok(String(r.message ?? "").includes("被权限规则拒绝"));
});

test("preToolUse: allow 规则跳过危险命令硬阻断", async () => {
  // allow 命中 → 绕过 L2 灾难命令拦截
  const r = await preToolUse("run_command", { command: "rm -rf /" }, false, "", ["run_command"]);
  assert.equal(r.ok, true);
});

test("preToolUse: run_code 不被 L2 灾难命令硬阻断（与 run_command 不对称，见审查说明）", async () => {
  // hooks.ts:187 的 L2 硬阻断仅对 toolName==='run_command' 生效，run_code 走 bash 事件但不受 DANGEROUS_PATTERNS 拦截
  const r = await preToolUse("run_code", { code: "rm -rf /" }, false, "");
  assert.equal(r.ok, true);
});

test("preToolUse: hookify block 在 preToolUse 中生效", async () => {
  const root = withRules("b.md", blockBash("b1", "nope"));
  const r = await preToolUse("run_command", { command: "rm -rf /x" }, false, root);
  assert.equal(r.ok, false);
  assert.ok(String(r.message ?? "").includes("b1"));
  fs.rmSync(root, { recursive: true, force: true });
});
