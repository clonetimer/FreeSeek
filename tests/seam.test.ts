import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import { LocalCommandRunner, getCommandRunner, setCommandRunner, resetCommandRunner } from "../src/seam";

function fakeExec() {
  return {
    plan: { mode: "off" as const, osSandboxed: false, engine: "none" as const, blocked: false },
    osEngine: undefined,
    restricted: false,
  };
}

test("LocalCommandRunner: 执行成功返回输出", async () => {
  const r = await LocalCommandRunner.run({
    cwd: os.tmpdir(),
    command: "node -p 1+1",
    timeoutMs: 10000,
    exec: fakeExec(),
    network: { mode: "off" },
    label: "test",
  });
  assert.ok(r.includes("2"), r);
});

test("LocalCommandRunner: 非零退出返回失败文本而非抛异常", async () => {
  const r = await LocalCommandRunner.run({
    cwd: os.tmpdir(),
    command: "node -e process.exit(3)",
    timeoutMs: 10000,
    exec: fakeExec(),
    network: { mode: "off" },
    label: "test",
  });
  assert.ok(r.includes("exit") || r.includes("失败"), r);
});

test("seam 注册表: 替换 Provider 后消费方无感切换", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  setCommandRunner({
    run: async (input) => {
      calls.push({ command: input.command, cwd: input.cwd });
      return `FAKE:${input.command}`;
    },
  });
  try {
    const r = await getCommandRunner().run({
      cwd: "/tmp",
      command: "echo x",
      timeoutMs: 1000,
      exec: fakeExec(),
      network: { mode: "off" },
    });
    assert.equal(r, "FAKE:echo x");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, "/tmp");
  } finally {
    resetCommandRunner();
  }
  assert.equal(getCommandRunner(), LocalCommandRunner, "reset 后应恢复默认 Provider");
});