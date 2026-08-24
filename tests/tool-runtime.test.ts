/**
 * Unified Tool Runtime 回归：所有工具调用必须先过 ToolRegistry + 同一条 policy / approval / hook / cancel 管线。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRuntime, type ToolRuntimeCallbacks } from "../src/tool-runtime";
import { ToolRegistry, type ToolExecutorOverrides } from "../src/tool-registry";
import { BUILTIN_TOOL_RUNTIME_SPECS, getToolRuntimeSpec } from "../src/tool-runtime-spec";
import { TOOL_DEFINITIONS } from "../src/tools/defs";
import type { ToolDefinition } from "../src/provider";
import { ExtensionRuntime } from "../src/kernel/extensions/runtime";

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fs-runtime-"));
}

function ctx(workspaceRoot: string, extra: Record<string, unknown> = {}): any {
  return {
    workspaceRoot,
    allowShell: true,
    allowNetwork: true,
    askUser: async () => "ok",
    todoState: { items: [] },
    agentMode: "craft",
    sandboxMode: "off",
    ...extra,
  };
}

function dynamicDef(name: string): ToolDefinition {
  return {
    type: "function",
    function: { name, description: `test ${name}`, parameters: { type: "object", properties: {} } },
  };
}

function registry(
  overrides: ToolExecutorOverrides = {},
  extraNames: string[] = []
): ToolRegistry {
  const known = new Set(TOOL_DEFINITIONS.map((d) => d.function.name));
  const extras = extraNames.filter((n) => !known.has(n)).map(dynamicDef);
  const agentStubs: ToolExecutorOverrides = {
    spawn_agent: async () => "agent-stub",
    spawn_agents: async () => "agents-stub",
    send_message: async () => "message-stub",
  };
  return ToolRegistry.fromDefinitions([...TOOL_DEFINITIONS, ...extras], { ...agentStubs, ...overrides });
}

function fakeExecutor(
  fn: (name: string, args: any, bodyCtx: any) => Promise<string> | string
): (name: string) => ToolExecutorOverrides[string] {
  return (name) => async (args, bodyCtx) => fn(name, args, bodyCtx);
}

function makeRuntime(
  workspaceRoot: string,
  options: {
    context?: Record<string, unknown>;
    callbacks?: ToolRuntimeCallbacks;
    executors?: ToolExecutorOverrides;
    extraNames?: string[];
  } = {}
): ToolRuntime {
  return new ToolRuntime(
    ctx(workspaceRoot, options.context),
    registry(options.executors, options.extraNames),
    options.callbacks
  );
}

test("每个内置模型工具都有 Runtime 元数据，且名称唯一", () => {
  const modelNames = TOOL_DEFINITIONS.map((d) => d.function.name).sort();
  const runtimeNames = BUILTIN_TOOL_RUNTIME_SPECS.map((d) => d.name).sort();
  assert.deepEqual(runtimeNames, modelNames);
  assert.equal(new Set(runtimeNames).size, runtimeNames.length);
});

test("Runtime 宿主元数据不会泄漏进模型 ToolDefinition", () => {
  for (const d of TOOL_DEFINITIONS) {
    assert.equal("timeoutMs" in d.function, false, `${d.function.name} 不应把 timeoutMs 发给模型`);
    assert.equal("effect" in d.function, false);
    assert.equal("concurrency" in d.function, false);
  }
  assert.equal(getToolRuntimeSpec("run_code").timeoutMs, 300_000);
});

test("Runtime 将 provider callId 精确传给文件证据回调", async () => {
  const r = root();
  try {
    const seen: Array<{ kind: string; callId?: string }> = [];
    const runtime = makeRuntime(r, {
      context: {
        runtime: { autoFormat: false },
        onFileRead: (_file: string, _path: string, callId?: string) => seen.push({ kind: "read", callId }),
        onFileDiff: (_info: unknown, callId?: string) => seen.push({ kind: "diff", callId }),
      },
      executors: {
        read_file: async (_args, bodyCtx) => {
          bodyCtx.onFileRead?.("a.txt", path.join(r, "a.txt"), "spoofed-body-id");
          return "read";
        },
        write_file: async (_args, bodyCtx) => {
          bodyCtx.onFileDiff?.({
            id: "ed-test", file: "a.txt", path: path.join(r, "a.txt"), kind: "create",
            diff: "+a", added: 1, removed: 0, original: "", applied: "a",
          }, "spoofed-body-id");
          return "write";
        },
      },
    });
    await runtime.execute("read_file", { path: "a.txt" }, { callId: "call-read" });
    await runtime.execute("write_file", { path: "a.txt", content: "a" }, { callId: "call-write" });
    assert.deepEqual(seen, [
      { kind: "read", callId: "call-read" },
      { kind: "diff", callId: "call-write" },
    ]);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("ToolRegistry 拒绝重复名称，Provider schema 与执行器不能漂移", () => {
  assert.throws(
    () => ToolRegistry.fromDefinitions([TOOL_DEFINITIONS[0], TOOL_DEFINITIONS[0]]),
    /重复注册/
  );
});

test("ToolRegistry 对 Agent-native 工具要求显式 executor", () => {
  const spawn = TOOL_DEFINITIONS.find((d) => d.function.name === "spawn_agent")!;
  assert.throws(() => ToolRegistry.fromDefinitions([spawn]), /缺少显式 executor/);
});

test("ToolRegistry 冻结 schema/runtime 快照，外部对象后改不会影响本次 Agent run", () => {
  const original = JSON.parse(JSON.stringify(TOOL_DEFINITIONS[0])) as ToolDefinition;
  const reg = ToolRegistry.fromDefinitions([original]);
  original.function.description = "mutated";
  assert.notEqual(reg.get(original.function.name)!.definition.function.description, "mutated");
  assert.equal(Object.isFrozen(reg.get(original.function.name)!.definition), true);
  assert.equal(Object.isFrozen(reg.get(original.function.name)!.runtime), true);
});

test("非 MCP/Connector 的新增 schema 若没有显式 Runtime spec，注册阶段直接失败", () => {
  assert.throws(() => ToolRegistry.fromDefinitions([dynamicDef("future_builtin")]), /缺少显式 Runtime spec/);
});

test("plan 模式在 body 之前阻止写入", async () => {
  const r = root();
  try {
    let called = false;
    const runtime = makeRuntime(r, {
      context: { agentMode: "plan" },
      executors: { write_file: async () => { called = true; return "should-not-run"; } },
    });
    const out = await runtime.execute("write_file", { path: "a.txt", content: "x" });
    assert.equal(called, false);
    assert.equal(out.blocked, "mode");
    assert.match(out.result, /规划模式|已阻止/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("denyRules 在用户 approval 与 body 之前单调拒绝", async () => {
  const r = root();
  try {
    let approved = 0;
    let called = false;
    const runtime = makeRuntime(r, {
      context: { denyRules: ["write_file"] },
      callbacks: { requestApproval: async () => { approved++; return { allow: true }; } },
      executors: { write_file: async () => { called = true; return "bad"; } },
    });
    const out = await runtime.execute("write_file", { path: "a.txt", content: "x" });
    assert.equal(approved, 0);
    assert.equal(called, false);
    assert.equal(out.blocked, "policy");
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("通用 approval 拒绝时 body 不执行", async () => {
  const r = root();
  try {
    let called = false;
    const runtime = makeRuntime(r, {
      callbacks: { requestApproval: async () => ({ allow: false, reason: "test deny" }) },
      executors: { run_command: async () => { called = true; return "bad"; } },
    });
    const out = await runtime.execute("run_command", { command: "echo ok" });
    assert.equal(called, false);
    assert.equal(out.blocked, "approval");
    assert.match(out.result, /test deny/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("显式 allowRules 可跳过危险文本硬阻断和通用 approval", async () => {
  const r = root();
  try {
    let approved = 0;
    let called = false;
    const runtime = makeRuntime(r, {
      context: { allowRules: ["run_command.*rm -rf"] },
      callbacks: { requestApproval: async () => { approved++; return { allow: false }; } },
      executors: { run_command: async () => { called = true; return "allowed-by-rule"; } },
    });
    const out = await runtime.execute("run_command", { command: "rm -rf /tmp/freeseek-test-only" });
    assert.equal(approved, 0);
    assert.equal(called, true);
    assert.match(out.result, /allowed-by-rule/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("run_code(bash) 也走危险 shell 文本检查", async () => {
  const r = root();
  try {
    let called = false;
    const runtime = makeRuntime(r, {
      callbacks: { requestApproval: async () => ({ allow: true }) },
      executors: { run_code: async () => { called = true; return "bad"; } },
    });
    const out = await runtime.execute("run_code", { language: "bash", code: "rm -rf /" });
    assert.equal(called, false);
    assert.equal(out.blocked, "hook");
    assert.match(out.result, /危险操作被拦截/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("pre-hook 安全 warning 不再被 body 结果覆盖", async () => {
  const r = root();
  try {
    const runtime = makeRuntime(r, {
      executors: { write_file: async () => "body-ok" },
    });
    const out = await runtime.execute("write_file", { path: "a.js", content: "eval(userInput)" });
    assert.match(out.result, /安全提示/);
    assert.match(out.result, /动态代码执行/);
    assert.match(out.result, /body-ok/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("MCP 独立 approval 的 allow 在同一 Runtime 内缓存", async () => {
  const r = root();
  try {
    let mcpApprovals = 0;
    let calls = 0;
    const name = "mcp__demo__search";
    const runtime = makeRuntime(r, {
      context: { requestMCPApproval: async () => { mcpApprovals++; return "allow"; } },
      extraNames: [name],
      executors: { [name]: async () => { calls++; return "mcp-ok"; } },
    });
    const a = await runtime.execute(name, { q: "a" });
    const b = await runtime.execute(name, { q: "b" });
    assert.match(a.result, /mcp-ok/);
    assert.match(b.result, /mcp-ok/);
    assert.equal(calls, 2);
    assert.equal(mcpApprovals, 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("父 AbortSignal 在 body 执行期间能终止 Runtime", async () => {
  const r = root();
  try {
    const ctrl = new AbortController();
    const runtime = makeRuntime(r, {
      context: { signal: ctrl.signal },
      callbacks: { requestApproval: async () => ({ allow: true }) },
      executors: {
        run_command: async (_args, bodyCtx) => await new Promise<string>((resolve) => {
          const done = () => resolve("body-observed-abort");
          if (bodyCtx.signal?.aborted) return done();
          bodyCtx.signal?.addEventListener("abort", done, { once: true });
        }),
      },
    });
    const work = runtime.execute("run_command", { command: "sleep" });
    setTimeout(() => ctrl.abort(new Error("stop")), 10);
    const out = await work;
    assert.equal(out.blocked, "cancelled");
    assert.match(out.result, /已取消|已中止/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("approval policy 由 Runtime spec 决定，普通 read 不调用 UI，危险执行 fail-closed", async () => {
  const r = root();
  try {
    let approvals = 0;
    const runtime = makeRuntime(r, {
      callbacks: { requestApproval: async () => { approvals++; return { allow: true }; } },
      executors: { read_file: async () => "read-ok" },
    });
    const read = await runtime.execute("read_file", { path: "missing.txt" });
    assert.match(read.result, /read-ok/);
    assert.equal(approvals, 0);

    const noUi = makeRuntime(r, { executors: { run_command: async () => "bad" } });
    const exec = await noUi.execute("run_command", { command: "echo x" });
    assert.equal(exec.blocked, "approval");
    assert.match(exec.result, /approval handler|需要用户审批/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("confirmFileWrites 由 ToolContext + Runtime spec 控制，而不是 extension 工具名列表", async () => {
  const r = root();
  try {
    let approvals = 0;
    const runtime = makeRuntime(r, {
      context: { confirmFileWrites: true },
      callbacks: { requestApproval: async () => { approvals++; return { allow: true }; } },
      executors: { write_file: async () => "write-ok" },
    });
    const out = await runtime.execute("write_file", { path: "a.txt", content: "x" });
    assert.match(out.result, /write-ok/);
    assert.equal(approvals, 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("connector 被视为联网外部能力：禁网先阻止，允许联网后仍需用户审批", async () => {
  const r = root();
  try {
    const name = "conn__demo__lookup";
    let called = false;
    const denied = makeRuntime(r, {
      context: { allowNetwork: false },
      callbacks: { requestApproval: async () => ({ allow: true }) },
      extraNames: [name],
      executors: { [name]: async () => { called = true; return "bad"; } },
    });
    const a = await denied.execute(name, {});
    assert.equal(a.blocked, "capability");
    assert.equal(called, false);

    let approvals = 0;
    const allowed = makeRuntime(r, {
      callbacks: { requestApproval: async () => { approvals++; return { allow: true }; } },
      extraNames: [name],
      executors: { [name]: async () => "connector-ok" },
    });
    const b = await allowed.execute(name, {});
    assert.match(b.result, /connector-ok/);
    assert.equal(approvals, 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("Agent-native body 抛错会被 Runtime 归一化，不再炸穿整个工具循环", async () => {
  const r = root();
  try {
    const runtime = makeRuntime(r, {
      executors: { spawn_agent: async () => { throw new Error("subagent boom"); } },
    });
    const out = await runtime.execute("spawn_agent", { task: "x" });
    assert.match(out.result, /工具执行出错|subagent boom/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("Runtime 自己记录 tool/approval/result 审计事件，调用方不需要额外补日志", async () => {
  const r = root();
  try {
    const { SessionEventLog, readSessionEvents } = await import("../src/eventlog");
    const log = new SessionEventLog("runtime-audit", r);
    const runtime = makeRuntime(r, {
      context: { eventLog: log, eventActor: "main" },
      callbacks: { requestApproval: async () => ({ allow: true }) },
      executors: { run_command: async () => "ok" },
    });
    await runtime.execute("run_command", { command: "echo ok" }, { callId: "c1" });
    const events = readSessionEvents(r, "runtime-audit");
    assert.deepEqual(
      events.map((e) => e.type),
      ["tool/call", "approval/request", "approval/result", "checkpoint", "tool/result"]
    );
    assert.ok(events.every((e) => e.actor === "main"));
    assert.equal((events[0].data as any).callId, "c1");
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("未注册工具即使有保守 spec 也不能碰 raw body", async () => {
  const r = root();
  try {
    const runtime = makeRuntime(r, {
      callbacks: { requestApproval: async () => ({ allow: true }) },
    });
    const out = await runtime.execute("future_unregistered_tool", {});
    assert.equal(out.blocked, "capability");
    assert.match(out.result, /未注册工具/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});


test("H2 Extension policy/hook runs inside ToolRuntime without bypassing built-in admission", async () => {
  const r = root();
  const extensions = new ExtensionRuntime();
  await extensions.apply({
    manifest: {
      schemaVersion: 1,
      id: "runtime.guard",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { hooks: true },
    },
    activate(ext) {
      ext.registerPolicy({
        name: "guard",
        evaluate: (_tool, input) => input?.block ? { blocked: "blocked-by-extension" } : { warnings: ["policy-warning"] },
      });
      ext.registerHook({
        name: "before",
        event: "pre-tool",
        run: () => ({ warnings: ["pre-warning"] }),
      });
      ext.registerHook({
        name: "after",
        event: "post-tool",
        run: () => ({ note: "post-note" }),
      });
    },
  });
  const lease = extensions.acquireLease();
  try {
    const runtime = makeRuntime(r, {
      context: { extensionLease: lease },
      executors: { read_file: async () => "body-ok" },
    });
    const blocked = await runtime.execute("read_file", { path: "x", block: true });
    assert.equal(blocked.blocked, "policy");
    assert.match(blocked.result, /blocked-by-extension/);

    const ok = await runtime.execute("read_file", { path: "x" });
    assert.match(ok.result, /policy-warning/);
    assert.match(ok.result, /pre-warning/);
    assert.match(ok.result, /body-ok/);
    assert.match(ok.result, /post-note/);
  } finally {
    await lease.release();
    await extensions.dispose();
    fs.rmSync(r, { recursive: true, force: true });
  }
});
