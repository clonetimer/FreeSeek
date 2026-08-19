import { test } from "node:test";
import assert from "node:assert/strict";
import { planSandbox, detectOsSandbox, resolveExecPolicy,
  runCommand
} from "../src/sandbox";

test("planSandbox: off 档永不阻塞、不启用 OS 沙箱", () => {
  const plan = planSandbox("off");
  assert.equal(plan.mode, "off");
  assert.equal(plan.osSandboxed, false);
  assert.equal(plan.blocked, false);
  assert.equal(plan.engine, "none");
});

test("planSandbox: sandbox 档在无引擎平台 blocked（failIfUnavailable）", () => {
  const plan = planSandbox("sandbox", true);
  if (process.platform === "win32" || process.platform === "linux") {
    // Windows 无 seatbelt；Linux 可能无 bwrap——两种都可能 blocked
    if (plan.engine === "none") {
      assert.equal(plan.blocked, true);
      assert.ok(plan.blockedReason);
    }
  }
});

test("planSandbox: sandbox 档软降级（failIfUnavailable=false）返回 warning 而非 blocked", () => {
  const plan = planSandbox("sandbox", false);
  assert.equal(typeof plan.osSandboxed, "boolean");
  if (!plan.osSandboxed) {
    assert.equal(plan.blocked, false);
    assert.ok(plan.warning, "软降级应给出 warning 提示");
  }
});

test("detectOsSandbox: 返回值结构完整", () => {
  const r = detectOsSandbox();
  assert.ok(["seatbelt", "bwrap", "none"].includes(r.engine));
  assert.equal(typeof r.available, "boolean");
});

// ── 执行策略层（对标 Codex execpolicy：把执行策略收敛为可审计独立配置层）──

test("resolveExecPolicy: 最小输入填默认值，结构完整", () => {
  const p = resolveExecPolicy({ sandboxMode: "off" });
  assert.equal(p.sandboxMode, "off");
  assert.equal(p.sandboxFailIfUnavailable, false);
  assert.equal(p.network.mode, "off");
  assert.deepEqual(p.network.allowedDomains, []);
  assert.equal(p.network.allowLocalBinding, true);
  assert.equal(p.allowShell, true);
});

test("resolveExecPolicy: 部分覆盖生效、network 子字段补全", () => {
  const p = resolveExecPolicy({
    sandboxMode: "sandbox",
    sandboxFailIfUnavailable: true,
    allowShell: false,
    network: { mode: "localhost", allowedDomains: ["api.x.com"] },
  });
  assert.equal(p.sandboxFailIfUnavailable, true);
  assert.equal(p.allowShell, false);
  assert.equal(p.network.mode, "localhost");
  assert.deepEqual(p.network.allowedDomains, ["api.x.com"]);
  assert.equal(p.network.allowLocalBinding, true); // 默认补全
});


test("runCommand: input 会真实写入子进程 stdin", async (t) => {
  if (process.platform === "win32") { t.skip("Windows shell 行为不同"); return; }
  const out = await runCommand({
    cwd: process.cwd(),
    command: "cat",
    argv: ["/bin/cat"],
    timeoutMs: 2000,
    input: "hello-stdin\n",
  });
  assert.match(out, /exit 0/);
  assert.match(out, /hello-stdin/);
});

test("runCommand: AbortSignal 会终止底层子进程", async () => {
  const ctrl = new AbortController();
  const started = Date.now();
  const promise = runCommand({
    cwd: process.cwd(),
    command: "node sleep",
    argv: [process.execPath, "-e", "setTimeout(()=>{}, 10000)"],
    timeoutMs: 15000,
    signal: ctrl.signal,
  });
  setTimeout(() => ctrl.abort(), 30);
  const out = await promise;
  assert.match(out, /已取消|终止|aborted|Abort/i);
  assert.ok(Date.now() - started < 2000, `取消耗时过长：${Date.now() - started}ms`);
});
