/**
 * 工具定义全集一致性测试（零依赖，node:test）。
 * 覆盖：TOOL_DEFINITIONS 数量、命名唯一、schema 结构合法、必填参数存在、与 tool-catalog 文档对齐。
 * 改动 src/tools/defs.ts（增删工具）后必须更新此处与 docs/tool-catalog.md（node scripts/gen-catalog.mjs --write）。
 */
import { test } from 'node:test';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TOOL_DEFINITIONS } from "../src/tools/defs";

// 测试 runner 始终以仓库根为 cwd；不要依赖 bundle/tsc 输出目录的 __dirname。
const root = process.cwd();

test("TOOL_DEFINITIONS 全部为合法 function schema", () => {
  assert.ok(TOOL_DEFINITIONS.length >= 30, `工具数过少：${TOOL_DEFINITIONS.length}`);
  for (const def of TOOL_DEFINITIONS) {
    assert.equal(def.type, "function", `工具 ${def.function.name} 的 type 必须为 function`);
    const fn = def.function;
    assert.equal(typeof fn.name, "string", `缺少 name`);
    assert.equal(typeof fn.description, "string", `工具 ${fn.name} 缺少 description`);
    assert.ok(fn.description.length > 0, `工具 ${fn.name} 的 description 为空`);
    const params = fn.parameters as any;
    assert.equal(params.type, "object", `工具 ${fn.name} parameters.type 必须为 object`);
    assert.ok(params.properties, `工具 ${fn.name} 缺少 properties`);
    // required 中每一项都必须在 properties 里出现
    for (const req of params.required ?? []) {
      assert.ok(req in params.properties, `工具 ${fn.name} required 的 ${req} 不在 properties 中`);
    }
  }
});

test("工具名唯一（无重复）", () => {
  const names = TOOL_DEFINITIONS.map((d) => d.function.name);
  const seen = new Set<string>();
  for (const n of names) {
    assert.ok(!seen.has(n), `工具名重复：${n}`);
    seen.add(n);
  }
});

test("核心内置工具必须存在", () => {
  const names = new Set(TOOL_DEFINITIONS.map((d) => d.function.name));
  const required = [
    "read_file", "write_file", "edit_file", "list_directory", "grep", "glob",
    "search_files", "run_command", "delete_file", "ask_user", "todo_write",
    "todo_read", "remember", "load_skill", "spawn_agent", "spawn_agents",
    "create_worktree", "remove_worktree", "list_worktrees", "checkpoint",
    "rewind", "list_checkpoints", "slash_command", "send_message", "promote_skill",
    "web_search", "web_fetch", "browser", "lsp", "verify", "run_python",
    "run_code", "goal", "goal_view", "job_list", "job_output", "job_kill",
  ];
  for (const r of required) {
    assert.ok(names.has(r), `缺少核心工具：${r}`);
  }
});

test("tool-catalog.md 与实际工具集合一致", () => {
  const catalog = path.join(root, "docs", "tool-catalog.md");
  assert.ok(fs.existsSync(catalog), "docs/tool-catalog.md 缺失（先跑 node scripts/gen-catalog.mjs --write）");
  const text = fs.readFileSync(catalog, "utf8");
  const m = text.match(/共 \*\*(\d+)\*\* 个内置工具/);
  assert.ok(m, "docs/tool-catalog.md 未标注工具数量");
  assert.equal(Number(m![1]), TOOL_DEFINITIONS.length,
    `文档声称 ${m![1]} 个工具，实际 ${TOOL_DEFINITIONS.length} 个；请重跑 gen-catalog.mjs`);
  for (const d of TOOL_DEFINITIONS) {
    assert.ok(text.includes("`" + d.function.name + "`"),
      `docs/tool-catalog.md 未收录工具：${d.function.name}`);
  }
});
