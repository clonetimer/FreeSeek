#!/usr/bin/env node
/**
 * Process-level ACP v1 conformance smoke for the built FreeSeek stdio host.
 *
 * This is intentionally a raw JSON-RPC driver, not an interoperability client:
 * it validates framing/error/lifecycle contracts without counting as an
 * independent ACP ecosystem client for the M4 release gate.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function verificationBuild() {
  const marker = join(ROOT, ".freesek", "acp-verification", "build.json");
  const row = JSON.parse(readFileSync(marker, "utf8"));
  if (!row?.agentBin || !row?.kind) throw new Error("invalid ACP verification build marker");
  return row;
}

const ACP_BUILD = verificationBuild();
const ACP_BIN = ACP_BUILD.agentBin;

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function commitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function startMockProvider() {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      connection: "close",
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `CONFORMANCE_OK_${requests}` }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        requests: () => requests,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

class RpcProcess {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.frames = [];
    this.waiters = [];
    this.stderr = "";
    this.invalidStdout = [];
    this.seq = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    child.stdout.on("data", (chunk) => this.#onData(chunk));
  }

  #onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch { this.invalidStdout.push(line); continue; }
      this.frames.push(frame);
      this.#flushWaiters();
    }
  }

  #flushWaiters() {
    for (let wi = this.waiters.length - 1; wi >= 0; wi--) {
      const waiter = this.waiters[wi];
      const fi = this.frames.findIndex(waiter.predicate);
      if (fi < 0) continue;
      const [frame] = this.frames.splice(fi, 1);
      this.waiters.splice(wi, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  waitFor(predicate, timeoutMs = 5000) {
    const fi = this.frames.findIndex(predicate);
    if (fi >= 0) return Promise.resolve(this.frames.splice(fi, 1)[0]);
    return new Promise((resolveWait, reject) => {
      const waiter = { predicate, resolve: resolveWait, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`ACP frame timeout after ${timeoutMs}ms; stderr=${this.stderr.slice(-1000)}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  sendRaw(line) {
    this.child.stdin.write(line.endsWith("\n") ? line : line + "\n");
  }

  async request(method, params, timeoutMs = 10000) {
    const id = ++this.seq;
    this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
    const frame = await this.waitFor((row) => row?.id === id, timeoutMs);
    if (frame.error) {
      const error = new Error(frame.error.message || `ACP RPC ${method} failed`);
      error.code = frame.error.code;
      error.data = frame.error.data;
      throw error;
    }
    return frame.result;
  }

  async expectError(method, params, code, pattern) {
    try {
      await this.request(method, params);
      assert.fail(`${method} should fail with ${code}`);
    } catch (error) {
      assert.equal(error.code, code, `${method} error code`);
      if (pattern) assert.match(String(error.message), pattern);
    }
  }

  async close() {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    await new Promise((resolveClose) => {
      if (this.child.exitCode !== null) return resolveClose();
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); }, 3000);
      this.child.once("exit", () => { clearTimeout(timer); resolveClose(); });
    });
  }
}

async function main() {
  const output = argValue("--output", "");
  const workspace = mkdtempSync(join(tmpdir(), "freesek-acp-conformance-workspace-"));
  const sessions = mkdtempSync(join(tmpdir(), "freesek-acp-conformance-sessions-"));
  const extra = mkdtempSync(join(tmpdir(), "freesek-acp-conformance-extra-"));
  const provider = await startMockProvider();
  const checks = [];
  const pass = (name) => checks.push({ name, status: "pass" });

  const child = spawn(process.execPath, [
    ACP_BIN,
    "--base-url", provider.url,
    "--model", "acp-conformance",
    "--auth-type", "none",
    "--yes",
    "--no-skills",
    "--no-network",
    "--session-dir", sessions,
  ], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new RpcProcess(child);

  try {
    await new Promise((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });

    rpc.sendRaw("{not-json}");
    const parse = await rpc.waitFor((row) => row?.error?.code === -32700);
    assert.deepEqual(parse, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    pass("jsonrpc.parse-error-envelope");

    rpc.sendRaw("[]");
    const invalid = await rpc.waitFor((row) => row?.error?.code === -32600);
    assert.equal(invalid.id, null);
    pass("jsonrpc.batch-rejected-v1");

    rpc.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: { invalid: true }, method: "initialize", params: {} }));
    const badId = await rpc.waitFor((row) => row?.error?.code === -32600 && row?.id === null);
    assert.match(badId.error.message, /JSON-RPC id/);
    pass("jsonrpc.invalid-id-rejected");

    await rpc.expectError("session/new", { cwd: workspace, mcpServers: [] }, -32001, /initialized/);
    pass("lifecycle.initialize-required");

    await rpc.expectError("initialize", { protocolVersion: "1", clientCapabilities: {} }, -32602, /integer/);
    pass("initialize.protocol-version-type");

    const initialized = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "freesek-conformance", version: "1" },
    });
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentInfo?.name, "FreeSeek");
    assert.equal(initialized.agentCapabilities?.loadSession, true);
    assert.ok(initialized.agentCapabilities?.sessionCapabilities?.list);
    assert.ok(initialized.agentCapabilities?.sessionCapabilities?.resume);
    assert.ok(initialized.agentCapabilities?.sessionCapabilities?.close);
    assert.ok(initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories);
    pass("initialize.v1-capabilities");

    await rpc.expectError("freesek/not-a-method", {}, -32601, /Method not found/);
    pass("jsonrpc.unknown-method");

    await rpc.expectError("session/new", { cwd: "relative", mcpServers: [] }, -32602, /absolute path/);
    await rpc.expectError("session/new", { cwd: workspace }, -32602, /mcpServers must be an array/);
    pass("session.new-validates-required-shape");

    const created = await rpc.request("session/new", {
      cwd: workspace,
      additionalDirectories: [extra],
      mcpServers: [],
    });
    assert.match(created.sessionId, /^acp-/);
    assert.equal(created.modes?.currentModeId, "coder");
    const sessionId = created.sessionId;
    pass("session.new");

    const prompt = await rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "conformance prompt" }],
    }, 15000);
    assert.equal(prompt.stopReason, "end_turn");
    const update = await rpc.waitFor((row) => row?.method === "session/update" && row?.params?.sessionId === sessionId, 5000);
    assert.ok(update.params.update);
    assert.equal(provider.requests(), 1);
    pass("session.prompt-and-update");

    const listed = await rpc.request("session/list", { cwd: workspace });
    assert.ok(listed.sessions.some((row) => row.sessionId === sessionId && row.cwd === workspace));
    pass("session.list");

    const mode = await rpc.request("session/set_mode", { sessionId, modeId: "plan" });
    assert.deepEqual(mode, {});
    const modeUpdate = await rpc.waitFor((row) =>
      row?.method === "session/update" &&
      row?.params?.sessionId === sessionId &&
      row?.params?.update?.sessionUpdate === "current_mode_update", 5000);
    assert.equal(modeUpdate.params.update.currentModeId, "plan");
    pass("session.set-mode");

    await rpc.request("session/close", { sessionId });
    await rpc.expectError("session/prompt", { sessionId, prompt: [{ type: "text", text: "closed" }] }, -32602, /not active/);
    pass("session.close-releases-active-session");

    await rpc.expectError("session/resume", { sessionId, cwd: workspace, mcpServers: [] }, -32602, /additionalDirectories/);
    const resumed = await rpc.request("session/resume", {
      sessionId,
      cwd: workspace,
      additionalDirectories: [extra],
      mcpServers: [],
    });
    assert.equal(resumed.modes?.currentModeId, "plan");
    pass("session.resume-restores-mode-and-scope");

    await rpc.request("session/close", { sessionId });
    const loaded = await rpc.request("session/load", {
      sessionId,
      cwd: workspace,
      additionalDirectories: [extra],
      mcpServers: [],
    });
    assert.equal(loaded.modes?.currentModeId, "plan");
    const replayed = await rpc.waitFor((row) =>
      row?.method === "session/update" &&
      row?.params?.sessionId === sessionId &&
      row?.params?.update?.sessionUpdate === "user_message_chunk" &&
      row?.params?.update?.content?.text === "conformance prompt", 5000);
    assert.equal(replayed.params.update.content.text, "conformance prompt");
    pass("session.load-replays-history");

    assert.deepEqual(rpc.invalidStdout, []);
    pass("transport.stdout-purity");

    const report = {
      schemaVersion: 1,
      kind: "freesek-acp-v1-conformance",
      timestamp: new Date().toISOString(),
      commit: commitSha(),
      protocolVersion: 1,
      buildKind: ACP_BUILD.kind,
      checks,
      passed: checks.length,
      failed: 0,
      note: "Raw FreeSeek conformance driver; does not count as an independent ACP client for M4 interoperability.",
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (output) writeFileSync(resolve(output), text, "utf8");
    process.stdout.write(text);
  } finally {
    await rpc.close().catch(() => undefined);
    await provider.close().catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
