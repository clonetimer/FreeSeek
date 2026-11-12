import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { McpConnection, isLegacySseFallbackError } from "../src/mcp-sdk";

const modernMeta = {
  resultType: "complete",
  ttlMs: 0,
  cacheScope: "public",
};

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function modernResult(method: string): any {
  if (method === "server/discover") {
    return {
      ...modernMeta,
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, resources: {}, prompts: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-fixture", version: "1.0.0" } },
      instructions: "Modern MCP fixture",
    };
  }
  if (method === "tools/list") {
    return {
      ...modernMeta,
      tools: [{ name: "lookup", description: "Fixture lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    };
  }
  if (method === "resources/list") {
    return { ...modernMeta, resources: [{ uri: "fixture://readme", name: "Fixture README", description: "Fixture resource" }] };
  }
  if (method === "prompts/list") {
    return { ...modernMeta, prompts: [{ name: "explain", description: "Explain a topic", arguments: [{ name: "topic", required: true }] }] };
  }
  if (method === "tools/call") {
    return { ...modernMeta, content: [{ type: "text", text: "lookup-result: " + "MCP SDK v2" }], structuredContent: { source: "fixture" } };
  }
  if (method === "resources/read") {
    return { ...modernMeta, contents: [{ uri: "fixture://readme", mimeType: "text/plain", text: "modern resource body" }] };
  }
  if (method === "prompts/get") {
    return { ...modernMeta, messages: [{ role: "user", content: { type: "text", text: "Explain MCP SDK v2" } }] };
  }
  return {};
}

test("MCP SDK v2: modern Streamable HTTP negotiates 2026-07-28 and preserves tools/resources/prompts", async () => {
  const methods: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") {
      res.writeHead(404); res.end(); return;
    }
    const message = await readJsonBody(req);
    methods.push(message.method);
    const body = { jsonrpc: "2.0", id: message.id, result: modernResult(message.method) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const url = await listen(server);
  const connection = new McpConnection("modern", { name: "modern", transport: "http", url });
  try {
    await connection.connect();
    assert.deepEqual(connection.tools.map((tool) => tool.name), ["lookup"]);
    assert.deepEqual(connection.resources.map((resource) => resource.uri), ["fixture://readme"]);
    assert.deepEqual(connection.prompts.map((prompt) => prompt.name), ["explain"]);
    assert.ok(methods.includes("server/discover"), "the SDK must negotiate the modern protocol before using tools");
    assert.ok(methods.includes("tools/list"));
    assert.ok(methods.includes("resources/list"));
    assert.ok(methods.includes("prompts/list"));

    const tool = await connection.callTool("mcp__modern__lookup", { query: "sdk" });
    assert.match(tool, /lookup-result: MCP SDK v2/);
    assert.match(tool, /Structured content/);
    assert.equal(await connection.readResource("fixture://readme"), "modern resource body");
    assert.match(await connection.getPrompt("explain", { topic: "sdk" }), /Explain MCP SDK v2/);
  } finally {
    await connection.close();
    await closeServer(server);
  }
});

test("MCP SDK v2: legacy stdio servers remain compatible and environment inheritance stays restricted", async () => {
  const previousSecret = process.env.FREESEEK_TEST_SECRET;
  process.env.FREESEEK_TEST_SECRET = "must-not-inherit";
  const fixture = String.raw`
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    function reply(id, result) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    }
    rl.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method === "server/discover") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }) + "\n");
      } else if (message.method === "initialize") {
        reply(message.id, { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "legacy-fixture", version: "1.0.0" } });
      } else if (message.method === "tools/list") {
        reply(message.id, { tools: [{ name: "env_probe", description: "Check child environment", inputSchema: { type: "object", properties: {} } }] });
      } else if (message.method === "resources/list") {
        reply(message.id, { resources: [] });
      } else if (message.method === "prompts/list") {
        reply(message.id, { prompts: [] });
      } else if (message.method === "tools/call") {
        reply(message.id, { content: [{ type: "text", text: JSON.stringify({ explicit: process.env.MCP_FIXTURE_VALUE ?? null, secret: process.env.FREESEEK_TEST_SECRET ?? null }) }] });
      }
    });
  `;
  const connection = new McpConnection("legacy", {
    name: "legacy",
    transport: "stdio",
    command: process.execPath,
    args: ["-e", fixture],
    env: { MCP_FIXTURE_VALUE: "explicit-config-value" },
  });
  try {
    await connection.connect();
    assert.deepEqual(connection.tools.map((tool) => tool.name), ["env_probe"]);
    const output = await connection.callTool("mcp__legacy__env_probe", {});
    assert.match(output, /explicit-config-value/);
    assert.match(output, /"secret":null/);
  } finally {
    await connection.close();
    if (previousSecret === undefined) delete process.env.FREESEEK_TEST_SECRET;
    else process.env.FREESEEK_TEST_SECRET = previousSecret;
  }
});

test("MCP SDK v2: old SSE-only endpoints use the legacy SSE transport after a 405", async () => {
  let sseConnections = 0;
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "POST" && pathname === "/mcp") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Streamable HTTP is not supported");
      return;
    }
    if (req.method === "GET" && pathname === "/mcp") {
      sseConnections++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      streams.add(res);
      res.once("close", () => streams.delete(res));
      res.write("event: endpoint\ndata: /messages?session=legacy\n\n");
      return;
    }
    if (req.method === "POST" && pathname === "/messages") {
      const message = await readJsonBody(req);
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "sse-fixture", version: "1.0.0" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "sse_lookup", description: "Legacy SSE tool", inputSchema: { type: "object", properties: {} } }] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "legacy-sse-result" }] }
            : {};
      if (message.id !== undefined) {
        const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`;
        for (const stream of streams) stream.write(frame);
      }
      res.writeHead(202); res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  const url = await listen(server);
  const connection = new McpConnection("sse", { name: "sse", transport: "http", url });
  try {
    await connection.connect();
    assert.equal(sseConnections, 1);
    assert.deepEqual(connection.tools.map((tool) => tool.name), ["sse_lookup"]);
    assert.match(await connection.callTool("mcp__sse__sse_lookup", {}), /legacy-sse-result/);
  } finally {
    await connection.close();
    for (const stream of streams) stream.end();
    await closeServer(server);
  }
});

test("MCP SDK v2: authentication failures never downgrade to legacy SSE", async () => {
  let sseConnections = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET") sseConnections++;
    res.writeHead(req.method === "POST" ? 401 : 200, { "content-type": req.method === "POST" ? "text/plain" : "text/event-stream" });
    res.end(req.method === "POST" ? "Unauthorized" : "event: endpoint\ndata: /messages\n\n");
  });
  const url = await listen(server);
  const connection = new McpConnection("auth", { name: "auth", transport: "http", url });
  try {
    await assert.rejects(() => connection.connect(), /401|authorization|Unauthorized/i);
    assert.equal(sseConnections, 0);
  } finally {
    await connection.close();
    await closeServer(server);
  }
});

test("MCP SDK v2: SSE fallback classifier only accepts narrow legacy HTTP statuses", () => {
  const httpError = (status: number): SdkHttpError =>
    new SdkHttpError(SdkErrorCode.EraNegotiationFailed, `HTTP ${status}`, { status });
  for (const status of [404, 405, 406, 415]) {
    assert.equal(isLegacySseFallbackError(httpError(status)), true, `HTTP ${status} is a legacy transport signal`);
  }
  for (const status of [400, 401, 403, 429, 500, 501, 503]) {
    assert.equal(isLegacySseFallbackError(httpError(status)), false, `HTTP ${status} must not trigger transport downgrade`);
  }
  assert.equal(isLegacySseFallbackError(new Error("network failure")), false);
});
