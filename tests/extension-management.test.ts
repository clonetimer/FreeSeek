import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileExtensionHost } from "../src/kernel/extensions/package-host";
import { ExtensionAuditJournal } from "../src/kernel/extensions/audit-store";

function temp(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writePackage(root: string, version: string, result = version): string {
  const dir = path.join(root, "demo"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.tools", version, trust: "trusted", capabilities: { tools: true }, entry: "index.cjs",
  }, null, 2));
  fs.writeFileSync(path.join(dir, "index.cjs"), `module.exports = function(ctx){ctx.registerTool({name:"echo",description:"echo",parameters:{type:"object"},runtime:{effect:"read",concurrency:"parallel",readOnlyAllowed:true,approval:"auto"},execute:async()=>${JSON.stringify(result)}})};\n`);
  return dir;
}

async function execute(host: FileExtensionHost): Promise<string> {
  const lease = host.runtime.acquireLease();
  try { return await lease.toolRegistrations()[0].execute({}, {} as any); }
  finally { await lease.release(); }
}

test("H3 management disable intent survives host restart and does not delete package bytes", async () => {
  const root = temp("freeseek-h3-root-"); const state = temp("freeseek-h3-state-"); const dir = writePackage(root, "1.0.0", "v1");
  let host = new FileExtensionHost({ roots: [root], stateDir: state });
  try {
    await host.start(); assert.equal(await execute(host), "v1");
    const disabled = await host.management.remove("demo.tools");
    assert.equal(disabled.health, "disabled"); assert.equal(fs.existsSync(dir), true);
    const disabledLease = host.runtime.acquireLease();
    try { assert.equal(disabledLease.toolRegistrations().length, 0); } finally { await disabledLease.release(); }
    await host.dispose();
    host = new FileExtensionHost({ roots: [root], stateDir: state });
    await host.start();
    assert.equal(host.management.status("demo.tools").enabled, false);
    assert.equal(host.runtime.status("demo.tools").state, "absent");
    const enabled = await host.management.configure("demo.tools", { enabled: true });
    assert.equal(enabled.health, "ok"); assert.equal(await execute(host), "v1");
  } finally { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test("H3 operator reload creates a new generation even for an unchanged fingerprint", async () => {
  const root = temp("freeseek-h3-reload-"); const state = temp("freeseek-h3-reload-state-"); writePackage(root, "1.0.0", "same");
  const host = new FileExtensionHost({ roots: [root], stateDir: state });
  try {
    await host.start(); const before = host.runtime.status("demo.tools").activeGeneration!;
    await host.management.reload("demo.tools");
    const after = host.runtime.status("demo.tools").activeGeneration!;
    assert.ok(after > before); assert.equal(await execute(host), "same");
  } finally { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test("H3 status exposes LKG degradation, conflicts and explicit trust roots without choosing a duplicate winner", async () => {
  const rootA = temp("freeseek-h3-a-"); const rootB = temp("freeseek-h3-b-"); const state = temp("freeseek-h3-conflict-state-");
  writePackage(rootA, "1.0.0", "good");
  const host = new FileExtensionHost({ roots: [rootA, rootB], stateDir: state });
  try {
    await host.start();
    const dir = path.join(rootA, "demo"); fs.writeFileSync(path.join(dir, "index.cjs"), 'module.exports=()=>{throw new Error("boom")};\n');
    await host.watcher.scanNow();
    let row = host.management.status("demo.tools"); assert.equal(row.health, "degraded"); assert.equal(row.lastKnownGood, true); assert.match(row.runtime.lastError ?? "", /boom/);
    writePackage(rootB, "9.0.0", "duplicate"); await host.watcher.scanNow();
    row = host.management.status("demo.tools"); assert.equal(row.health, "conflict"); assert.equal(row.packageDirs.length, 2);
    assert.deepEqual(host.management.snapshot().trustRoots.sort(), [path.resolve(rootA), path.resolve(rootB)].sort());
    assert.equal(await execute(host), "good", "duplicate discovery must preserve prior LKG");
  } finally { await host.dispose(); for (const dir of [rootA, rootB, state]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test("H3 durable audit journal recovers runtime/watcher/management history across restart", async () => {
  const root = temp("freeseek-h3-audit-"); const state = temp("freeseek-h3-audit-state-"); writePackage(root, "1.0.0");
  const host = new FileExtensionHost({ roots: [root], stateDir: state });
  try { await host.start(); await host.management.reload("demo.tools"); await host.management.configure("demo.tools", { enabled: false }); }
  finally { await host.dispose(); }
  const recovered = new ExtensionAuditJournal(state).list({ extensionId: "demo.tools", limit: 200 });
  assert.ok(recovered.some((row) => row.source === "runtime" && row.kind === "activate"));
  assert.ok(recovered.some((row) => row.source === "management" && row.operation === "reload" && row.outcome === "ok"));
  assert.ok(recovered.some((row) => row.source === "management" && row.operation === "config" && row.outcome === "ok"));
  for (let i = 1; i < recovered.length; i++) assert.ok(recovered[i].seq > recovered[i - 1].seq);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true });
});


test("H3 corrupt durable operator intent fails closed instead of re-enabling trusted packages", () => {
  const root = temp("freeseek-h3-intent-root-"); const state = temp("freeseek-h3-intent-state-"); writePackage(root, "1.0.0");
  fs.writeFileSync(path.join(state, "extension-intent.json"), "{ not-json", "utf8");
  try {
    assert.throws(() => new FileExtensionHost({ roots: [root], stateDir: state }), /extension intent state 损坏/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test("H3 durable audit rotates an oversized journal before appending new lifecycle records", () => {
  const state = temp("freeseek-h3-audit-rotate-");
  try {
    const journal = new ExtensionAuditJournal(state);
    const file = path.join(state, "extension-audit.jsonl");
    fs.writeFileSync(file, "x".repeat(8 * 1024 * 1024), "utf8");
    journal.appendManagement({ operation: "reconcile", outcome: "ok" });
    assert.ok(fs.statSync(`${file}.1`).size >= 8 * 1024 * 1024);
    const current = fs.readFileSync(file, "utf8");
    assert.match(current, /"operation":"reconcile"/);
    assert.ok(fs.statSync(file).size < 1024 * 1024, "new active audit file should be small after rotation");
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test("H3 managed health distinguishes dependency PENDING from never-active load ERROR", async () => {
  const root = temp("freeseek-h3-health-root-"); const state = temp("freeseek-h3-health-state-");
  const pendingDir = path.join(root, "pending"); const brokenDir = path.join(root, "broken");
  fs.mkdirSync(pendingDir); fs.mkdirSync(brokenDir);
  fs.writeFileSync(path.join(pendingDir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.pending", version: "1.0.0", trust: "trusted",
    requires: { extensions: ["missing.provider"] }, capabilities: { tools: true }, entry: "index.cjs",
  }));
  fs.writeFileSync(path.join(pendingDir, "index.cjs"), "module.exports = function() {};\n");
  fs.writeFileSync(path.join(brokenDir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.broken", version: "1.0.0", trust: "trusted", capabilities: {}, entry: "index.cjs",
  }));
  fs.writeFileSync(path.join(brokenDir, "index.cjs"), 'module.exports = function(){ throw new Error("activation-broken"); };\n');
  const host = new FileExtensionHost({ roots: [root], stateDir: state });
  try {
    await host.start();
    const pending = host.management.status("demo.pending");
    assert.equal(pending.health, "pending"); assert.deepEqual(pending.runtime.missingDependencies, ["missing.provider"]);
    const broken = host.management.status("demo.broken");
    assert.equal(broken.health, "error"); assert.equal(broken.lastKnownGood, false); assert.match(broken.runtime.lastError ?? "", /activation-broken/);
  } finally { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});


test("H3 durable audit bounds diagnostic payloads before persistence and projection", () => {
  const state = temp("freeseek-h3-audit-bounds-");
  try {
    const journal = new ExtensionAuditJournal(state);
    const row = journal.appendRuntime({
      seq: 1,
      ts: new Date().toISOString(),
      kind: "pending",
      extensionId: "demo.tools",
      error: "x".repeat(100_000),
      missingDependencies: Array.from({ length: 300 }, (_, index) => `dependency.${index}`),
      generations: Array.from({ length: 400 }, (_, index) => ({
        id: `extension.${index}`,
        generation: index + 1,
        version: "1.0.0",
      })),
    });
    assert.ok((row.error?.length ?? 0) <= 4096);
    assert.equal(row.missingDependencies?.length, 128);
    assert.equal(row.generations?.length, 256);
    const persisted = JSON.parse(fs.readFileSync(path.join(state, "extension-audit.jsonl"), "utf8").trim());
    assert.ok((persisted.error?.length ?? 0) <= 4096);
    assert.equal(persisted.missingDependencies?.length, 128);
    assert.equal(persisted.generations?.length, 256);
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});
