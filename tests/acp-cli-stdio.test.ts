import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

/**
 * 定位已编译的 CLI/ACP 入口。测试可在两种官方布局下运行：
 *  - tsc-fallback（scripts/test.mjs 的 tsc emit 全树到 tests/.build）→ tests/.build/src/<name>.js
 *  - esbuild（test.mjs 会把 src 入口 bundle 预置到 tests/src/）→ tests/src/<name>.js
 * 另有仓库根 src/ 与生产 dist/ 两个候选，兼容 ts-node 直跑与已构建产物。
 */
function locateCompiledEntry(entry: "acp" | "cli"): string {
  const fileName = entry === "acp" ? "acp-server.js" : "cli.js";
  const distName = entry === "acp" ? "freeseek-acp.js" : "freeseek-headless.js";
  const candidates = [
    path.join(__dirname, "..", "src", fileName),
    path.join(__dirname, "..", "..", "src", fileName),
    path.join(process.cwd(), "src", fileName),
    path.join(process.cwd(), "dist", distName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到已编译的 ${entry} 入口；请先运行 tsc emit 或 npm run compile（尝试过: ${candidates.join(", ")}）`);
}

class ChildRpc {
  private buffer = "";
  private readonly pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  readonly notifications: any[] = [];
  readonly invalidStdout: string[] = [];
  private childStderr = "";

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.childStderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let row: any;
        try { row = JSON.parse(line); }
        catch { this.invalidStdout.push(line); continue; }
        if (typeof row?.id === "number") {
          const wait = this.pending.get(row.id);
          if (!wait) continue;
          this.pending.delete(row.id);
          if (row.error) wait.reject(Object.assign(new Error(row.error.message), { code: row.error.code }));
          else wait.resolve(row.result);
        } else if (typeof row?.method === "string") {
          this.notifications.push(row);
        }
      }
    });
    // 子进程意外退出：立即拒绝所有在途请求（并附带 stderr），避免请求永久挂起
    child.on("exit", (code) => {
      const reason = new Error(`ACP 子进程退出 code=${code ?? "unknown"}；stderr=${this.childStderr.slice(0, 500)}`);
      for (const wait of this.pending.values()) wait.reject(reason);
      this.pending.clear();
    });
  }

  request(id: number, method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`ACP 请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
}

async function runEntry(entry: "acp" | "cli"): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `freesek-acp-proc-${entry}-work-`));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), `freesek-acp-proc-${entry}-sessions-`));
  const provider = http.createServer((_req, res) => sse(res, `PROC_${entry.toUpperCase()}_OK`));
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");

  const compiledModule = locateCompiledEntry(entry);
  const wrapper = entry === "acp"
    ? `require(process.argv[1]).runAcpCli(process.argv.slice(2)).then(c=>process.exitCode=c,e=>{console.error(e);process.exitCode=1})`
    : `require(process.argv[1]).runFreeSeekCli(["acp",...process.argv.slice(2)]).then(c=>process.exitCode=c,e=>{console.error(e);process.exitCode=1})`;
  const child = spawn(process.execPath, [
    "-e", wrapper, compiledModule,
    "--base-url", `http://127.0.0.1:${address.port}`,
    "--model", "proc-test",
    "--auth-type", "none",
    "--session-dir", sessions,
    "--yes",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new ChildRpc(child);
  let stderr = "";
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    const init = await rpc.request(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentCapabilities.loadSession, true);
    const created = await rpc.request(2, "session/new", { cwd: workspace, mcpServers: [] });
    assert.match(created.sessionId, /^acp-/);
    const result = await rpc.request(3, "session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: `process smoke ${entry}` }],
    });
    assert.equal(result.stopReason, "end_turn");
    await rpc.request(4, "session/close", { sessionId: created.sessionId });
    assert.ok(rpc.notifications.some((row) => row.method === "session/update" && String(row.params?.update?.content?.text ?? "").includes(`PROC_${entry.toUpperCase()}_OK`)));
    assert.deepEqual(rpc.invalidStdout, [], `ACP stdout must contain NDJSON JSON-RPC only; stderr=${stderr}`);

    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ACP ${entry} process did not exit; stderr=${stderr}`)), 3000);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, stderr);
    assert.ok(fs.existsSync(path.join(sessions, `events-${created.sessionId}.jsonl`)));
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  }
}

test("freeseek-acp process uses clean NDJSON stdio and executes a real Agent turn", async () => {
  await runEntry("acp");
});

test("unified `freeseek acp` route exposes the same ACP stdio host", async () => {
  await runEntry("cli");
});
