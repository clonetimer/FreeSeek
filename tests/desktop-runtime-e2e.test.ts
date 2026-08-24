import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DesktopRuntimeController } from "../src/hosts/desktop/runtime";

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

/**
 * 定位已编译的 ACP 入口。兼容两种官方测试布局：
 *  - tsc-fallback（scripts/test.mjs 的 tsc emit 全树到 tests/.build）→ tests/.build/src/acp-server.js
 *  - esbuild（test.mjs 会把 src 入口 bundle 预置到 tests/src/）→ tests/src/acp-server.js
 * 另有仓库根 src/ 与生产 dist/ 两个候选，兼容 ts-node 直跑与已构建产物。
 */
function locateCompiledAcp(): string {
  const candidates = [
    path.join(__dirname, "..", "src", "acp-server.js"),
    path.join(__dirname, "..", "..", "src", "acp-server.js"),
    path.join(process.cwd(), "src", "acp-server.js"),
    path.join(process.cwd(), "dist", "freeseek-acp.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到已编译的 ACP 入口；请先运行 tsc emit 或 npm run compile（尝试过: ${candidates.join(", ")}）`);
}

function writeAcpWrapper(wrapperDir: string): string {
  const compiledAcp = locateCompiledAcp();
  const wrapper = path.join(wrapperDir, "run-acp.cjs");
  fs.writeFileSync(wrapper, [
    `const { runAcpCli } = require(${JSON.stringify(compiledAcp)});`,
    "runAcpCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });",
  ].join("\n"));
  return wrapper;
}

test("Desktop runtime owns a real ACP child and completes an Agent turn without Electron", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-desktop-runtime-work-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-desktop-runtime-sessions-"));
  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-desktop-runtime-wrapper-"));
  const wrapper = writeAcpWrapper(wrapperDir);

  const provider = http.createServer((_req, res) => sse(res, "DESKTOP_RUNTIME_E2E_OK"));
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");

  const updates: unknown[] = [];
  const diagnostics: string[] = [];
  const sessionChanges: string[] = [];
  const runtime = new DesktopRuntimeController({
    onSessionUpdate: (payload) => updates.push(payload),
    onDiagnostic: (message) => diagnostics.push(message),
    onSessionChanged: (sessionId) => sessionChanges.push(sessionId),
  });

  try {
    const started = await runtime.start({
      clientVersion: "0.20.0-dev.1",
      workspace,
      acp: {
        nodeCommand: process.execPath,
        agentEntry: wrapper,
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "desktop-e2e",
        authType: "none",
        sessionDir: sessions,
        cwd: workspace,
      },
    });
    assert.match(started.sessionId, /^acp-/);
    assert.equal(runtime.connected, true);
    assert.equal(runtime.sessionId, started.sessionId);

    const result = await runtime.prompt("Desktop host real ACP E2E");
    assert.equal(result.stopReason, "end_turn");
    assert.ok(updates.some((row: any) => row?.update?.sessionUpdate === "agent_message_chunk"
      && String(row?.update?.content?.text ?? "").includes("DESKTOP_RUNTIME_E2E_OK")));

    await runtime.setMode("plan");
    const listed = await runtime.listSessions() as any;
    assert.ok(listed.sessions.some((row: any) => row.sessionId === started.sessionId));
    assert.ok(fs.existsSync(path.join(sessions, `events-${started.sessionId}.jsonl`)), "Desktop runtime must use durable ACP EventLog storage");

    await runtime.closeSession();
    assert.equal(runtime.sessionId, "");

    await runtime.connect({
      clientVersion: "0.20.0-dev.2",
      workspace,
      acp: {
        nodeCommand: process.execPath, agentEntry: wrapper, baseUrl: `http://127.0.0.1:${address.port}`,
        model: "desktop-e2e", authType: "none", sessionDir: sessions, cwd: workspace,
      },
    });
    const history = await runtime.listSessions(workspace) as any;
    assert.ok(history.sessions.some((row: any) => row.sessionId === started.sessionId));

    const resumed = await runtime.resume({
      clientVersion: "0.20.0-dev.2",
      workspace,
      acp: {
        nodeCommand: process.execPath, agentEntry: wrapper, baseUrl: `http://127.0.0.1:${address.port}`,
        model: "desktop-e2e", authType: "none", sessionDir: sessions, cwd: workspace,
      },
    }, started.sessionId);
    assert.equal(resumed.sessionId, started.sessionId);
    assert.equal(runtime.sessionId, started.sessionId);
    const resumedResult = await runtime.prompt("Desktop resumed session E2E");
    assert.equal(resumedResult.stopReason, "end_turn");
    await runtime.closeSession();

    assert.ok(sessionChanges.includes(started.sessionId));
    assert.equal(sessionChanges.at(-1), "");
    assert.equal(diagnostics.some((line) => /Unsupported ACP client method/.test(line)), false);
  } finally {
    await runtime.stop("desktop-e2e-cleanup");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.rmSync(wrapperDir, { recursive: true, force: true });
  }
});

test("Desktop runtime reloads the same durable session after ACP dies mid-prompt", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-desktop-crash-work-"));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-desktop-crash-sessions-"));
  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-desktop-crash-wrapper-"));
  const wrapper = writeAcpWrapper(wrapperDir);

  let hangingResponse: http.ServerResponse | null = null;
  const destroyHangingResponse = (): void => {
    const response: http.ServerResponse | null = hangingResponse;
    hangingResponse = null;
    response?.destroy();
  };
  let resolveRequest!: () => void;
  const requestSeen = new Promise<void>((resolve) => { resolveRequest = resolve; });
  const interruptProvider = http.createServer((_req, res) => {
    hangingResponse = res;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" });
    resolveRequest();
  });
  await new Promise<void>((resolve) => interruptProvider.listen(0, "127.0.0.1", resolve));
  const interruptAddress = interruptProvider.address();
  assert.ok(interruptAddress && typeof interruptAddress === "object");

  const first = new DesktopRuntimeController();
  const second = new DesktopRuntimeController();
  let resumeProvider: http.Server | null = null;
  try {
    const baseAcp = { model: "desktop-crash-e2e", authType: "none" as const, sessionDir: sessions, cwd: workspace };
    const started = await first.start({
      clientVersion: "0.20.0-dev.3", workspace,
      acp: { ...baseAcp, nodeCommand: process.execPath, agentEntry: wrapper, baseUrl: `http://127.0.0.1:${interruptAddress.port}` },
    });
    const interruptedPrompt = first.prompt("Desktop crash recovery E2E").catch(() => undefined);
    await Promise.race([requestSeen, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("interrupted provider request not observed")), 5_000))]);

    const child = (first as any).child as { kill(signal?: NodeJS.Signals): boolean; once(event: string, cb: () => void): void } | null;
    assert.ok(child, "Desktop runtime must own an ACP child before crash simulation");
    const exited = new Promise<void>((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    destroyHangingResponse();
    await interruptedPrompt;
    await new Promise<void>((resolve) => interruptProvider.close(() => resolve()));

    resumeProvider = http.createServer((_req, res) => sse(res, "DESKTOP_CRASH_RECOVERY_OK"));
    await new Promise<void>((resolve) => resumeProvider!.listen(0, "127.0.0.1", resolve));
    const resumeAddress = resumeProvider.address();
    assert.ok(resumeAddress && typeof resumeAddress === "object");
    const loaded = await second.load({
      clientVersion: "0.20.0-dev.3", workspace,
      acp: { ...baseAcp, nodeCommand: process.execPath, agentEntry: wrapper, baseUrl: `http://127.0.0.1:${resumeAddress.port}` },
    }, started.sessionId);
    assert.equal(loaded.sessionId, started.sessionId);
    const recovered = await second.prompt("Desktop recovered after ACP crash");
    assert.equal(recovered.stopReason, "end_turn");
  } finally {
    destroyHangingResponse();
    await first.stop("desktop-crash-first-cleanup");
    await second.stop("desktop-crash-second-cleanup");
    if (interruptProvider.listening) await new Promise<void>((resolve) => interruptProvider.close(() => resolve()));
    if (resumeProvider?.listening) await new Promise<void>((resolve) => resumeProvider!.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.rmSync(wrapperDir, { recursive: true, force: true });
  }
});
