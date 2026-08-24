import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRuntime } from "../src/kernel/extensions/runtime";
import { ExtensionPackageWatcher } from "../src/kernel/extensions/package-watcher";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-h2-package-"));
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "freeseek-extension.json"), JSON.stringify({
    schemaVersion: 1,
    version: "1.0.0",
    trust: "trusted",
    entry: "index.cjs",
    ...manifest,
  }, null, 2));
  fs.writeFileSync(path.join(dir, "index.cjs"), "module.exports = function activate() {};\n");
}

test("H2 declarative skillRoots snapshot package SKILL.md bytes per generation", async () => {
  const root = tempRoot();
  const pkg = path.join(root, "skills-pkg");
  const skillDir = path.join(pkg, "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  writeManifest(pkg, {
    id: "pkg.skills",
    capabilities: { skills: true },
    contributions: { skillRoots: ["skills"] },
  });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: pkg-skill\ndescription: v1\n---\n# V1\n");
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root]);
  try {
    await watcher.scanNow();
    const oldLease = runtime.acquireLease();
    assert.match(oldLease.skillContributions()[0].markdown, /# V1/);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: pkg-skill\ndescription: v2\n---\n# V2\n");
    await watcher.scanNow();
    const newLease = runtime.acquireLease();
    try {
      assert.match(oldLease.skillContributions()[0].markdown, /# V1/);
      assert.match(newLease.skillContributions()[0].markdown, /# V2/);
    } finally {
      await oldLease.release();
      await newLease.release();
    }
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("H2 declarative MCP server is adapted into namespaced generation tools", async () => {
  const root = tempRoot();
  const pkg = path.join(root, "mcp-pkg");
  const server = path.join(pkg, "mock-mcp.cjs");
  writeManifest(pkg, {
    id: "pkg.mcp",
    capabilities: { mcp: true, shell: true },
    contributions: {
      mcpServers: [{ name: "demo", transport: "stdio", command: process.execPath, args: [server] }],
    },
  });
  fs.writeFileSync(server, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } });
  if (msg.method === "tools/list") return send(msg.id, { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
  if (msg.method === "resources/list") return send(msg.id, { resources: [] });
  if (msg.method === "prompts/list") return send(msg.id, { prompts: [] });
  if (msg.method === "tools/call") return send(msg.id, { content: [{ type: "text", text: String(msg.params?.arguments?.text ?? "") }] });
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } }) + "\\n");
});
`);
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root]);
  try {
    await watcher.scanNow();
    const lease = runtime.acquireLease();
    try {
      const row = lease.toolRegistrations().find((tool) => tool.name === "mcp__ext_pkg_mcp_demo__echo");
      assert.ok(row, "declarative MCP adapter should expose a generation-bound namespaced tool");
      assert.equal(row.runtime.mcpApproval, true);
      assert.equal(await row.execute({ text: "H2_OK" }, { signal: undefined } as any), "H2_OK");
      await runtime.remove("pkg.mcp");
      assert.equal(await row.execute({ text: "OLD_LEASE_OK" }, { signal: undefined } as any), "OLD_LEASE_OK");
    } finally {
      await lease.release();
    }
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("H2 declarative MCP requires explicit transport capabilities before activation", async () => {
  const root = tempRoot();
  const pkg = path.join(root, "mcp-capability-pkg");
  writeManifest(pkg, {
    id: "pkg.mcp.capability",
    capabilities: { mcp: true },
    contributions: {
      mcpServers: [{ name: "demo", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    },
  });
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root]);
  try {
    await watcher.scanNow();
    const status = runtime.status("pkg.mcp.capability");
    assert.equal(status.state, "error");
    assert.match(status.lastError ?? "", /capabilities\.shell=true/);
    assert.equal(runtime.acquireLease().toolRegistrations().length, 0);
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("H2 malformed declarative contribution shapes fail closed", async () => {
  const root = tempRoot();
  const pkg = path.join(root, "bad-contributions");
  writeManifest(pkg, {
    id: "pkg.bad.contrib",
    capabilities: { skills: true },
    contributions: { skillRoots: "skills" },
  });
  const runtime = new ExtensionRuntime();
  const watcher = new ExtensionPackageWatcher(runtime, [root]);
  try {
    await watcher.scanNow();
    const status = runtime.status("pkg.bad.contrib");
    assert.equal(status.state, "error");
    assert.match(status.lastError ?? "", /contributions\.skillRoots.*array/);
  } finally {
    await watcher.stop();
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
