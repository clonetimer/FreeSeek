import { test } from "node:test";
import { buildResponsesInput } from "../src/provider-responses";
import assert from "node:assert/strict";
import { estimateTokens, conversationTokens, usageRatio, tieredCompact, BudgetTracker } from "../src/context";
import type { ChatMessage } from "../src/provider";

test("estimateTokens: CJK 约 1.5 token/字，其它约 4 字符/token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("中文测试"), 6); // 4 * 1.5
  assert.equal(estimateTokens("a".repeat(100)), 25);
});

test("conversationTokens includes archived Responses output state", () => {
  const withoutState: ChatMessage[] = [{ role: "assistant", content: "" }];
  const withState: ChatMessage[] = [{
    role: "assistant",
    content: "",
    responses_output_items: [{
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "x".repeat(1200),
    }],
  }];
  assert.ok(conversationTokens(withState) > conversationTokens(withoutState));
});

test("conversationTokens: 每条消息 +4 固定开销", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "abcd" },
    { role: "assistant", content: "中文测试" },
  ];
  assert.equal(conversationTokens(msgs), (1 + 4) + (6 + 4));
});

test("usageRatio: 预算非正返回 0", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "abcd" }];
  assert.equal(usageRatio(msgs, 0), 0);
  assert.equal(usageRatio(msgs, -5), 0);
  assert.equal(usageRatio(msgs, 10), 0.5); // 5 token / 10
});

test("tieredCompact: 未超阈值原样返回", async () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
  ];
  const out = await tieredCompact(msgs, undefined, 12, 16);
  assert.equal(out, msgs);
});

test("tieredCompact: 超阈值触发分级压缩", async () => {
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: "user", content: `msg-${i}` });
  }
  let summaryEmitted = "";
  let oldSeen = "";
  const out = await tieredCompact(msgs, (s) => (summaryEmitted = s), 12, 16, async (old) => { oldSeen = old; });
  // 触发压缩：conv=30 > 12+16
  assert.ok(out.length < msgs.length);
  assert.ok(summaryEmitted.includes("早期对话摘要"));
  assert.ok(oldSeen.includes("msg-0")); // 最早的旧消息交给记忆抽取
  // system 消息保留在头部
  assert.equal(out[0].role, "system");
  // 最近 keepRecent 条原文保留
  assert.ok(out.some((m) => m.role === "user" && m.content === "msg-29"));
  assert.ok(out.some((m) => m.role === "user" && m.content === "msg-20"));
});

test("tieredCompact: 中间带工具消息被瘦身为事实标记", async () => {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 30; i++) {
    if (i === 9) {
      // 前置 assistant 声明 tool_calls，保证 tool/tool_calls 配对合法（sanitizeToolSequence 不误删）
      msgs.push({
        role: "assistant",
        content: "调用工具",
        tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      } as ChatMessage);
    } else if (i === 10) {
      msgs.push({
        role: "tool",
        tool_call_id: "t1",
        name: "read_file",
        content: 'name="read_file" 输出...',
      } as ChatMessage);
    } else {
      msgs.push({ role: "user", content: `m${i}` });
    }
  }
  const out = await tieredCompact(msgs, undefined, 12, 16);
  // 第 9/10 条在 rest 中部（rest = 前 18 条，stripBand 取后 16，即 index 2..17 → 含 index 9/10）
  const toolMsg = out.find((m) => m.role === "tool");
  assert.ok(toolMsg, "工具消息应保留为事实标记");
  assert.ok((toolMsg.content as string).includes("结果已在分级压缩中省略"));
});

test("BudgetTracker: 轮次上限", () => {
  const t = new BudgetTracker({ maxTurns: 3, maxTokens: 0, maxWallClockMs: 60_000 });
  const [stop, msg] = t.check(3, 0);
  assert.equal(stop, true);
  assert.ok(msg!.includes("最大轮次"));
});

test("BudgetTracker: token 上限", () => {
  const t = new BudgetTracker({ maxTurns: 100, maxTokens: 50, maxWallClockMs: 60_000 });
  const [stop, msg] = t.check(1, 60);
  assert.equal(stop, true);
  assert.ok(msg!.includes("token"));
});

test("BudgetTracker: 墙钟上限", () => {
  const t = new BudgetTracker({ maxTurns: 100, maxTokens: 0, maxWallClockMs: 0 });
  const [stop, msg] = t.check(0, 0);
  assert.equal(stop, true);
  assert.ok(msg!.includes("墙钟"));
});

test("BudgetTracker: 未达上限不停止", () => {
  const t = new BudgetTracker({ maxTurns: 10, maxTokens: 1000, maxWallClockMs: 60_000 });
  const [stop, msg] = t.check(2, 100);
  assert.equal(stop, false);
  assert.equal(msg, null);
});

test("tieredCompact preserves stateless Responses reasoning items from summarized history", async () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_archived",
    encrypted_content: "opaque-encrypted-state",
  };
  const messages: any[] = [
    { role: "user", content: "old prompt" },
    {
      role: "assistant",
      content: "old answer",
      responses_output_items: [reasoning, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "old answer" }],
      }],
    },
    { role: "user", content: "middle prompt" },
    { role: "assistant", content: "middle answer" },
    { role: "user", content: "recent prompt" },
  ];
  const compacted = await tieredCompact(messages, undefined, 2, 1);
  const archived = compacted.find((message) =>
    message.role === "assistant" &&
    message.responses_output_items?.some((item: any) => item?.id === "rs_archived")
  );
  assert.ok(archived, "archived reasoning state must survive compaction");
  const input = buildResponsesInput(compacted);
  assert.ok(input.some((item: any) =>
    item.type === "reasoning" && item.encrypted_content === "opaque-encrypted-state"
  ));
  assert.ok(compacted.some((message) =>
    message.role === "system" && message.content.includes("早期对话摘要")
  ));
});

