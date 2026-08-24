import test from "node:test";
import assert from "node:assert/strict";
import {
  ExtensionRuntime,
  extensionConnectorToolName,
  extensionToolName,
  type ExtensionModule,
} from "../src/kernel/extensions/runtime";

function toolModule(
  version: string,
  result: string,
  hooks: { disposed?: () => void; fail?: boolean } = {}
): ExtensionModule {
  return {
    manifest: {
      schemaVersion: 1,
      id: "demo.tools",
      version,
      trust: "trusted",
      capabilities: { tools: true },
    },
    activate(ctx) {
      ctx.effect(() => hooks.disposed?.(), `dispose-${version}`);
      ctx.registerTool({
        name: "echo",
        description: `echo ${version}`,
        parameters: { type: "object" },
        runtime: {
          effect: "read",
          concurrency: "parallel",
          readOnlyAllowed: true,
          approval: "auto",
        },
        execute: async () => result,
      });
      if (hooks.fail) throw new Error(`boom-${version}`);
    },
  };
}

async function executeOnlyTool(runtime: ExtensionRuntime): Promise<string> {
  const lease = runtime.acquireLease();
  try {
    const rows = lease.toolRegistrations();
    assert.equal(rows.length, 1);
    return await rows[0].execute({}, {} as any);
  } finally {
    await lease.release();
  }
}

test("extension runtime activates a namespaced tool generation", async () => {
  const runtime = new ExtensionRuntime();
  await runtime.apply(toolModule("1.0.0", "v1"));
  assert.equal(runtime.status("demo.tools").state, "active");
  assert.equal(extensionToolName("demo.tools", "echo"), "ext__demo_tools__echo");
  assert.equal(await executeOnlyTool(runtime), "v1");
  await runtime.dispose();
});

test("reload keeps the old generation alive until its last lease releases", async () => {
  let disposedV1 = 0;
  const runtime = new ExtensionRuntime();
  await runtime.apply(toolModule("1.0.0", "v1", { disposed: () => disposedV1++ }));
  const oldLease = runtime.acquireLease();
  const oldTool = oldLease.toolRegistrations()[0];

  await runtime.apply(toolModule("1.1.0", "v2"), "file-change");
  assert.equal(runtime.status("demo.tools").activeVersion, "1.1.0");
  assert.equal(disposedV1, 0, "retired generation must remain alive while leased");
  assert.equal(await oldTool.execute({}, {} as any), "v1");
  assert.equal(await executeOnlyTool(runtime), "v2");

  await oldLease.release();
  assert.equal(disposedV1, 1);
  assert.deepEqual(runtime.status("demo.tools").retiredGenerations, []);
  await runtime.dispose();
});

test("retained child lease pins the parent generation across reload", async () => {
  let disposedV1 = 0;
  const runtime = new ExtensionRuntime();
  await runtime.apply(toolModule("1.0.0", "v1", { disposed: () => disposedV1++ }));
  const parent = runtime.acquireLease();
  const child = parent.retain();
  await runtime.apply(toolModule("1.1.0", "v2"));
  await parent.release();
  assert.equal(disposedV1, 0, "background child still pins old generation");
  assert.equal(await child.toolRegistrations()[0].execute({}, {} as any), "v1");
  await child.release();
  assert.equal(disposedV1, 1);
  await runtime.dispose();
});

test("failed reload rolls back candidate effects and preserves last-known-good", async () => {
  let failedDisposed = 0;
  const audits: string[] = [];
  const runtime = new ExtensionRuntime({ onAudit: (event) => audits.push(event.kind) });
  await runtime.apply(toolModule("1.0.0", "v1"));
  await runtime.apply(toolModule("1.1.0", "broken", {
    disposed: () => failedDisposed++,
    fail: true,
  }));

  const status = runtime.status("demo.tools");
  assert.equal(status.state, "active");
  assert.equal(status.activeVersion, "1.0.0");
  assert.match(status.lastError ?? "", /boom-1\.1\.0/);
  assert.equal(failedDisposed, 1);
  assert.equal(await executeOnlyTool(runtime), "v1");
  assert.ok(audits.includes("rollback"));
  await runtime.dispose();
});

test("missing extension dependency is PENDING and reconciles when provider appears", async () => {
  const runtime = new ExtensionRuntime();
  const consumer: ExtensionModule = {
    manifest: {
      schemaVersion: 1,
      id: "consumer",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { tools: true },
      requires: { extensions: ["provider"] },
    },
    activate(ctx) {
      ctx.registerTool({
        name: "consume",
        description: "consumer",
        parameters: {},
        runtime: { effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto" },
        execute: async () => "consumer-active",
      });
    },
  };
  const provider: ExtensionModule = {
    manifest: { schemaVersion: 1, id: "provider", version: "1.0.0", trust: "trusted" },
    activate() {},
  };

  await runtime.apply(consumer);
  assert.equal(runtime.status("consumer").state, "pending");
  assert.deepEqual(runtime.status("consumer").missingDependencies, ["provider"]);
  await runtime.apply(provider);
  assert.equal(runtime.status("consumer").state, "active");

  await runtime.remove("provider");
  assert.equal(runtime.status("consumer").state, "pending");
  assert.deepEqual(runtime.status("consumer").missingDependencies, ["provider"]);
  await runtime.dispose();
});

test("connector contribution is namespaced and disposed with its generation", async () => {
  let disposed = 0;
  const runtime = new ExtensionRuntime();
  await runtime.apply({
    manifest: {
      schemaVersion: 1,
      id: "data.bridge",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { connectors: true, network: true },
    },
    activate(ctx) {
      const names = ctx.registerConnector({
        id: "http",
        name: "HTTP",
        description: "demo",
        tools: [{ name: "get", description: "get", parameters: {} }],
        execute: async (name) => `connector:${name}`,
        dispose: () => { disposed++; },
      });
      assert.deepEqual(names, [extensionConnectorToolName("data.bridge", "http", "get")]);
    },
  });
  assert.equal(await executeOnlyTool(runtime), "connector:get");
  await runtime.remove("data.bridge");
  assert.equal(disposed, 1);
  await runtime.dispose();
});

test("runtime requires H4 sandbox metadata for untrusted and still rejects UI/undeclared dangerous capabilities", async () => {
  const runtime = new ExtensionRuntime();
  await assert.rejects(() => runtime.apply({
    manifest: { schemaVersion: 1, id: "bad.untrusted", version: "1.0.0", trust: "untrusted" },
    activate() {},
  }), /H4 out-of-process sandbox|in-process fallback/);
  await assert.rejects(() => runtime.apply({
    manifest: {
      schemaVersion: 1,
      id: "bad.ui",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { ui: true },
    },
    activate() {},
  }), /禁止 host-specific UI/);

  await runtime.apply({
    manifest: {
      schemaVersion: 1,
      id: "bad.tool",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { tools: true },
    },
    activate(ctx) {
      ctx.registerTool({
        name: "write",
        description: "write",
        parameters: {},
        runtime: { effect: "write", concurrency: "exclusive", readOnlyAllowed: false, approval: "always" },
        execute: async () => "nope",
      });
    },
  });
  assert.equal(runtime.status("bad.tool").state, "error");
  assert.match(runtime.status("bad.tool").lastError ?? "", /filesystem=write/);

  await runtime.apply({
    manifest: {
      schemaVersion: 1,
      id: "bad.metadata",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { tools: true },
    },
    activate(ctx) {
      ctx.registerTool({
        name: "unsafe_readonly",
        description: "malformed runtime metadata",
        parameters: {},
        runtime: {
          effect: "read",
          concurrency: "parallel",
          readOnlyAllowed: "yes",
          approval: "auto",
        } as any,
        execute: async () => "nope",
      });
    },
  });
  assert.equal(runtime.status("bad.metadata").state, "error");
  assert.match(runtime.status("bad.metadata").lastError ?? "", /readOnlyAllowed 必须是 boolean/);
  await runtime.dispose();
});

test("H2 skill snapshots are generation-pinned across reload", async () => {
  const runtime = new ExtensionRuntime();
  const skillModule = (version: string, body: string): ExtensionModule => ({
    manifest: {
      schemaVersion: 1,
      id: "demo.skills",
      version,
      trust: "trusted",
      capabilities: { skills: true },
    },
    activate(ctx) {
      ctx.registerSkill({
        name: "demo-skill",
        markdown: `---\nname: demo-skill\ndescription: demo\n---\n# ${body}`,
        source: `memory:${version}`,
      });
    },
  });
  await runtime.apply(skillModule("1.0.0", "V1"));
  const oldLease = runtime.acquireLease();
  assert.match(oldLease.skillContributions()[0].markdown, /V1/);

  await runtime.apply(skillModule("1.1.0", "V2"), "skill-reload");
  const nextLease = runtime.acquireLease();
  try {
    assert.match(oldLease.skillContributions()[0].markdown, /V1/, "old lease must keep immutable skill bytes");
    assert.match(nextLease.skillContributions()[0].markdown, /V2/);
  } finally {
    await oldLease.release();
    await nextLease.release();
    await runtime.dispose();
  }
});

test("H2 policy and hooks are monotonic and generation-pinned", async () => {
  const runtime = new ExtensionRuntime();
  const moduleFor = (version: string, marker: string): ExtensionModule => ({
    manifest: {
      schemaVersion: 1,
      id: "demo.policy",
      version,
      trust: "trusted",
      capabilities: { hooks: true },
    },
    activate(ctx) {
      ctx.registerPolicy({
        name: "guard",
        evaluate: async (toolName) => toolName === "blocked" ? { blocked: `${marker}-block` } : { warnings: [`${marker}-warn`] },
      });
      ctx.registerHook({
        name: "after",
        event: "post-tool",
        run: async () => ({ note: `${marker}-post` }),
      });
    },
  });
  await runtime.apply(moduleFor("1.0.0", "V1"));
  const oldLease = runtime.acquireLease();
  await runtime.apply(moduleFor("1.1.0", "V2"), "policy-reload");
  const newLease = runtime.acquireLease();
  const ctx = {} as any;
  try {
    assert.equal((await oldLease.evaluatePolicies("blocked", {}, ctx)).blocked, "V1-block");
    assert.deepEqual((await newLease.evaluatePolicies("ok", {}, ctx)).warnings, ["V2-warn"]);
    assert.equal((await oldLease.runHooks("post-tool", { toolName: "ok", args: {}, result: "x", ctx })).note, "V1-post");
    assert.equal((await newLease.runHooks("post-tool", { toolName: "ok", args: {}, result: "x", ctx })).note, "V2-post");
  } finally {
    await oldLease.release();
    await newLease.release();
    await runtime.dispose();
  }
});

test("H2 MCP contribution keeps a generation-owned executor until the lease releases", async () => {
  let disposed = 0;
  const runtime = new ExtensionRuntime();
  await runtime.apply({
    manifest: {
      schemaVersion: 1,
      id: "demo.mcp",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { mcp: true },
    },
    activate(ctx) {
      const names = ctx.registerMcp({
        id: "demo",
        tools: [{ name: "echo", description: "echo", parameters: { type: "object" } }],
        execute: async (_name, args) => `mcp:${args.text}`,
        dispose: () => { disposed++; },
      });
      assert.deepEqual(names, ["mcp__ext_demo_mcp_demo__echo"]);
    },
  });
  const lease = runtime.acquireLease();
  const row = lease.toolRegistrations()[0];
  assert.equal(row.runtime.mcpApproval, true);
  await runtime.remove("demo.mcp");
  assert.equal(disposed, 0, "retired MCP binding must stay alive while leased");
  assert.equal(await row.execute({ text: "OK" }, {} as any), "mcp:OK");
  await lease.release();
  assert.equal(disposed, 1);
  await runtime.dispose();
});

test("H2 MCP registration is atomic when one projected tool is invalid or duplicated", async () => {
  let disposed = 0;
  const runtime = new ExtensionRuntime();
  try {
    const status = await runtime.apply({
      manifest: { schemaVersion: 1, id: "mcp.atomic", version: "1.0.0", trust: "trusted", capabilities: { mcp: true } },
      activate(ctx) {
        ctx.registerMcp({
          id: "demo",
          tools: [
            { name: "echo", description: "one", parameters: {} },
            { name: "echo", description: "duplicate", parameters: {} },
          ],
          execute: async () => "never",
          dispose: () => { disposed++; },
        });
      },
    });
    assert.equal(status.state, "error");
    assert.match(status.lastError ?? "", /duplicate contribution/);
    const lease = runtime.acquireLease();
    try { assert.equal(lease.toolRegistrations().length, 0); }
    finally { await lease.release(); }
    assert.equal(disposed, 0, "disposer is not registered until the contribution batch validates");
  } finally {
    await runtime.dispose();
  }
});
