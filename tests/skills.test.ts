import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseFrontmatter, SkillManager } from "../src/skills";
import { SYSTEM_PROMPT, WORKFLOW_GUIDANCE } from "../src/prompts";
import { looksLikeTaskListOnly } from "../src/agent";

/** 在临时目录下创建单技能目录，返回临时根目录（测后由调用方清理）。 */
function makeSkillDir(name: string, md: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-"));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), md, "utf8");
  return root;
}

test("parseFrontmatter: 无 frontmatter 返回空元数据与原文", () => {
  const { fm, body } = parseFrontmatter("# Hello\n\n正文");
  assert.deepEqual(fm, {});
  assert.equal(body, "# Hello\n\n正文");
});

test("parseFrontmatter: 解析标量 / 布尔 / JSON 数组 / 带引号字符串", () => {
  const { fm, body } = parseFrontmatter(
    [
      "---",
      "name: code-review",
      "description: 审查代码",
      "status: active",
      'triggers: ["review", "审查"]',
      'requires: ["a", "b"]',
      "---",
      "SOP 正文",
    ].join("\n")
  );
  assert.equal(fm.name, "code-review");
  assert.equal(fm.status, "active");
  assert.deepEqual(fm.triggers, ["review", "审查"]);
  assert.deepEqual(fm.requires, ["a", "b"]);
  assert.equal(body, "SOP 正文");
});

test("parseFrontmatter: 非法 JSON 数组回退为原始字符串", () => {
  const { fm } = parseFrontmatter("---\ntriggers: [abc\n---\nbody");
  assert.equal(fm.triggers, "[abc");
});

test("SkillManager: 内置技能自动注册为 active", () => {
  const sm = new SkillManager([]);
  assert.ok(sm.hasSkills());
  assert.ok(sm.listAll().some((s) => s.builtin && s.status === "active"));
});

test("SkillManager: 内置技能带 marketplace 清单元数据（P0-① 借鉴点）", () => {
  const sm = new SkillManager([]);
  const builtins = sm.listAll().filter((s) => s.builtin);
  assert.ok(builtins.length >= 1);
  for (const s of builtins) {
    assert.ok(s.version, `内置技能 ${s.name} 应有 version`);
    assert.equal(s.author, "freeseek");
    assert.ok(s.category, `内置技能 ${s.name} 应有 category`);
    assert.equal(s.source, "builtin");
  }
});

test("SkillManager: 扫描临时目录技能并注入摘要", () => {
  const root = makeSkillDir("review-sop", "---\nname: review-sop\ndescription: 审查代码\ntriggers: [\"review\"]\n---\nSOP");
  try {
    const sm = new SkillManager([root]);
    const s = sm.listAll().find((x) => x.name === "review-sop");
    assert.ok(s);
    assert.equal(s.description, "审查代码");
    assert.ok(sm.getSummary(".").includes("review-sop"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SkillManager: pending 技能不注入且独立列出", () => {
  const root = makeSkillDir("sk", "---\nname: sk\nstatus: pending\n---\nbody");
  try {
    const sm = new SkillManager([root]);
    assert.equal(sm.getSummary(".").includes("**sk**"), false);
    assert.deepEqual(sm.listPending().map((x) => x.name), ["sk"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SkillManager: loadSkill 按依赖排序并防循环", () => {
  const rootA = makeSkillDir("a", "---\nname: a\nrequires: b\n---\nA正文");
  const rootB = makeSkillDir("b", "---\nname: b\nrequires: a\n---\nB正文");
  try {
    const sm = new SkillManager([rootA, rootB]);
    const loaded = sm.loadSkill("a");
    assert.ok(loaded.includes("A正文"));
    assert.ok(loaded.includes("B正文"));
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("SkillManager: loadSkill 缺失依赖给出提示", () => {
  const root = makeSkillDir("a", "---\nname: a\nrequires: ghost\n---\nA正文");
  try {
    const sm = new SkillManager([root]);
    const loaded = sm.loadSkill("a");
    assert.ok(loaded.includes("ghost"));
    assert.ok(loaded.includes("A正文"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SkillManager: setStatus 修改 SKILL.md 的 status 行", () => {
  const root = makeSkillDir("sk", "---\nname: sk\nstatus: active\n---\nbody");
  try {
    const sm = new SkillManager([root]);
    const r = sm.setStatus("sk", "pending");
    assert.equal(r.ok, true);
    const content = fs.readFileSync(path.join(root, "sk", "SKILL.md"), "utf8");
    assert.ok(content.includes("status: pending"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 第一档借鉴：从 E:\timer\agency-agents 提炼的三个内置技能（架构/数据/安全）。
const AGENCY_DERIVED = ["backend-architect", "data-engineer", "appsec-engineer"];

test("内置技能: 从 agency-agents 衍生技能均注册且字段齐全", () => {
  const sm = new SkillManager([]);
  const all = sm.listAll();
  for (const name of AGENCY_DERIVED) {
    const s = all.find((x) => x.name === name && x.builtin);
    assert.ok(s, `内置技能 ${name} 应存在`);
    assert.equal(s.status, "active");
    assert.ok(s.description && s.description.length > 0, `${name} 应有 description`);
    assert.ok(Array.isArray(s.triggers) && s.triggers.length > 0, `${name} 应有 triggers`);
    assert.ok(s.category, `${name} 应有 category`);
    const full = sm.loadSkill(name);
    assert.ok(full && full.length > 200, `${name} 的 content 应足够充实`);
  }
});

test("内置技能: agency-agents 衍生技能已剥离人格噪音", () => {
  const sm = new SkillManager([]);
  for (const name of AGENCY_DERIVED) {
    const full = sm.loadSkill(name);
    // 源 agent 文件的元数据噪音不应进入 SOP 正文
    assert.ok(!/#\s*vibe/i.test(full), `${name} 不应含 vibe 元字段`);
    assert.ok(!/#\s*color/i.test(full), `${name} 不应含 color 元字段`);
    assert.ok(!/success metrics/i.test(full), `${name} 不应含 success metrics 段`);
  }
});

test("技能 tools 声明: 缺失工具在 loadSkill 时提示但不阻塞", () => {
  // 声明了 unavailable_tool，但可用工具集合里没有它
  const root = makeSkillDir("gadget", "---\nname: gadget\ntools: read_file, unavailable_tool\n---\nbody");
  try {
    const sm = new SkillManager([root], { availableTools: ["read_file", "write_file"] });
    const full = sm.loadSkill("gadget");
    assert.ok(full.includes("unavailable_tool"), "loadSkill 应提示缺失工具");
    assert.ok(full.includes("body"), "技能正文仍应完整加载");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("技能 tools 声明: 工具齐全时无缺失提示；getSummary 展示需工具", () => {
  const root = makeSkillDir("gadget2", "---\nname: gadget2\ntools: read_file\n---\nbody");
  try {
    const sm = new SkillManager([root], { availableTools: ["read_file"] });
    const full = sm.loadSkill("gadget2");
    assert.ok(!full.includes("但当前不可用"), "工具齐全不应提示缺失");
    const list = sm.getSummary(".");
    assert.ok(list.includes("gadget2"));
    assert.ok(list.includes("需工具"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("内置技能 explore-project 存在且要求输出结构化总结", () => {
  const sm = new SkillManager([]);
  const s = sm.listAll().find((x) => x.name === "explore-project" && x.builtin);
  assert.ok(s, "应存在内置 explore-project 技能");
  assert.ok(s!.description.includes("结构化总结"));
  const content = sm.loadSkill("explore-project");
  assert.ok(content.includes("README"), "SOP 要求读取 README");
  assert.ok(content.includes("package.json"), "SOP 要求读取 package.json");
  assert.ok(content.includes("禁止只返回任务清单"), "SOP 禁止仅返回任务清单");
  assert.ok(content.includes("技术栈"), "SOP 要求输出技术栈");
  assert.ok(content.includes("入口与使用方式"), "SOP 要求输出入口与使用方式");
});

test("SYSTEM_PROMPT 强制探索/总结类任务给出结构化最终总结", () => {
  assert.ok(SYSTEM_PROMPT.includes("探索/总结类任务"));
  assert.ok(SYSTEM_PROMPT.includes("结构化最终总结"));
  assert.ok(SYSTEM_PROMPT.includes("绝不能只返回任务清单"));
});

test("WORKFLOW_GUIDANCE 禁止仅以任务清单结束对话", () => {
  assert.ok(WORKFLOW_GUIDANCE.includes("todo_write 只是计划清单，不是最终答案"));
  assert.ok(WORKFLOW_GUIDANCE.includes("禁止仅以任务清单结束对话"));
});

test("looksLikeTaskListOnly: 纯任务清单被识别为偷懒", () => {
  const list = [
    "- [ ] 读取 README.md",
    "- [ ] 读取 package.json",
    "- [ ] 浏览核心源码文件",
    "- [ ] 梳理目录结构",
  ].join("\n");
  assert.equal(looksLikeTaskListOnly(list), true);
});

test("looksLikeTaskListOnly: 含总结性标题的不误伤", () => {
  const summary = [
    "# 项目总结",
    "- 功能：这是一个 CLI 工具",
    "- 技术栈：Node.js + TypeScript",
    "- 入口：src/index.ts",
    "- 使用方式：npm start",
  ].join("\n");
  assert.equal(looksLikeTaskListOnly(summary), false, "含「总结/技术栈/入口」等标记不应判为偷懒");
});

test("looksLikeTaskListOnly: 过短或不足 3 行不误判", () => {
  assert.equal(looksLikeTaskListOnly("- 只一行"), false);
  assert.equal(looksLikeTaskListOnly("普通文字回答，没有列表"), false);
});
