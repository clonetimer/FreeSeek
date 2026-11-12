import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildResponsesBody,
  buildResponsesInput,
  buildResponsesTools,
  completeResponsesText,
  streamResponses,
} from "../src/provider-responses";
import { buildChatBody, type ChatMessage, type ToolDefinition } from "../src/provider";
import { buildResolvedConfig, getModelCapabilities, type ProviderConfig } from "../src/providers";
import { messageForEventLog } from "../src/eventlog";

const tool: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a workspace file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, optional: { type: "string" } },
      required: ["path"],
    },
  },
};

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "openai-responses-test",
    name: "OpenAI Responses Test",
    baseUrl: "http://127.0.0.1:0/v1",
    apiKey: "test-key",
    authType: "bearer",
    format: "responses",
    toolMode: "native",
    models: [{ id: "gpt-6.1-sol" }],
    ...overrides,
  };
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/v1/responses`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sse(res: http.ServerResponse, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

test("Responses input preserves raw output items and encrypted reasoning in original order", () => {
  const rawItems = [
    { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-reasoning" },
    { type: "message", id: "msg_1", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Inspecting." }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
  ];
  const input = buildResponsesInput([
    { role: "user", content: "Inspect the project." },
    {
      role: "assistant",
      content: "Inspecting.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
      responses_output_items: rawItems,
    },
    { role: "tool", tool_call_id: "call_1", content: "README contents" },
  ]);
  assert.equal(input[0].role, "user");
  assert.deepEqual(input.slice(1, 4), rawItems);
  assert.deepEqual(input[4], {
    type: "function_call_output",
    call_id: "call_1",
    output: "README contents",
  });
});

test("Responses input maps legacy Chat Completions tool messages and image content", () => {
  const input = buildResponsesInput([
    { role: "assistant", content: "", tool_calls: [{ id: "call_legacy", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
    { role: "tool", tool_call_id: "call_legacy", content: "legacy tool result" },
    { role: "user", content: "What is in this picture?", images: ["data:image/png;base64,AAAA"] },
  ]);
  assert.deepEqual(input[0], { type: "function_call", call_id: "call_legacy", name: "read_file", arguments: '{"path":"a"}' });
  assert.deepEqual(input[1], { type: "function_call_output", call_id: "call_legacy", output: "legacy tool result" });
  assert.deepEqual(input[2], {
    role: "user",
    content: [
      { type: "input_text", text: "What is in this picture?" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
    ],
  });
});

test("Responses tools use top-level function schema and retain non-strict optional properties", () => {
  const mapped = buildResponsesTools([tool]);
  assert.deepEqual(mapped[0], {
    type: "function",
    name: "read_file",
    description: "Read a workspace file",
    parameters: tool.function.parameters,
    strict: false,
  });
});

test("Responses rejects images when declared input modalities exclude image", () => {
  const cfg = buildResolvedConfig(provider({
    capabilities: { inputModalities: ["text"] },
  }), "gpt-6.1-sol");
  assert.throws(
    () => buildResponsesBody(cfg, [{ role: "user", content: "Describe this.", images: ["data:image/png;base64,AAAA"] }], []),
    /without image-input capability/
  );
});

test("Responses request defaults to stateless storage and maps max_tokens to max_output_tokens", () => {
  const cfg = buildResolvedConfig(provider({
    capabilities: { reasoning: true },
    extraBody: {
      max_tokens: 8192,
      previous_response_id: "must-not-leak",
      conversation: "must-not-leak",
      temperature: 0.3,
    },
  }), "gpt-6.1-sol");
  const body = buildResponsesBody(cfg, [{ role: "user", content: "hello" }], [tool]);
  assert.equal(cfg.endpoint, "http://127.0.0.1:0/v1/responses");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, 8192);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.conversation, undefined);
  assert.equal(body.messages, undefined);
  assert.equal(body.stream_options, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal((body.tools as any[])[0].strict, false);
});

test("Responses leaves reasoning encryption unknown unless capability is declared", () => {
  const cfg = buildResolvedConfig(provider(), "custom-responses-model");
  const body = buildResponsesBody(cfg, [{ role: "user", content: "hello" }], []);
  assert.deepEqual(body.include, []);
});

test("Responses omits encrypted reasoning include for models explicitly without reasoning", () => {
  const cfg = buildResolvedConfig(provider({ capabilities: { reasoning: false } }), "gpt-6.1-sol");
  const body = buildResponsesBody(cfg, [{ role: "user", content: "hello" }], []);
  assert.deepEqual(body.include, []);
});

test("Responses maps Chat Completions response_format to text.format", () => {
  const cfg = buildResolvedConfig(provider({
    extraBody: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "project_summary",
          strict: true,
          schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
        },
      },
    },
  }), "gpt-6.1-sol");
  const body = buildResponsesBody(cfg, [{ role: "user", content: "Summarize." }], []);
  assert.deepEqual(body.text, {
    format: {
      type: "json_schema",
      name: "project_summary",
      strict: true,
      schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
    },
  });
  assert.equal(body.response_format, undefined);
});

test("Responses rejects structured output when the model explicitly lacks support", () => {
  const cfg = buildResolvedConfig(provider({
    capabilities: { structuredOutput: false },
    extraBody: { response_format: { type: "json_object" } },
  }), "gpt-6.1-sol");
  assert.throws(
    () => buildResponsesBody(cfg, [{ role: "user", content: "Return JSON." }], []),
    /without structured-output capability/
  );
});

test("Responses server-side storage requires explicit provider opt-in", () => {
  const cfg = buildResolvedConfig(provider({ storeResponses: true }), "gpt-6.1-sol");
  const body = buildResponsesBody(cfg, [{ role: "user", content: "hello" }], []);
  assert.equal(body.store, true);
});

test("Responses capabilities merge provider defaults with model overrides; unknown remains unknown", () => {
  const cfg = buildResolvedConfig(provider({
    capabilities: { tools: true, vision: true, contextWindow: 500_000 },
    models: [
      { id: "gpt-6.1-sol", capabilities: { tools: false, maxOutputTokens: 64_000 } },
    ],
  }), "gpt-6.1-sol");
  assert.equal(cfg.capabilities.tools, false);
  assert.equal(cfg.capabilities.vision, true);
  assert.equal(cfg.capabilities.contextWindow, 500_000);
  assert.equal(cfg.capabilities.maxOutputTokens, 64_000);
  assert.deepEqual(getModelCapabilities(provider({ models: [{ id: "unknown-model" }] }), "unknown-model"), {});
});

test("Chat Completions honors explicit model capability that disables native tools", () => {
  const cfg = buildResolvedConfig(provider({
    format: "openai",
    capabilities: { tools: false },
  }), "gpt-6.1-sol");
  const body = buildChatBody(cfg, [{ role: "user", content: "hello" }], [tool]);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test("Responses streaming parses text, reasoning, function calls, encrypted output items and usage", async () => {
  let requestBody: any;
  let auth = "";
  const server = http.createServer(async (req, res) => {
    requestBody = await readBody(req);
    auth = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
    sse(res, { type: "response.created", response: { id: "resp_1", status: "in_progress" } });
    sse(res, { type: "response.output_text.delta", delta: "Reading " });
    sse(res, { type: "response.output_text.delta", delta: "the file." });
    sse(res, { type: "response.reasoning_summary_text.delta", delta: "I should inspect the file first." });
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" };
    const message = { type: "message", id: "msg_1", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading the file." }] };
    const functionCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' };
    sse(res, { type: "response.output_item.done", output_index: 0, item: reasoning });
    sse(res, { type: "response.output_item.done", output_index: 1, item: message });
    sse(res, { type: "response.output_item.done", output_index: 2, item: functionCall });
    sse(res, {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [reasoning, message, functionCall],
        usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165 },
      },
    });
    res.end("data: [DONE]\n\n");
  });
  const endpoint = await listen(server);
  const cfg = buildResolvedConfig(provider({
    baseUrl: endpoint.slice(0, -"/responses".length),
    capabilities: { reasoning: true },
  }), "gpt-6.1-sol");
  const text: string[] = [];
  const reasoning: string[] = [];
  const calls: any[] = [];
  const usage: any[] = [];
  try {
    const result = await streamResponses(cfg, [{ role: "user", content: "Read README." }], [tool], {
      onText: (delta) => text.push(delta),
      onReasoning: (delta) => reasoning.push(delta),
      onToolCalls: (items) => calls.push(...items),
      onUsage: (value) => usage.push(value),
    });
    assert.equal(auth, "Bearer test-key");
    assert.equal(requestBody.store, false);
    assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
    assert.equal(requestBody.input[0].content, "Read README.");
    assert.equal(text.join(""), "Reading the file.");
    assert.equal(reasoning.join(""), "I should inspect the file first.");
    assert.deepEqual(calls, [{
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' },
    }]);
    assert.deepEqual(usage, [{ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 }]);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.message.responses_phase, "commentary");
    assert.equal((result.message.responses_output_items?.[0] as any).encrypted_content, "encrypted-state");
    assert.equal(result.message.tool_calls?.[0].id, "call_1");
  } finally {
    await close(server);
  }
});

test("Responses non-streaming helper reads output_text and keeps storage disabled", async () => {
  let requestBody: any;
  const server = http.createServer(async (req, res) => {
    requestBody = await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "resp_aux",
      status: "completed",
      output_text: "## Summary\nA compact summary.",
      output: [],
    }));
  });
  const endpoint = await listen(server);
  const cfg = buildResolvedConfig(provider({ baseUrl: endpoint.slice(0, -"/responses".length) }), "gpt-6.1-sol");
  try {
    const result = await completeResponsesText(cfg, [
      { role: "system", content: "Summarize." },
      { role: "user", content: "Conversation history." },
    ], { temperature: 0.2 });
    assert.equal(result, "## Summary\nA compact summary.");
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.stream, false);
    assert.equal(requestBody.temperature, undefined);
    assert.equal(requestBody.input[0].role, "system");
  } finally {
    await close(server);
  }
});

test("Responses abort signal cancels an in-flight stream request", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}\n\n");
  });
  const endpoint = await listen(server);
  const cfg = buildResolvedConfig(provider({ baseUrl: endpoint.slice(0, -"/responses".length) }), "gpt-6.1-sol");
  const controller = new AbortController();
  try {
    const pending = streamResponses(cfg, [{ role: "user", content: "wait" }], [], {
      onText: () => {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => pending, /abort|Abort/i);
  } finally {
    await close(server);
  }
});

test("Responses assistant state is preserved by local EventLog message projection", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "Done.",
    responses_phase: "final_answer",
    responses_output_items: [
      { type: "reasoning", id: "rs_1", encrypted_content: "local-encrypted-state" },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
    ],
  };
  const logged = messageForEventLog(message);
  assert.equal(logged.replayable, true);
  assert.equal(logged.message.responses_phase, "final_answer");
  assert.deepEqual(logged.message.responses_output_items, message.responses_output_items);
});

test("Responses stream reconstructs incomplete output items when final response omits output", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const message = {
      type: "message",
      id: "msg_partial",
      role: "assistant",
      content: [{ type: "output_text", text: "Partial answer" }],
    };
    const call = {
      type: "function_call",
      id: "fc_partial",
      call_id: "call_partial",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    };
    sse(res, { type: "response.output_item.done", output_index: 0, item: message });
    sse(res, { type: "response.output_item.done", output_index: 1, item: call });
    sse(res, {
      type: "response.incomplete",
      response: {
        id: "resp_partial",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      },
    });
    res.end();
  });
  const endpoint = await listen(server);
  const cfg = buildResolvedConfig(provider({ baseUrl: endpoint.slice(0, -"/responses".length) }), "gpt-6.1-sol");
  const streamedText: string[] = [];
  try {
    const result = await streamResponses(cfg, [{ role: "user", content: "Read README." }], [tool], {
      onText: (delta) => streamedText.push(delta),
    });
    assert.equal(result.finishReason, "length");
    assert.equal(result.message.content, "Partial answer");
    assert.deepEqual(streamedText, ["Partial answer"]);
    assert.equal(result.message.tool_calls?.[0].id, "call_partial");
    assert.equal((result.message.responses_output_items?.[0] as any).id, "msg_partial");
  } finally {
    await close(server);
  }
});

test("Responses stream surfaces structured errors from SSE error events", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, {
      type: "error",
      error: { message: "model is not available for this project", code: "model_not_found" },
    });
    res.end();
  });
  const endpoint = await listen(server);
  const cfg = buildResolvedConfig(provider({ baseUrl: endpoint.slice(0, -"/responses".length) }), "missing-model");
  try {
    await assert.rejects(
      () => streamResponses(cfg, [{ role: "user", content: "hello" }], [], { onText: () => {} }),
      (error: any) => {
        assert.match(error.message, /model is not available for this project/);
        assert.equal(error.code, "model_not_found");
        return true;
      }
    );
  } finally {
    await close(server);
  }
});

