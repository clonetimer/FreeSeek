import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { NdJsonRpcPeer } from "../src/hosts/acp/protocol";

function lineReader(stream: PassThrough) {
  let buffer = "";
  const rows: any[] = [];
  const waiters: Array<(row: any) => void> = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const row = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(row);
      else rows.push(row);
    }
  });
  return async () => rows.shift() ?? await new Promise<any>((resolve) => waiters.push(resolve));
}

test("ACP NDJSON peer returns JSON-RPC parse/invalid-request envelopes and rejects invalid ids", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors: string[] = [];
  const peer = new NdJsonRpcPeer(input, output, (message) => errors.push(message));
  peer.start(async (method) => ({ method }));
  const next = lineReader(output);

  input.write("{not-json}\n");
  assert.deepEqual(await next(), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

  input.write("[]\n");
  assert.deepEqual(await next(), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });

  input.write(JSON.stringify({ jsonrpc: "2.0", id: { bad: true }, method: "initialize", params: {} }) + "\n");
  assert.deepEqual(await next(), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "JSON-RPC id must be a string, finite number, or null" },
  });

  input.write(JSON.stringify({ jsonrpc: "2.0", id: "ok", method: "probe" }) + "\n");
  assert.deepEqual(await next(), { jsonrpc: "2.0", id: "ok", result: { method: "probe" } });
  assert.ok(errors.some((message) => /parse error/i.test(message)));
  peer.close("test-end");
});

test("ACP NDJSON peer accepts an EOF-terminated final frame", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new NdJsonRpcPeer(input, output);
  peer.start(async () => ({ ok: true }));
  const next = lineReader(output);
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "probe" }));
  assert.deepEqual(await next(), { jsonrpc: "2.0", id: 7, result: { ok: true } });
  await peer.waitForClose();
});
