/** CLI host interaction regression tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCliHostCapabilities } from "../src/hosts/cli/capabilities";
import { createCliInteractionService } from "../src/hosts/cli/interaction";

test("CLI remains fail-closed by default", async () => {
  const service = createCliInteractionService(createCliHostCapabilities(false), {
    prompt: async () => "yes",
  });
  await assert.rejects(() => service.askUser({ question: "Continue?" }), /does not support interactive ask_user/);
  await assert.rejects(() => service.requestPermission("write_file"), /does not support interactive permission prompt/);
  await assert.rejects(() => service.requestMcpPermission("mcp__demo__read", "read demo"), /does not support MCP tool access/);
});

test("interactive CLI maps numbered answers and explicit approvals", async () => {
  const answers = ["2", "y", "o", "a"];

  const prompts: string[] = [];
  const service = createCliInteractionService(createCliHostCapabilities({ interactive: true, mcp: true }), {
    prompt: async (text) => {
      prompts.push(text);
      return answers.shift() ?? "";
    },
  });
  const answer = await service.askUser({
    question: "Choose mode",
    options: [{ label: "safe" }, { label: "fast" }],
  });
  assert.equal(answer, "fast");
  const approval = await service.requestPermission("write_file");
  assert.deepEqual(approval, { allow: true, reason: "approved by CLI user" });
  assert.equal(await service.requestMcpPermission("mcp__demo__read", "read demo"), "once");
  assert.equal(await service.requestMcpPermission("mcp__demo__read", "read demo"), "allow");
  assert.match(prompts[0], /Choose mode/);
  assert.match(prompts[1], /write_file/);
  assert.match(prompts[2], /mcp__demo__read/);
});
