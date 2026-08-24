/** CLI runtime service assembly: skills + MCP without VS Code activation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCliRuntimeServices } from "../src/hosts/cli/runtime-services";

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("CLI assembles project/user skills without VS Code", async () => {
  const root = tempRoot("freesek-cli-services-");
  const extra = path.join(root, "extra-skills", "sample");
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, "SKILL.md"), [
    "---",
    "name: sample",
    "description: sample skill",
    "triggers: [sample]",
    "status: active",
    "---",
    "# Sample",
  ].join("\n"));
  const services = await createCliRuntimeServices({ workspace: root, skillDirs: [path.dirname(extra)] });
  try {
    assert.equal(services.mcpEnabled, false);
    assert.ok(services.skillManager.hasSkills(), "builtin skills should be available");
    assert.ok(services.skillManager.listAll().some((skill) => skill.name === "sample"));
    assert.ok(services.toolDefinitions.some((tool) => tool.function.name === "load_skill"));
  } finally {
    services.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI MCP config discovers dynamic tools and executes through its host-owned MCP manager", async () => {
  const root = tempRoot("freesek-cli-mcp-");
  const server = path.join(root, "mock-mcp.cjs");
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
  const config = path.join(root, "mcp.json");
  fs.writeFileSync(config, JSON.stringify([{ name: "demo", transport: "stdio", command: process.execPath, args: [server] }]));
  const services = await createCliRuntimeServices({ workspace: root, mcpConfig: config });
  try {
    assert.equal(services.mcpEnabled, true);
    assert.ok(services.toolDefinitions.some((tool) => tool.function.name === "mcp__demo__echo"));
    assert.equal(await services.mcpManager.callTool("mcp__demo__echo", { text: "M1_OK" }), "M1_OK");
  } finally {
    services.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
