import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_OFFICIAL_BASE_URL,
  DEEPSEEK_OFFICIAL_MODELS,
  DEEPSEEK_PRO_MODEL,
} from "../src/deepseek";
import { stripUndefined, type ChatMessage } from "../src/provider";
import { messageForEventLog } from "../src/eventlog";
import { estimateCost } from "../src/pricing";

test("DeepSeek official defaults use current V4 endpoint/model ids", () => {
  assert.equal(DEEPSEEK_OFFICIAL_BASE_URL, "https://api.deepseek.com");
  assert.equal(DEEPSEEK_DEFAULT_MODEL, "deepseek-v4-flash");
  assert.equal(DEEPSEEK_PRO_MODEL, "deepseek-v4-pro");
  assert.deepEqual([...DEEPSEEK_OFFICIAL_MODELS], ["deepseek-v4-flash", "deepseek-v4-pro"]);

  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
  const props = pkg.contributes.configuration.properties;
  const official = props["freesek.providers"].default.find((row: any) => row.id === "deepseek-official");
  assert.equal(official.baseUrl, DEEPSEEK_OFFICIAL_BASE_URL);
  assert.deepEqual(official.models.map((row: any) => row.id), [...DEEPSEEK_OFFICIAL_MODELS]);
  assert.equal(props["freesek.officialBaseUrl"].default, DEEPSEEK_OFFICIAL_BASE_URL);
  assert.equal(props["freesek.officialModel"].default, DEEPSEEK_DEFAULT_MODEL);
});

test("DeepSeek thinking tool-call reasoning_content survives request + durable event", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "",
    reasoning_content: "inspect candidate before edit",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } }],
  };
  const wire = stripUndefined(message);
  assert.equal(wire.reasoning_content, message.reasoning_content);
  assert.deepEqual(wire.tool_calls, message.tool_calls);

  const logged = messageForEventLog(message);
  assert.equal(logged.message.reasoning_content, message.reasoning_content);
  assert.deepEqual(logged.message.tool_calls, message.tool_calls);
  assert.equal(logged.replayable, true);
});

test("DeepSeek V4 cost estimator has current model entries", () => {
  assert.ok(Math.abs(estimateCost("deepseek-v4-flash", 1_000_000, 1_000_000) - 0.42) < 1e-9);
  assert.ok(Math.abs(estimateCost("deepseek-v4-pro", 1_000_000, 1_000_000) - 1.305) < 1e-9);
});
