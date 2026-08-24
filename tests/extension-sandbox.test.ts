import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionPackageLoader } from "../src/kernel/extensions/package-loader";
import { ExtensionPackageWatcher } from "../src/kernel/extensions/package-watcher";
import { FileExtensionHost } from "../src/kernel/extensions/package-host";
import { probeLinuxExtensionSandbox } from "../src/kernel/extensions/sandbox-supervisor";
import { loadExtensionSandboxPolicyFile, type ExtensionSandboxPolicy } from "../src/kernel/extensions/sandbox-policy";
import { ExtensionRuntime, type ExtensionModule } from "../src/kernel/extensions/runtime";

const H4 = probeLinuxExtensionSandbox();

function tempDir(prefix = "freeseek-h4-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePackage(
  dir: string,
  input: {
    id?: string;
    version?: string;
    capabilities?: Record<string, unknown>;
    source: string;
  }
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: input.id ?? "demo.sandbox",
    version: input.version ?? "1.0.0",
    trust: "untrusted",
    capabilities: { tools: true, filesystem: "none", ...(input.capabilities ?? {}) },
    entry: "index.cjs",
  }, null, 2));
  fs.writeFileSync(path.join(dir, "index.cjs"), input.source);
}

async function execute(runtime: ExtensionRuntime, localTool = "echo", args: unknown = {}): Promise<string> {
  const lease = runtime.acquireLease();
  try {
    const suffix = `__${localTool}`;
    const row = lease.toolRegistrations().find((candidate) => candidate.name.endsWith(suffix));
    assert.ok(row, `missing sandbox tool ${localTool}`);
    return await row.execute(args, { signal: new AbortController().signal } as any);
  } finally {
    await lease.release();
  }
}

async function close(runtime: ExtensionRuntime, root?: string): Promise<void> {
  await runtime.dispose();
  if (root) fs.rmSync(root, { recursive: true, force: true });
}

const runtimeMeta = `{ effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto", timeoutMs: 1500 }`;

test("untrusted extension cannot enter ExtensionRuntime through an in-process module", async () => {
  const runtime = new ExtensionRuntime();
  const module: ExtensionModule = {
    manifest: { schemaVersion: 1, id: "bad.untrusted", version: "1.0.0", trust: "untrusted", capabilities: { tools: true } },
    activate() { throw new Error("must never execute in Host"); },
  };
  await assert.rejects(runtime.apply(module), /out-of-process sandbox|in-process fallback/);
  await runtime.dispose();
});



test("sandbox policy file is startup-only strict JSON and rejects symlink/unknown fields", (t) => {
  const root = tempDir("freeseek-h4-policy-");
  const allowed = tempDir("freeseek-h4-policy-data-");
  try {
    const file = path.join(root, "policy.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, grants: { "demo.sandbox": { filesystem: { read: [allowed] } } } }));
    const policy = loadExtensionSandboxPolicyFile(file);
    assert.deepEqual(policy.grants?.["demo.sandbox"]?.filesystem?.read, [allowed]);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, grants: {}, surprise: true }));
    assert.throws(() => loadExtensionSandboxPolicyFile(file), /未知字段/);
    const target = path.join(root, "target.json"); fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, grants: {} }));
    const link = path.join(root, "link.json");
    let symlinkOk = true;
    try { fs.symlinkSync(target, link); } catch { symlinkOk = false; }
    if (!symlinkOk) {
      // 当前环境无符号链接创建权限（如 Windows 非开发者模式）：跳过 symlink 拒检分支
      t.skip("当前环境无符号链接创建权限，跳过 symlink 拒检");
      return;
    }
    assert.throws(() => loadExtensionSandboxPolicyFile(link), /不允许 symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(allowed, { recursive: true, force: true }); }
});

test("Linux H4 starts an untrusted tool in a separate sandbox worker", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir();
  const audits: any[] = [];
  const runtime = new ExtensionRuntime({ onAudit: (row) => audits.push(row) });
  try {
    writePackage(root, { source: `module.exports = (ctx) => ctx.registerTool({
      name: "echo", description: "sandbox echo", parameters: {}, runtime: ${runtimeMeta},
      execute: async (args) => JSON.stringify({ value: args.value, pid: process.pid, cwd: process.cwd(), marker: process.env.FREESEEK_H4_HOST_MARKER || null })
    });` });
    process.env.FREESEEK_H4_HOST_MARKER = "host-secret-marker";
    const status = (await new ExtensionPackageLoader(runtime).load(root)).status;
    assert.equal(status.state, "active");
    assert.equal(status.sandbox?.state, "running");
    assert.equal(status.sandbox?.mode, "sandbox");
    assert.notEqual(status.sandbox?.pid, process.pid);
    const output = JSON.parse(await execute(runtime, "echo", { value: "ok" }));
    assert.equal(output.value, "ok");
    assert.equal(output.cwd, "/package");
    assert.equal(output.marker, null, "Host environment secret must not cross env -i boundary");
    assert.ok(audits.some((row) => row.kind === "sandbox-spawn"));
    assert.ok(audits.some((row) => row.kind === "sandbox-ready"));
  } finally {
    delete process.env.FREESEEK_H4_HOST_MARKER;
    await close(runtime, root);
  }
});

test("direct host filesystem, child_process, and network access are contained", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir();
  const runtime = new ExtensionRuntime();
  try {
    writePackage(root, { source: `module.exports = (ctx) => ctx.registerTool({
      name: "probe", description: "isolation probe", parameters: {}, runtime: ${runtimeMeta},
      execute: async () => {
        let filesystem = "ALLOWED"; let child = "ALLOWED"; let network = "ALLOWED";
        try { require("fs").readFileSync("/etc/passwd", "utf8"); } catch (e) { filesystem = String(e.code || e.name || e.message); }
        try { require("child_process").execFileSync("/bin/sh", ["-c", "true"]); } catch (e) { child = String(e.code || e.name || e.message); }
        network = await new Promise((resolve) => {
          const socket = require("net").connect({ host: "1.1.1.1", port: 80 });
          const timer = setTimeout(() => { socket.destroy(); resolve("TIMEOUT"); }, 350);
          socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("ALLOWED"); });
          socket.once("error", (e) => { clearTimeout(timer); resolve(String(e.code || e.name || e.message)); });
        });
        return JSON.stringify({ filesystem, child, network });
      }
    });` });
    await new ExtensionPackageLoader(runtime).load(root);
    const result = JSON.parse(await execute(runtime, "probe"));
    assert.notEqual(result.filesystem, "ALLOWED");
    assert.notEqual(result.child, "ALLOWED");
    assert.notEqual(result.network, "ALLOWED");
  } finally { await close(runtime, root); }
});

test("filesystem broker enforces explicit roots and per-tool effects", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir();
  const data = tempDir("freeseek-h4-data-");
  const outside = tempDir("freeseek-h4-outside-");
  const input = path.join(data, "input.txt");
  const output = path.join(data, "output.txt");
  fs.writeFileSync(input, "broker-read");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret");
  const policy: ExtensionSandboxPolicy = { grants: { "demo.sandbox": { filesystem: { read: [data], write: [data] } } } };
  const runtime = new ExtensionRuntime();
  try {
    writePackage(root, { capabilities: { filesystem: "write" }, source: `module.exports = (ctx) => {
      ctx.registerTool({ name: "files", description: "broker fs", parameters: {},
        runtime: { effect: "write", concurrency: "exclusive", readOnlyAllowed: false, approval: "confirm-write", timeoutMs: 1500 },
        execute: async (args, runtime) => { const text = await runtime.fs.readText(args.input); await runtime.fs.writeText(args.output, text + ":written"); return text; }
      });
      ctx.registerTool({ name: "badEffect", description: "bad effect", parameters: {}, runtime: ${runtimeMeta},
        execute: async (args, runtime) => runtime.fs.writeText(args.output, "bad")
      });
    };` });
    await new ExtensionPackageLoader(runtime, { sandboxPolicy: policy }).load(root);
    assert.equal(await execute(runtime, "files", { input, output }), "broker-read");
    assert.equal(fs.readFileSync(output, "utf8"), "broker-read:written");
    await assert.rejects(execute(runtime, "files", { input: path.join(outside, "secret.txt"), output }), /越权/);
    await assert.rejects(execute(runtime, "badEffect", { output }), /write\/destructive effect/);
  } finally {
    await close(runtime, root);
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("network broker uses exact operator origin and requires per-tool network metadata", { skip: !H4.ok && H4.reason }, async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("broker-network"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const root = tempDir();
  const policy: ExtensionSandboxPolicy = { grants: { "demo.sandbox": { network: { allowedOrigins: [origin] } } } };
  const runtime = new ExtensionRuntime();
  try {
    writePackage(root, { capabilities: { network: true }, source: `module.exports = (ctx) => {
      ctx.registerTool({ name: "fetch", description: "broker net", parameters: {},
        runtime: { effect: "external", concurrency: "exclusive", readOnlyAllowed: false, approval: "always", requiresNetwork: true, timeoutMs: 1500 },
        execute: async (args, runtime) => runtime.net.fetchText(args.url)
      });
      ctx.registerTool({ name: "stealth", description: "no runtime network bit", parameters: {}, runtime: ${runtimeMeta},
        execute: async (args, runtime) => runtime.net.fetchText(args.url)
      });
    };` });
    await new ExtensionPackageLoader(runtime, { sandboxPolicy: policy }).load(root);
    assert.match(await execute(runtime, "fetch", { url: `${origin}/ok` }), /HTTP 200\nbroker-network/);
    await assert.rejects(execute(runtime, "fetch", { url: "http://127.0.0.1:1/nope" }), /origin 未授权/);
    await assert.rejects(execute(runtime, "stealth", { url: `${origin}/ok` }), /requiresNetwork=true/);
  } finally {
    await close(runtime, root);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("reload pins old sandbox generation until old lease release", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir();
  const audits: any[] = [];
  const runtime = new ExtensionRuntime({ onAudit: (row) => audits.push(row) });
  const loader = new ExtensionPackageLoader(runtime);
  const source = (value: string) => `module.exports = (ctx) => ctx.registerTool({ name: "echo", description: "version", parameters: {}, runtime: ${runtimeMeta}, execute: async () => ${JSON.stringify(value)} });`;
  try {
    writePackage(root, { version: "1.0.0", source: source("v1") });
    await loader.load(root);
    const oldLease = runtime.acquireLease();
    const oldTool = oldLease.toolRegistrations()[0];
    const oldGeneration = runtime.status("demo.sandbox").activeGeneration;
    writePackage(root, { version: "1.1.0", source: source("v2") });
    await loader.load(root, "reload-test");
    assert.equal(runtime.status("demo.sandbox").activeVersion, "1.1.0");
    assert.equal(await oldTool.execute({}, { signal: new AbortController().signal } as any), "v1");
    assert.equal(await execute(runtime), "v2");
    assert.ok(runtime.status("demo.sandbox").retiredGenerations.includes(oldGeneration!));
    await oldLease.release();
    assert.ok(!runtime.status("demo.sandbox").retiredGenerations.includes(oldGeneration!));
    assert.ok(audits.some((row) => row.kind === "sandbox-dispose" && row.generation === oldGeneration));
  } finally { await close(runtime, root); }
});

test("filesystem watcher hot-reloads untrusted package and preserves the leased worker", { skip: !H4.ok && H4.reason }, async () => {
  const packages = tempDir("freeseek-h4-watch-");
  const packageDir = path.join(packages, "demo");
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [packages], { intervalMs: 100 });
  let oldLease: ReturnType<ExtensionRuntime["acquireLease"]> | undefined;
  const source = (value: string) => `module.exports = (ctx) => ctx.registerTool({ name: "echo", description: "watch", parameters: {}, runtime: ${runtimeMeta}, execute: async () => ${JSON.stringify(value)} });`;
  try {
    writePackage(packageDir, { version: "1.0.0", source: source("watch-v1") });
    await watcher.start();
    assert.equal(await execute(runtime), "watch-v1");
    oldLease = runtime.acquireLease();
    const oldTool = oldLease.toolRegistrations()[0];
    const oldGeneration = runtime.status("demo.sandbox").activeGeneration!;

    writePackage(packageDir, { version: "1.1.0", source: source("watch-v2") });
    const deadline = Date.now() + 3000;
    while (runtime.status("demo.sandbox").activeVersion !== "1.1.0" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(runtime.status("demo.sandbox").activeVersion, "1.1.0");
    assert.equal(await oldTool.execute({}, { signal: new AbortController().signal } as any), "watch-v1");
    assert.equal(await execute(runtime), "watch-v2");
    assert.ok(runtime.status("demo.sandbox").retiredGenerations.includes(oldGeneration));
    await oldLease.release();
    oldLease = undefined;
    assert.ok(!runtime.status("demo.sandbox").retiredGenerations.includes(oldGeneration));
  } finally {
    if (oldLease) await oldLease.release();
    await watcher.stop();
    await close(runtime, packages);
  }
});

test("failed sandbox candidate preserves the last-known-good worker", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir();
  const runtime = new ExtensionRuntime();
  const loader = new ExtensionPackageLoader(runtime);
  try {
    writePackage(root, { version: "1.0.0", source: `module.exports = (ctx) => ctx.registerTool({ name:"echo", description:"good", parameters:{}, runtime:${runtimeMeta}, execute:async()=>"good" });` });
    await loader.load(root);
    writePackage(root, { version: "1.1.0", source: `module.exports = () => { throw new Error("candidate-boom"); };` });
    const status = (await loader.load(root, "broken-reload")).status;
    assert.equal(status.state, "active");
    assert.equal(status.activeVersion, "1.0.0");
    assert.equal(status.sandbox?.state, "running");
    assert.match(status.lastError ?? "", /candidate-boom|activation failed/);
    assert.equal(await execute(runtime), "good");
  } finally { await close(runtime, root); }
});

test("tool timeout kills the worker and leaves the Host alive with a sandbox fault", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir();
  const audits: any[] = [];
  const runtime = new ExtensionRuntime({ onAudit: (row) => audits.push(row) });
  try {
    writePackage(root, { source: `module.exports = (ctx) => ctx.registerTool({ name:"hang", description:"hang", parameters:{},
      runtime:{ effect:"read", concurrency:"parallel", readOnlyAllowed:true, approval:"auto", timeoutMs:200 },
      execute:async()=>{ while(true){} }
    });` });
    await new ExtensionPackageLoader(runtime).load(root);
    await assert.rejects(execute(runtime, "hang"), /timeout/);
    const status = runtime.status("demo.sandbox");
    assert.equal(status.state, "active", "generation identity remains observable after worker fault");
    assert.equal(status.sandbox?.state, "crashed");
    assert.match(status.lastError ?? "", /timeout/);
    assert.ok(audits.some((row) => row.kind === "sandbox-timeout"));
    assert.equal(1 + 1, 2, "Host test process survived worker CPU hang");
  } finally { await close(runtime, root); }
});

test("shell capability and package symlinks fail closed", { skip: !H4.ok && H4.reason }, async () => {
  const shellRoot = tempDir();
  const linkRoot = tempDir();
  const runtime = new ExtensionRuntime();
  try {
    writePackage(shellRoot, { capabilities: { shell: true }, source: `module.exports = () => {};` });
    await assert.rejects(new ExtensionPackageLoader(runtime).load(shellRoot), /不开放 shell|fail-closed/);

    writePackage(linkRoot, { id: "demo.symlink", source: `module.exports = (ctx) => ctx.registerTool({ name:"echo", description:"x", parameters:{}, runtime:${runtimeMeta}, execute:async()=>"x" });` });
    const outside = path.join(os.tmpdir(), `freeseek-h4-link-${process.pid}.txt`);
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(linkRoot, "helper.txt"));
    const status = (await new ExtensionPackageLoader(runtime).load(linkRoot)).status;
    assert.equal(status.state, "error");
    assert.match(status.lastError ?? "", /symlink/);
    fs.rmSync(outside, { force: true });
  } finally {
    await runtime.dispose();
    fs.rmSync(shellRoot, { recursive: true, force: true });
    fs.rmSync(linkRoot, { recursive: true, force: true });
  }
});

test("sandbox protocol corruption is contained by killing only the worker", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir();
  const audits: any[] = [];
  const runtime = new ExtensionRuntime({ onAudit: (row) => audits.push(row) });
  try {
    writePackage(root, { source: `module.exports = (ctx) => ctx.registerTool({ name:"corrupt", description:"corrupt", parameters:{}, runtime:${runtimeMeta}, execute:async()=>{ process.stdout.write("NOT_JSON\\n"); return "never"; } });` });
    await new ExtensionPackageLoader(runtime).load(root);
    await assert.rejects(execute(runtime, "corrupt"), /non-JSON|protocol|disconnected/);
    assert.equal(runtime.status("demo.sandbox").sandbox?.state, "crashed");
    assert.ok(audits.some((row) => row.kind === "sandbox-protocol"));
    assert.equal(process.pid > 0, true, "Host remains alive after worker protocol sabotage");
  } finally { await close(runtime, root); }
});

test("oversized sandbox result is rejected without killing the healthy worker", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir(); const runtime = new ExtensionRuntime();
  try {
    writePackage(root, { source: `module.exports = (ctx) => { ctx.registerTool({ name:"huge", description:"huge", parameters:{}, runtime:${runtimeMeta}, execute:async()=>"x".repeat(300*1024) }); ctx.registerTool({ name:"echo", description:"echo", parameters:{}, runtime:${runtimeMeta}, execute:async()=>"still-running" }); };` });
    await new ExtensionPackageLoader(runtime).load(root);
    await assert.rejects(execute(runtime, "huge"), /exceeds 256KiB/);
    assert.equal(runtime.status("demo.sandbox").sandbox?.state, "running");
    assert.equal(await execute(runtime, "echo"), "still-running");
  } finally { await close(runtime, root); }
});


test("pre-aborted tool call rejects without hanging or killing the worker", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir(); const runtime = new ExtensionRuntime();
  try {
    writePackage(root, { source: `module.exports = (ctx) => ctx.registerTool({ name:"echo", description:"echo", parameters:{}, runtime:${runtimeMeta}, execute:async()=>"unused" });` });
    await new ExtensionPackageLoader(runtime).load(root);
    const lease = runtime.acquireLease();
    try {
      const tool = lease.toolRegistrations()[0];
      const ctrl = new AbortController(); ctrl.abort();
      await assert.rejects(tool.execute({}, { signal: ctrl.signal } as any), /cancelled/);
      assert.equal(runtime.status("demo.sandbox").sandbox?.state, "running");
    } finally { await lease.release(); }
  } finally { await close(runtime, root); }
});

test("oversized broker response fails the operation without turning it into a protocol crash", { skip: !H4.ok && H4.reason }, async () => {
  const root = tempDir(); const data = tempDir("freeseek-h4-broker-large-"); const runtime = new ExtensionRuntime();
  const large = path.join(data, "large.txt"); fs.writeFileSync(large, "x".repeat(600 * 1024));
  const policy: ExtensionSandboxPolicy = { grants: { "demo.sandbox": { filesystem: { read: [data] } } } };
  try {
    writePackage(root, { capabilities: { filesystem: "read" }, source: `module.exports = (ctx) => ctx.registerTool({ name:"read", description:"read", parameters:{}, runtime:${runtimeMeta}, execute:async(args, runtime)=>runtime.fs.readText(args.path) });` });
    await new ExtensionPackageLoader(runtime, { sandboxPolicy: policy }).load(root);
    await assert.rejects(execute(runtime, "read", { path: large }), /broker response exceeds/);
    assert.equal(runtime.status("demo.sandbox").sandbox?.state, "running");
  } finally { await close(runtime, root); fs.rmSync(data, { recursive: true, force: true }); }
});

test("H3 management projects sandbox crash health and durable lifecycle audit", { skip: !H4.ok && H4.reason }, async () => {
  const packages = tempDir("freeseek-h4-managed-ext-"); const state = tempDir("freeseek-h4-managed-state-");
  const dir = path.join(packages, "demo"); fs.mkdirSync(dir);
  writePackage(dir, { source: `module.exports = (ctx) => ctx.registerTool({ name:"hang", description:"hang", parameters:{}, runtime:{effect:"read",concurrency:"parallel",readOnlyAllowed:true,approval:"auto",timeoutMs:150}, execute:async()=>{while(true){}} });` });
  const host = new FileExtensionHost({ roots: [packages], stateDir: state });
  try {
    await host.start();
    await assert.rejects(execute(host.runtime, "hang"), /timeout/);
    const managed = host.management.status("demo.sandbox");
    assert.equal(managed.health, "error"); assert.equal(managed.lastKnownGood, false); assert.equal(managed.runtime.sandbox?.state, "crashed");
    const audit = host.management.audit({ extensionId: "demo.sandbox", limit: 100 });
    assert.ok(audit.some((row) => row.kind === "sandbox-ready" && /broker-v1/.test(String(row.isolation ?? ""))));
    assert.ok(audit.some((row) => row.kind === "sandbox-timeout" && row.sandboxState === "crashed"));
  } finally { await host.dispose(); fs.rmSync(packages, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});
