import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolCalls,
  stripToolCalls,
  trimUnfinishedTurn,
  isConcurrencySafe,
  fuzzyResolveTool,
  levenshtein,
  runBounded,
  withTimeout,
  truncateToolResult,
  TOOL_OUTPUT_PREVIEW_CAP,
  TOOL_PARALLEL_LIMIT,
} from "../src/agent-utils";
import type { ChatMessage, ToolDefinition } from "../src/provider";

test("parseToolCalls: <tool_call> 标签解析", () => {
  const text = `前文\n<tool_call>\n{"name": "list_directory", "arguments": {"path": "."}}\n</tool_call>\n后文`;
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "list_directory");
  assert.deepEqual(calls[0].arguments, { path: "." });
});

test("parseToolCalls: markdown 代码围栏兜底", () => {
  const text = "```json\n{\"name\": \"grep\", \"arguments\": {\"pattern\": \"x\"}}\n```";
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "grep");
});

test("parseToolCalls: 混合格式不丢块（实现按 标签→围栏 两轮收集）", () => {
  const text = [
    `<tool_call>{"name": "a", "arguments": {}}</tool_call>`,
    "```json\n{\"name\": \"b\", \"arguments\": {}}\n```",
    "<tool_call>{\"name\": \"c\", \"arguments\": {}}</tool_call>",
  ].join("\n");
  const calls = parseToolCalls(text);
  // 两轮正则：先 <tool_call>（a、c），再代码围栏（b），顺序不按原文
  assert.deepEqual(calls.map((c) => c.name), ["a", "c", "b"]);
});

test("parseToolCalls: 非法 JSON 忽略", () => {
  const text = `<tool_call>{"name": 123}</tool_call> 普通代码块`;
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 0);
});

test("stripToolCalls: 移除标签与工具围栏，保留普通代码块", () => {
  const text = [
    `<tool_call>{"name": "a", "arguments": {}}</tool_call>`,
    "```json\n{\"name\": \"b\", \"arguments\": {}}\n```",
    "```js\nconst x = 1;\n```",
  ].join("\n");
  const out = stripToolCalls(text);
  assert.ok(!out.includes("tool_call"));
  assert.ok(!out.includes('"name"'));
  assert.ok(out.includes("const x = 1;"));
});

test("trimUnfinishedTurn: 正常 assistant+tool 序列保留", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "file content" },
    { role: "assistant", content: "完成" },
  ];
  const out = trimUnfinishedTurn(msgs);
  assert.equal(out.length, 4);
});

test("trimUnfinishedTurn: 未闭合 tool_calls 的 assistant 被回滚", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "assistant", content: "后面又一轮没有结果" },
  ];
  const out = trimUnfinishedTurn(msgs);
  // 带未闭合 tool_calls 的第一条 assistant 被顶掉，只保留后一轮
  assert.equal(out.length, 2);
  assert.equal(out[1].role, "assistant");
  assert.equal(out[1].content, "后面又一轮没有结果");
  assert.ok(!(out[0] as any).tool_calls, "第一条 assistant 不应残留 tool_calls");
});

test("trimUnfinishedTurn: 孤立 tool 消息丢弃", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "orphan", content: "没有对应 assistant" },
    { role: "assistant", content: "ok" },
  ];
  const out = trimUnfinishedTurn(msgs);
  assert.equal(out.length, 2);
  assert.ok(!out.some((m) => m.role === "tool"));
});

test("isConcurrencySafe: 白名单只读可并行，写/动态工具串行", () => {
  assert.equal(isConcurrencySafe("read_file"), true);
  assert.equal(isConcurrencySafe("glob"), true);
  assert.equal(isConcurrencySafe("write_file"), false);
  assert.equal(isConcurrencySafe("mcp__server__do"), false);
  assert.equal(isConcurrencySafe("conn__x"), false);
});

test("fuzzyResolveTool: 精确/包含/编辑距离/动态工具", () => {
  const tools: ToolDefinition[] = [
    { type: "function", function: { name: "list_directory", description: "", parameters: {} } },
    { type: "function", function: { name: "read_file", description: "", parameters: {} } },
  ];
  assert.equal(fuzzyResolveTool("list_directory", tools), "list_directory");
  assert.equal(fuzzyResolveTool("list_directorylist_directory", tools), "list_directory");
  assert.equal(fuzzyResolveTool("read_fil", tools), "read_file");
  assert.equal(fuzzyResolveTool("mcp__srv__x", tools), null);
});

test("levenshtein 编辑距离", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("a", ""), 1);
  assert.equal(levenshtein("", "a"), 1);
});

test("runBounded: 有界并发且保持顺序", async () => {
  const order: number[] = [];
  const items = [1, 2, 3, 4, 5];
  const out = await runBounded(items, 2, async (n) => {
    order.push(n);
    return `r${n}`;
  });
  assert.deepEqual(out, ["r1", "r2", "r3", "r4", "r5"]);
  // 并发度 2：第 1、2 项先启动
  assert.deepEqual(order.slice(0, 2), [1, 2]);
});

test("withTimeout: 正常完成返回 value", async () => {
  const r = await withTimeout(Promise.resolve("ok"), 1000);
  assert.equal(r.timedOut, false);
  assert.equal(r.value, "ok");
});

test("withTimeout: 超时返回 timedOut，不抛 unhandledRejection", async () => {
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
  const r = await withTimeout(slow, 20);
  assert.equal(r.timedOut, true);
});

test("withTimeout: ms<=0 直接返回", async () => {
  const r = await withTimeout(Promise.resolve("v"), 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.value, "v");
});

test("TOOL_PARALLEL_LIMIT 常量存在且>0", () => {
  assert.ok(TOOL_PARALLEL_LIMIT > 0);
});

test("TOOL_OUTPUT_PREVIEW_CAP 统一执行层截断上限存在且合理", () => {
  assert.equal(TOOL_OUTPUT_PREVIEW_CAP, 8000);
});

// ── truncateToolResult（统一工具结果截断层，对齐 Codex output-truncation / Claude Code maxResultSizeChars）──

test("truncateToolResult: 短结果原样返回", () => {
  const r = truncateToolResult("hello world", 200_000);
  assert.equal(r, "hello world");
});

test("truncateToolResult: 恰好等于上限不截断", () => {
  const s = "x".repeat(200_000);
  assert.equal(truncateToolResult(s, 200_000), s);
});

test("truncateToolResult: 超长结果保留首尾并标注省略量", () => {
  const s = "A".repeat(100_000) + "MIDDLE" + "Z".repeat(100_000); // 200_011 字
  const out = truncateToolResult(s, 200_000, 80_000, 20_000);
  assert.notEqual(out, s);
  assert.ok(out.startsWith("A".repeat(80_000)));
  assert.ok(out.endsWith("Z".repeat(20_000)));
  assert.ok(out.includes("已从中间省略"));
  // 中间内容被折叠：MIDDLE 不应出现在结果中
  assert.ok(!out.includes("MIDDLE"));
});

test("truncateToolResult: 自定义阈值生效", () => {
  const s = "y".repeat(500);
  // 默认上限 200K 不截断；显式给 100 则截断
  assert.equal(truncateToolResult(s), s);
  const out = truncateToolResult(s, 100, 40, 10);
  assert.ok(out.includes("已从中间省略"));
});
