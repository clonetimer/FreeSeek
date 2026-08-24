import test from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../src/provider";
import { ToolRegistry } from "../src/tool-registry";
import type { ToolContext } from "../src/tools";
import { acquireExtensionRunBoundary } from "../src/kernel/extensions/run-boundary";
import { ExtensionRuntime, type ExtensionModule } from "../src/kernel/extensions/runtime";
import { SkillManager } from "../src/skills";

function moduleFor(version: string, result: string): ExtensionModule {
  return {
    manifest: {
      schemaVersion: 1,
      id: "boundary.tools",
      version,
      trust: "trusted",
      capabilities: { tools: true },
    },
    activate(ctx) {
      ctx.registerTool({
        name: "echo",
        description: version,
        parameters: { type: "object" },
        runtime: { effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto" },
        execute: async () => result,
      });
    },
  };
}

test("ToolRegistry rejects an extension schema that is not bound to a generation executor", () => {
  const definition: ToolDefinition = {
    type: "function",
    function: { name: "ext__boundary_tools__echo", description: "unsafe orphan", parameters: {} },
  };
  assert.throws(() => ToolRegistry.fromDefinitions([definition]), /generation-bound/);
});

test("Agent run boundary pins one registry generation while a later boundary sees the reloaded generation", async () => {
  const runtime = new ExtensionRuntime();
  const ctx = { extensionRuntime: runtime } as ToolContext;
  await runtime.apply(moduleFor("1.0.0", "v1"));
  const oldRun = acquireExtensionRunBoundary(ctx);
  const oldRegistry = await oldRun.createRegistry(oldRun.merge([]), {});

  await runtime.apply(moduleFor("1.1.0", "v2"), "test-reload");
  assert.equal(await oldRegistry.executeBody("ext__boundary_tools__echo", {}, ctx), "v1");

  // Release clears ctx.extensionLease, so a genuinely later Agent run acquires the new active generation.
  await oldRun.release();
  const newRun = acquireExtensionRunBoundary(ctx);
  try {
    const newRegistry = await newRun.createRegistry(newRun.merge([]), {});
    assert.equal(await newRegistry.executeBody("ext__boundary_tools__echo", {}, ctx), "v2");
  } finally {
    await newRun.release();
    await runtime.dispose();
  }
});


test("Agent run boundary mounts H2 skill snapshots for the run and restores the base manager on release", async () => {
  const runtime = new ExtensionRuntime();
  await runtime.apply({
    manifest: {
      schemaVersion: 1,
      id: "boundary.skills",
      version: "1.0.0",
      trust: "trusted",
      capabilities: { skills: true },
    },
    activate(ext) {
      ext.registerSkill({
        name: "boundary-hmr-skill",
        markdown: "---\nname: boundary-hmr-skill\ndescription: boundary\n---\n# H2",
      });
    },
  });
  const base = new SkillManager([]);
  const ctx = { extensionRuntime: runtime, skillManager: base } as ToolContext;
  const run = acquireExtensionRunBoundary(ctx);
  try {
    run.mountSkills(["load_skill"]);
    assert.notEqual(ctx.skillManager, base);
    assert.match(ctx.skillManager!.loadSkill("boundary-hmr-skill"), /# H2/);
  } finally {
    await run.release();
    assert.equal(ctx.skillManager, base);
    await runtime.dispose();
  }
});
