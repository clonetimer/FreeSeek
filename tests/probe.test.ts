import { test } from "node:test";
import assert from "node:assert/strict";
import { probeModelList } from "../src/providers";

/** 用本地假 fetch 替换全局 fetch，断言请求 URL 与返回。 */
function withFetch(handler: (url: string, init: any) => any) {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = (url: string, init: any) => handler(url, init);
  return () => { (globalThis as any).fetch = orig; };
}

function okModels() {
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: [{ id: "deepseek-chat" }, "deepseek-reasoner"] }) };
}
function status(s: number, text = "") {
  return { ok: false, status: s, statusText: text, json: async () => ({}) };
}

test("probeModelList: 带 /v1 的 base 只探测一个候选路径", async () => {
  const seen: string[] = [];
  const restore = withFetch((url) => { seen.push(url); return okModels(); });
  try {
    const r = await probeModelList("https://api.deepseek.com/v1", "sk-x", { mode: "test" });
    assert.deepEqual(r.models, ["deepseek-chat", "deepseek-reasoner"]);
    assert.deepEqual(seen, ["https://api.deepseek.com/v1/models"]);
  } finally { restore(); }
});

test("probeModelList: 不带 /v1 时，首个候选非 404 也要重试到 /v1/models", async () => {
  const seen: string[] = [];
  const restore = withFetch((url) => {
    seen.push(url);
    // 第一个候选 /models 返回 405（路径存在但方法/路径不对），应继续重试
    if (url.endsWith("/models") && !url.endsWith("/v1/models")) return status(405);
    return okModels();
  });
  try {
    const r = await probeModelList("https://api.deepseek.com", "sk-x", { mode: "test" });
    assert.deepEqual(r.models, ["deepseek-chat", "deepseek-reasoner"]);
    assert.deepEqual(seen, ["https://api.deepseek.com/models", "https://api.deepseek.com/v1/models"]);
  } finally { restore(); }
});

test("probeModelList: 401 立即定论，不重试", async () => {
  const seen: string[] = [];
  const restore = withFetch((url) => { seen.push(url); return status(401, "Unauthorized"); });
  try {
    const r = await probeModelList("https://api.deepseek.com/v1", "bad", { mode: "test" });
    assert.match(r.error ?? "", /401/);
    assert.equal(seen.length, 1);
  } finally { restore(); }
});

test("probeModelList: 所有候选都失败时汇总错误", async () => {
  const restore = withFetch(() => status(500, "Server Error"));
  try {
    const r = await probeModelList("https://api.deepseek.com", "sk-x", { mode: "test" });
    assert.ok(r.error);
    assert.match(r.error ?? "", /500/);
  } finally { restore(); }
});
