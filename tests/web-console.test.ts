import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebConsoleServer } from "../src/hosts/web/console";
import { WEB_HOST_CAPABILITIES } from "../src/hosts/web/capabilities";

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** 定位无自动运行 define 的 ACP 模块入口（跨 esbuild / tsc-fallback / dist 布局）。 */
function locateCompiledAcp(): string {
  const candidates = [
    path.join(__dirname, "..", "src", "acp-server.js"),
    path.join(__dirname, "..", "..", "src", "acp-server.js"),
    path.join(process.cwd(), "src", "acp-server.js"),
    path.join(process.cwd(), "dist", "freeseek-acp-sidecar.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到已编译的 ACP 入口（尝试过: ${candidates.join(", ")}）`);
}

async function startConsole(opts: { autoApprove?: boolean } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-web-workspace-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-web-sessions-"));
  const provider = http.createServer((_req, res) => sse(res, "WEB_CONSOLE_OK"));
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const server = new WebConsoleServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    sessionDir: sessions,
    autoApprove: opts.autoApprove ?? true,
    launch: {
      agentEntry: locateCompiledAcp(),
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "web-test",
      authType: "none",
      sessionDir: sessions,
    },
    log: () => undefined,
  });
  const started = await server.start();
  return {
    server, provider, workspace, sessions, started,
    async close(): Promise<void> {
      await server.stop();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      const rmSafe = async (dir: string): Promise<void> => {
        // Windows 下子进程句柄释放可能有延迟，短暂重试避免 EPERM 误报
        for (let attempt = 0; attempt < 4; attempt++) {
          try { fs.rmSync(dir, { recursive: true, force: true }); return; }
          catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
        }
      };
      await rmSafe(workspace);
      await rmSafe(sessions);
    },
  };
}

function call(ctx: { started: { port: number }; server: WebConsoleServer }, pathname: string, init: RequestInit & { origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.server.accessToken}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.origin) headers.origin = init.origin;
  return fetch(`http://127.0.0.1:${ctx.started.port}${pathname}`, { ...init, headers });
}

test("Web Console serves the browser UI only with a valid token", async () => {
  const ctx = await startConsole();
  try {
    const ok = await fetch(`http://127.0.0.1:${ctx.started.port}/?token=${ctx.server.accessToken}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /FreeSeek Web Console/);
    const denied = await fetch(`http://127.0.0.1:${ctx.started.port}/`);
    assert.equal(denied.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${ctx.started.port}/?token=not-the-token`);
    assert.equal(wrong.status, 401);
    const health = await fetch(`http://127.0.0.1:${ctx.started.port}/api/health`);
    assert.equal(health.status, 401);
  } finally {
    await ctx.close();
  }
});

test("Web Console rejects cross-origin browser requests", async () => {
  const ctx = await startConsole();
  try {
    const res = await call(ctx, "/api/sessions", { origin: "http://evil.example" });
    assert.equal(res.status, 403);
  } finally {
    await ctx.close();
  }
});

test("Web Console completes a real Agent turn over HTTP+SSE via the ACP boundary", async () => {
  const ctx = await startConsole();
  try {
    const created = await call(ctx, "/api/session/new", { method: "POST", body: "{}" });
    assert.equal(created.status, 200);
    const { sessionId } = (await created.json()) as { sessionId: string };
    assert.match(sessionId, /^acp-/);

    // 先挂 SSE，再提交 prompt，验证流式投影
    const sseResponse = await fetch(
      `http://127.0.0.1:${ctx.started.port}/api/session/events?sessionId=${sessionId}&token=${ctx.server.accessToken}`
    );
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    const collected: unknown[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const block of decoder.decode(value, { stream: true }).split("\n\n")) {
          const line = block.trim();
          if (!line.startsWith("data: ")) continue;
          try { collected.push(JSON.parse(line.slice(6))); } catch { /* partial frame */ }
        }
      }
    })();

    const prompt = await call(ctx, "/api/session/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, text: "web console smoke" }),
    });
    assert.equal(prompt.status, 200);
    const result = (await prompt.json()) as { stopReason?: string };
    assert.equal(result.stopReason, "end_turn");

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await reader.cancel();
    await pump.catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(
      (ctx.server as any).subscribers.size,
      0,
      "closing the SSE response must remove its subscriber and release the heartbeat timer"
    );
    const updates = collected.map((row: any) => row?.update).filter(Boolean);
    assert.ok(
      updates.some((u: any) => u?.sessionUpdate === "agent_message_chunk"
        && String(u?.content?.text ?? "").includes("WEB_CONSOLE_OK")),
      `expected streamed assistant chunk, got ${JSON.stringify(updates).slice(0, 400)}`
    );

    const listed = await call(ctx, "/api/sessions");
    const list = (await listed.json()) as { sessions: Array<{ sessionId: string }> };
    assert.ok(list.sessions.some((row) => row.sessionId === sessionId));
  } finally {
    await ctx.close();
  }
});


test("Web Console shutdown closes active SSE responses and clears their heartbeat timers", async () => {
  const ctx = await startConsole();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const sessionId = "web-console-shutdown-sse";
    const response = await fetch(
      `http://127.0.0.1:${ctx.started.port}/api/session/events?sessionId=${sessionId}&token=${ctx.server.accessToken}`
    );
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    await reader.read();
    const active = (ctx.server as any).subscribers.get(sessionId) as Set<{ res: import("node:http").ServerResponse }>;
    assert.equal(active?.size, 1, "the SSE client should be registered before shutdown");
    const serverResponse = [...active][0].res;
    // Stop ends the response; cancel the browser reader concurrently so server.close can finish its socket drain.
    const stopping = ctx.server.stop();
    await reader.cancel();
    await stopping;
    assert.equal(serverResponse.writableEnded, true, "server shutdown must end the browser SSE response");
    assert.equal((ctx.server as any).subscribers.size, 0);
  } finally {
    await reader?.cancel().catch(() => undefined);
    await ctx.close();
  }
});

test("Web Console host declares control-plane capabilities without editor-native claims", () => {
  assert.equal(WEB_HOST_CAPABILITIES.kind, "web");
  assert.equal(WEB_HOST_CAPABILITIES.interactiveInput, true);
  assert.equal(WEB_HOST_CAPABILITIES.persistentSessions, true);
  assert.equal(WEB_HOST_CAPABILITIES.diffReview, false);
  assert.equal(WEB_HOST_CAPABILITIES.lsp, false);
  assert.equal(WEB_HOST_CAPABILITIES.imageInput, false);
});
