import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolSequence } from "../src/context";
import type { ChatMessage } from "../src/provider";

const asst = (toolIds: string[], content = "thinking"): ChatMessage =>
  toolIds.length
    ? {
        role: "assistant",
        content,
        tool_calls: toolIds.map((id) => ({
          id,
          type: "function" as const,
          function: { name: "f", arguments: "{}" },
        })),
      }
    : { role: "assistant", content };

const tool = (id: string): ChatMessage => ({ role: "tool", tool_call_id: id, content: "result" });
const user = (text = "hi"): ChatMessage => ({ role: "user", content: text });

test("sanitizeToolSequence: 合法配对原样保留", () => {
  const msgs = [user(), asst(["x"]), tool("x"), user("more")];
  const out = sanitizeToolSequence(msgs);
  assert.equal(out.length, 4);
  assert.ok(out.some((m) => m.role === "tool" && m.tool_call_id === "x"));
});

test("sanitizeToolSequence: 孤立 tool 被丢弃（压缩把 assistant 摘要掉的场景）", () => {
  // 压缩边界破坏：assistant(tool_calls x) 被摘要进 old 段，tool(x) 留在 middle → 孤立 tool
  const broken: ChatMessage[] = [user(), tool("x"), asst(["y"]), tool("y"), user()];
  const out = sanitizeToolSequence(broken);
  assert.ok(!out.some((m) => m.role === "tool" && m.tool_call_id === "x"), "孤立 tool(x) 应被丢弃");
  assert.ok(out.some((m) => m.role === "tool" && m.tool_call_id === "y"), "配对完好的 tool(y) 应保留");
});

test("sanitizeToolSequence: 结尾未闭合的 assistant.tool_calls 移除 tool_calls 保留文本", () => {
  const out = sanitizeToolSequence([user(), asst(["x"], "思考文本")]);
  const last = out[out.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.content, "思考文本");
  assert.equal(last.tool_calls, undefined);
});

test("sanitizeToolSequence: user 打断未闭合配对时移除 tool_calls", () => {
  const out = sanitizeToolSequence([asst(["x"]), user("打断"), tool("x")]);
  assert.equal(out[0].tool_calls, undefined);
  assert.equal(out.length, 2); // 打断后 tool(x) 无前置可匹配 → 也丢弃
});

test("sanitizeToolSequence: 多轮交错配对只消费对应 id", () => {
  const msgs = [asst(["a", "b"]), tool("a"), tool("b"), asst(["c"]), tool("c"), user()];
  const out = sanitizeToolSequence(msgs);
  assert.equal(out.length, 6);
});