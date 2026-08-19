import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMcpEnv } from "../src/mcp";

test("MCP stdio 默认不继承任意敏感环境变量，显式 cfg.env 才注入", () => {
  const old = process.env.FREESEEK_TEST_SECRET;
  process.env.FREESEEK_TEST_SECRET = "top-secret";
  try {
    const env = buildMcpEnv();
    assert.equal(env.FREESEEK_TEST_SECRET, undefined);
    const explicit = buildMcpEnv({ FREESEEK_TEST_SECRET: "explicit" });
    assert.equal(explicit.FREESEEK_TEST_SECRET, "explicit");
  } finally {
    if (old === undefined) delete process.env.FREESEEK_TEST_SECRET;
    else process.env.FREESEEK_TEST_SECRET = old;
  }
});
