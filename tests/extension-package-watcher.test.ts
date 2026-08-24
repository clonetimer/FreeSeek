import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRuntime } from "../src/kernel/extensions/runtime";
import { ExtensionPackageWatcher, type ExtensionWatchEvent } from "../src/kernel/extensions/package-watcher";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-hmr-"));
}

function packageJs(result: string, options: { fail?: boolean } = {}): string {
  return `module.exports = function activate(ctx) {
    ctx.registerTool({
      name: "echo",
      description: "demo echo",
      parameters: { type: "object" },
      runtime: { effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto" },
      execute: async () => ${JSON.stringify(result)}
    });
    ${options.fail ? 'throw new Error("activation-boom");' : ""}
  };\n`;
}

function writePackage(root: string, folder: string, id: string, version: string, body: string): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    trust: "trusted",
    capabilities: { tools: true },
    entry: "index.cjs",
  }, null, 2));
  fs.writeFileSync(path.join(dir, "index.cjs"), body);
  return dir;
}

async function execute(runtime: ExtensionRuntime): Promise<string> {
  const lease = runtime.acquireLease();
  try {
    const tools = lease.toolRegistrations();
    assert.equal(tools.length, 1);
    return await tools[0].execute({}, {} as any);
  } finally {
    await lease.release();
  }
}

test("package watcher loads and hot-reloads while an old lease stays generation-pinned", async () => {
  const root = tempRoot();
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root]);
  try {
    const dir = writePackage(root, "demo", "demo.tools", "1.0.0", packageJs("v1"));
    await watcher.scanNow();
    const oldLease = runtime.acquireLease();
    assert.equal(await oldLease.toolRegistrations()[0].execute({}, {} as any), "v1");

    writePackage(root, "demo", "demo.tools", "1.1.0", packageJs("v2"));
    await watcher.scanNow();
    assert.equal(runtime.status("demo.tools").activeVersion, "1.1.0");
    assert.equal(await oldLease.toolRegistrations()[0].execute({}, {} as any), "v1");
    assert.equal(await execute(runtime), "v2");
    await oldLease.release();
    assert.deepEqual(runtime.status("demo.tools").retiredGenerations, []);
    assert.ok(fs.existsSync(dir));
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syntax and activation failures preserve the last-known-good generation", async () => {
  const root = tempRoot();
  const events: ExtensionWatchEvent[] = [];
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root], { onEvent: (event) => events.push(event) });
  try {
    const dir = writePackage(root, "demo", "demo.tools", "1.0.0", packageJs("v1"));
    await watcher.scanNow();
    fs.writeFileSync(path.join(dir, "index.cjs"), "module.exports = function( {\n");
    await watcher.scanNow();
    assert.equal(runtime.status("demo.tools").activeVersion, "1.0.0");
    assert.equal(await execute(runtime), "v1");

    writePackage(root, "demo", "demo.tools", "1.1.0", packageJs("broken", { fail: true }));
    await watcher.scanNow();
    assert.equal(runtime.status("demo.tools").activeVersion, "1.0.0");
    assert.match(runtime.status("demo.tools").lastError ?? "", /activation-boom/);
    assert.equal(await execute(runtime), "v1");
    assert.ok(events.filter((event) => event.kind === "load-error").length >= 2);
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package deletion retires future availability but an already leased generation remains executable", async () => {
  const root = tempRoot();
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root]);
  try {
    const dir = writePackage(root, "demo", "demo.tools", "1.0.0", packageJs("v1"));
    await watcher.scanNow();
    const oldLease = runtime.acquireLease();
    fs.rmSync(dir, { recursive: true, force: true });
    await watcher.scanNow();
    assert.equal(runtime.status("demo.tools").state, "absent");
    const freshLease = runtime.acquireLease();
    assert.equal(freshLease.toolRegistrations().length, 0);
    await freshLease.release();
    assert.equal(await oldLease.toolRegistrations()[0].execute({}, {} as any), "v1");
    await oldLease.release();
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate ids and entry traversal fail closed without replacing a good package", async () => {
  const root = tempRoot();
  const events: ExtensionWatchEvent[] = [];
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root], { onEvent: (event) => events.push(event) });
  try {
    writePackage(root, "a", "demo.tools", "1.0.0", packageJs("good"));
    await watcher.scanNow();
    writePackage(root, "b", "demo.tools", "9.0.0", packageJs("duplicate"));
    await watcher.scanNow();
    assert.equal(await execute(runtime), "good");
    assert.ok(events.some((event) => event.kind === "duplicate" && event.extensionId === "demo.tools"));

    const bad = path.join(root, "bad");
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(root, "outside.cjs"), "module.exports = () => {};\n");
    fs.writeFileSync(path.join(bad, "freeseek-extension.json"), JSON.stringify({
      schemaVersion: 1, id: "bad.path", version: "1.0.0", trust: "trusted", entry: "../outside.cjs",
    }));
    await watcher.scanNow();
    assert.equal(runtime.status("bad.path").state, "absent");
    assert.ok(events.some((event) => event.kind === "scan-error" && /逃逸/.test(event.error ?? "")));
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start performs an initial scan and the polling loop observes a later edit", async () => {
  const root = tempRoot();
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root], { intervalMs: 100 });
  try {
    writePackage(root, "demo", "demo.tools", "1.0.0", packageJs("v1"));
    await watcher.start();
    assert.equal(await execute(runtime), "v1");
    writePackage(root, "demo", "demo.tools", "1.1.0", packageJs("v2"));
    const deadline = Date.now() + 1500;
    while (runtime.status("demo.tools").activeVersion !== "1.1.0" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(runtime.status("demo.tools").activeVersion, "1.1.0");
    assert.equal(await execute(runtime), "v2");
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a never-active broken package clears its runtime error state after removal", async () => {
  const root = tempRoot();
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root]);
  try {
    const dir = writePackage(root, "broken", "broken.tools", "1.0.0", packageJs("never", { fail: true }));
    await watcher.scanNow();
    assert.equal(runtime.status("broken.tools").state, "error");
    fs.rmSync(dir, { recursive: true, force: true });
    await watcher.scanNow();
    assert.equal(runtime.status("broken.tools").state, "absent");
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
