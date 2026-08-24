import test from "node:test";
import assert from "node:assert/strict";
import { BoundedMarkdownStream, boundedTextPreview, boundedUnknownText, boundedWindow, DESKTOP_UI_BUDGETS } from "../apps/desktop/src/ui-performance";
import { presentDesktopToolEvent } from "../apps/desktop/src/presentation-registry";
import { projectDesktopSessionUpdate } from "../apps/desktop/src/presentation";

/** U5 stress budgets are deliberately generous enough for shared CI while still catching unbounded algorithms. */
test("Desktop U5 bounded windows never mount more than the explicit conversation/trajectory budgets", () => {
  const conversation = boundedWindow(50_000, 49_999, DESKTOP_UI_BUDGETS.conversationWindow, 1_234);
  assert.ok(conversation.end - conversation.start <= DESKTOP_UI_BUDGETS.conversationWindow);
  assert.ok(conversation.start <= 1_234 && conversation.end > 1_234);

  const trajectory = boundedWindow(100_000, 99_999, DESKTOP_UI_BUDGETS.trajectoryWindow, 42_424);
  assert.ok(trajectory.end - trajectory.start <= DESKTOP_UI_BUDGETS.trajectoryWindow);
  assert.ok(trajectory.start <= 42_424 && trajectory.end > 42_424);
});

test("Desktop U5 incremental Markdown preserves every streamed character while keeping the mutable tail bounded", () => {
  const stream = new BoundedMarkdownStream(DESKTOP_UI_BUDGETS.streamTailChars);
  const chunks = Array.from({ length: 12_000 }, (_, index) => index % 19 === 0 ? `paragraph ${index}\n\n` : `token-${index} `);
  const source = chunks.join("");
  const committed: string[] = [];
  const started = Date.now();
  for (const chunk of chunks) {
    const step = stream.append(chunk);
    committed.push(...step.commits.map((fragment) => fragment.text));
    assert.ok(step.tail.length <= DESKTOP_UI_BUDGETS.streamTailChars, "mutable stream tail exceeded U5 budget");
  }
  const final = stream.finish(); committed.push(...final.commits.map((fragment) => fragment.text));
  assert.equal(committed.join(""), source);
  assert.ok(Date.now() - started < 2_000, "12k streaming chunks should stay within the U5 CPU stress budget");
});


test("Desktop U5 long fenced code keeps bounded tails and carries render context across forced cuts", () => {
  const stream = new BoundedMarkdownStream(128);
  const source = `\`\`\`ts\n${"const value = 1;\n".repeat(80)}\`\`\`\n`;
  const fragments = [];
  for (let offset = 0; offset < source.length; offset += 17) {
    const step = stream.append(source.slice(offset, offset + 17));
    fragments.push(...step.commits);
    assert.ok(step.tail.length <= 128);
  }
  fragments.push(...stream.finish().commits);
  assert.equal(fragments.map((fragment) => fragment.text).join(""), source);
  assert.ok(fragments.some((fragment) => fragment.startsInFence && fragment.fenceLanguage === "ts"), "forced code fragments must retain fence context");
});

test("Desktop U5 large unknown detail is previewed without eagerly serializing an unbounded structure", () => {
  const huge = { rows: Array.from({ length: 25_000 }, (_, index) => ({ index, payload: "x".repeat(200) })) };
  const started = Date.now();
  const preview = boundedUnknownText(huge, DESKTOP_UI_BUDGETS.trajectorySearchDetailChars);
  assert.ok(preview.text.length <= DESKTOP_UI_BUDGETS.trajectorySearchDetailChars);
  assert.equal(preview.truncated, true);
  assert.ok(Date.now() - started < 1_000, "bounded detail projection should not walk the entire huge payload");
  assert.deepEqual(boundedTextPreview("abc", 2), { text: "ab", truncated: true, omitted: 1 });
});

test("Desktop U5 structured tool inputs keep a bounded presentation preview and defer their full source", () => {
  const rawInput = { query: "needle", payload: "x".repeat(100_000) };
  const update = projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "u5-large", title: "future_tool", kind: "future", status: "in_progress", rawInput });
  const presentation = presentDesktopToolEvent(update as any);
  assert.ok((presentation.input?.text.length ?? 0) <= DESKTOP_UI_BUDGETS.toolBlockPreviewChars);
  assert.equal(presentation.input?.source, rawInput, "full structured input should be retained by reference for explicit expansion");
});
