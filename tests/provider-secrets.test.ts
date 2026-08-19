import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cachedProviderSecret,
  deleteProviderSecret,
  storeProviderSecret,
} from "../src/provider-secrets";

test("Provider 明文凭据写入 SecretStorage，配置只返回 secret 引用", async () => {
  const stored = new Map<string, string>();
  const context = {
    secrets: {
      store: async (key: string, value: string) => { stored.set(key, value); },
      get: async (key: string) => stored.get(key),
      delete: async (key: string) => { stored.delete(key); },
    },
  } as any;

  const ref = await storeProviderSecret(context, "demo", "super-secret");
  assert.equal(ref, "${secret:freesek.provider.demo.apiKey}");
  assert.equal(stored.get("freesek.provider.demo.apiKey"), "super-secret");
  assert.equal(cachedProviderSecret("freesek.provider.demo.apiKey"), "super-secret");

  await deleteProviderSecret(context, "demo");
  assert.equal(stored.has("freesek.provider.demo.apiKey"), false);
  assert.equal(cachedProviderSecret("freesek.provider.demo.apiKey"), "");
});

test("Provider 环境变量引用不会被复制进 SecretStorage", async () => {
  let stores = 0;
  const context = {
    secrets: {
      store: async () => { stores++; },
      get: async () => undefined,
      delete: async () => {},
    },
  } as any;
  const ref = await storeProviderSecret(context, "env-demo", "${env:MODEL_KEY}");
  assert.equal(ref, "${env:MODEL_KEY}");
  assert.equal(stores, 0);
});
