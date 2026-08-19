import { test } from "node:test";
import assert from "node:assert/strict";
import { needsTodoNudge, TODO_NUDGE_MESSAGE } from "../src/agent-utils";

test("needsTodoNudge: 单条进行中种子 + ≥2 步 → true", () => {
  assert.equal(needsTodoNudge([{ content: "整条需求", status: "in_progress" }], 2), true);
  assert.equal(needsTodoNudge([{ content: "整条需求", status: "in_progress" }], 5), true);
});

test("needsTodoNudge: 模型已分解（多条）→ false", () => {
  const items = [
    { content: "理解", status: "in_progress" },
    { content: "实现", status: "pending" },
    { content: "验证", status: "pending" },
  ];
  assert.equal(needsTodoNudge(items, 3), false);
});

test("needsTodoNudge: 步数不足 / 非进行中 / 空列表 → false", () => {
  assert.equal(needsTodoNudge([{ content: "x", status: "in_progress" }], 1), false);
  assert.equal(needsTodoNudge([{ content: "x", status: "completed" }], 3), false);
  assert.equal(needsTodoNudge([], 3), false);
});

test("TODO_NUDGE_MESSAGE: 明确要求分解 ≥2 步且经 todo_write", () => {
  assert.ok(TODO_NUDGE_MESSAGE.includes("todo_write"));
  assert.ok(TODO_NUDGE_MESSAGE.includes("≥2"));
  assert.ok(TODO_NUDGE_MESSAGE.includes("单一任务项"));
});