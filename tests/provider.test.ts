import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChatWithIdleTimeout } from "../src/provider";
import { buildResolvedConfig, type ProviderConfig } from "../src/providers";
import type { ChatMessage, ToolDefinition, StreamHandlers } from "../src/provider";

const noTools: ToolDefinition[] = [];
const msgs: ChatMessage[] = [{ role: "system", content: "x" }];

/** 构造一个「永不吐字、直到被 abort」的 mock streamChat（模拟服务假死）。 */
function hangStream(): (...a: any[]) => Promise<any> {
  return async (_m: ChatMessage[], _t: ToolDefinition[], h: StreamHandlers) => {
    // 等到外部 signal abort 为止；abort 后抛错（模拟 fetch 被中断）
    await new Promise<void>((resolve, reject) => {
      const sig = h.signal;
      if (sig?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, 60_000);
      sig?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
    throw new Error("aborted");
  };
}

/** 构造一个「立即吐字并正常结束」的 mock streamChat。 */
function okStream(): (...a: any[]) => Promise<any> {
  return async (_m: ChatMessage[], _t: ToolDefinition[], h: StreamHandlers) => {
    h.onText?.("hello");
    h.onText?.(" world");
    return { message: { role: "assistant", content: "hello world" }, finishReason: "stop" };
  };
}



test("Provider authType=none: 不要求 API key，且不会生成 Authorization 头", () => {
  const provider: ProviderConfig = {
    id: "local-noauth",
    name: "Local No Auth",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
    authType: "none",
    format: "openai",
    models: [{ id: "local-model" }],
  };
  const cfg = buildResolvedConfig(provider, "local-model");
  assert.equal(cfg.authType, "none");
  assert.equal(cfg.apiKey, "");
  assert.equal(cfg.headers.authorization, undefined);
  assert.equal(cfg.headers["x-api-key"], undefined);
  assert.equal(cfg.headers["x-goog-api-key"], undefined);
});

test("streamChatWithIdleTimeout: 正常吐字不超时", async () => {
  const out = await streamChatWithIdleTimeout(50, msgs, noTools, {
    onText: () => {},
  }, undefined, undefined, okStream());
  assert.equal(out.message.content, "hello world");
  assert.equal(out.finishReason, "stop");
});

test("streamChatWithIdleTimeout: 长时间不吐字被看门狗中断并抛错", async () => {
  const before = Date.now();
  let threw = false;
  let name = "";
  try {
    await streamChatWithIdleTimeout(40, msgs, noTools, {
      onText: () => {},
    }, undefined, undefined, hangStream());
  } catch (e: any) {
    threw = true;
    name = e?.name ?? "";
  }
  const elapsed = Date.now() - before;
  assert.ok(threw, "应因 idle 超时被中断");
  assert.equal(name, "StreamIdleTimeoutError");
  // 中断发生在阈值附近（允许调度误差），远早于 60s 兜底
  assert.ok(elapsed < 2000, `中断应很快发生，实际 ${elapsed}ms`);
});

test("streamChatWithIdleTimeout: 外部 signal abort 不伪装成 idle 错误", async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 10);
  let threw = false;
  let name = "";
  try {
    await streamChatWithIdleTimeout(40, msgs, noTools, {
      onText: () => {},
      signal: ctrl.signal,
    }, undefined, undefined, hangStream());
  } catch (e: any) {
    threw = true;
    name = e?.name ?? "";
  }
  assert.ok(threw);
  assert.notEqual(name, "StreamIdleTimeoutError");
});
