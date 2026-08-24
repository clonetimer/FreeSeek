import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import {
  DesktopAcpConnection,
  buildDesktopAcpArgs,
  buildDesktopAcpEnv,
  type DesktopAcpLaunchOptions,
} from "../desktop/acp-client";
import { webConsolePageHtml } from "./ui";
import { WEB_HOST_CAPABILITIES } from "./capabilities";

/** Web Console server options (all security-sensitive fields fail closed). */
export interface WebConsoleOptions {
  readonly host?: string;
  readonly port?: number;
  readonly workspace: string;
  readonly sessionDir?: string;
  readonly launch: DesktopAcpLaunchOptions;
  /** 自动批准工具权限；默认关闭，未批准时权限请求按取消处理（fail-closed）。 */
  readonly autoApprove?: boolean;
  readonly log?: (message: string) => void;
}

interface SseSubscriber {
  res: http.ServerResponse;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    return String(pkg.version || "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * FreeSeek Web Console Host：本地回环 HTTP 服务 + 浏览器端，经 ACP 边界复用共享 Kernel。
 *
 * 架构（与 Desktop Host 同构，不复制任何 Kernel/ToolRuntime 逻辑）：
 *   Browser → HTTP/SSE → WebConsoleServer → ACP client → freeseek-acp sidecar → Kernel
 */
export class WebConsoleServer {
  private server: http.Server | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: DesktopAcpConnection | null = null;
  private readonly token = crypto.randomBytes(24).toString("hex");
  private readonly subscribers = new Map<string, Set<SseSubscriber>>();
  private readonly replayBuffers = new Map<string, unknown[]>();
  /** 缺口4：浏览器端待处理的权限/表单请求（requestId → 解析器）。 */
  private readonly pendingPermissions = new Map<string, { resolve: (v: string | null) => void; sessionId: string }>();
  private readonly pendingElicitations = new Map<string, { resolve: (v: unknown) => void; sessionId: string }>();
  private readonly opts: WebConsoleOptions;
  private readonly log: (message: string) => void;
  private resolveClosed: (() => void) | null = null;
  private readonly closedPromise: Promise<void>;

  constructor(options: WebConsoleOptions) {
    this.opts = options;
    this.log = options.log ?? ((message) => process.stderr.write(`[web] ${message}\n`));
    this.closedPromise = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  }

  /** Resolve when the console closes (explicit stop or ACP sidecar exit). */
  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  private markClosed(): void {
    this.resolveClosed?.();
    this.resolveClosed = null;
  }

  /** Random access token; print/keep private — it authorizes full Agent control. */
  get accessToken(): string {
    return this.token;
  }

  /** Capability profile of this host (used by capability gates/tests). */
  get capabilities() {
    return WEB_HOST_CAPABILITIES;
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    const sessionDir = this.opts.sessionDir ?? path.join(os.homedir(), ".freesek", "web");
    fs.mkdirSync(sessionDir, { recursive: true });

    const launch: DesktopAcpLaunchOptions = { ...this.opts.launch, sessionDir, cwd: this.opts.workspace };
    const handlers = {
      onSessionUpdate: (params: unknown) => this.fanOutSessionUpdate(params),
      onDiagnostic: (message: string) => this.log(message.trimEnd()),
      // 缺口4：浏览器端交互审批——把请求推到 SSE，浏览器经 /api/session/respond 回传。
      requestPermission: (params: unknown): Promise<string | null> => {
        if (this.opts.autoApprove) return Promise.resolve("allow_once");
        const p = params as {
          sessionId?: string;
          toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
          options?: { optionId: string; name: string; kind: string }[];
        };
        const requestId = p.toolCall?.toolCallId ?? `perm-${crypto.randomUUID()}`;
        const sid = p.sessionId ?? "";
        return new Promise<string | null>((resolve) => {
          this.pendingPermissions.set(requestId, { resolve, sessionId: sid });
          this.fanOutSessionUpdate({
            sessionId: sid,
            update: {
              sessionUpdate: "permission_request",
              requestId,
              toolCall: p.toolCall,
              options: p.options,
            },
          });
        });
      },
      // 缺口4：浏览器端 ask_user 结构化表单——推到 SSE，浏览器经 /api/session/respond 回传。
      requestElicitation: (params: unknown): Promise<unknown> => {
        const p = params as {
          sessionId?: string;
          mode?: string;
          message?: string;
          requestedSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] };
        };
        const requestId = `elic-${crypto.randomUUID()}`;
        const sid = p.sessionId ?? "";
        return new Promise<unknown>((resolve) => {
          this.pendingElicitations.set(requestId, { resolve, sessionId: sid });
          this.fanOutSessionUpdate({
            sessionId: sid,
            update: {
              sessionUpdate: "elicitation_request",
              requestId,
              mode: p.mode,
              message: p.message,
              requestedSchema: p.requestedSchema,
            },
          });
        });
      },
    };
    const { child, connection } = this.spawnSidecar(launch, handlers);
    this.child = child;
    this.connection = connection;
    child.on("exit", () => {
      this.log("ACP sidecar exited; closing web console");
      this.markClosed();
    });
    await connection.initialize("0.24.0");

    const host = this.opts.host ?? "127.0.0.1";
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port ?? 3080, host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    const boundPort = typeof address === "object" && address ? address.port : (this.opts.port ?? 3080);
    const url = `http://${host}:${boundPort}/?token=${this.token}`;
    this.log(`FreeSeek Web Console ready: ${url}`);
    return { host, port: boundPort, url };
  }

  /**
   * 以 `node -e require(entry).runAcpCli(argv)` 方式拉起 ACP sidecar。
   * 用 wrapper 而非把入口当主脚本直接运行：入口可能是无自动运行 define 的
   * 模块产物（tsc 发射 / sidecar bundle），直接运行会加载即退出；而带自动
   * 运行 define 的 `freeseek-acp.js` 被 require 时会重复启动服务器。
   */
  private spawnSidecar(
    launch: DesktopAcpLaunchOptions,
    handlers: ConstructorParameters<typeof DesktopAcpConnection>[2]
  ): { child: ChildProcessWithoutNullStreams; connection: DesktopAcpConnection } {
    const args = buildDesktopAcpArgs(launch);
    const wrapper =
      "require(process.argv[1]).runAcpCli(process.argv.slice(2))" +
      ".then(c=>process.exitCode=c,e=>{console.error(e);process.exitCode=1})";
    const spawnOptions: SpawnOptions = {
      cwd: launch.cwd,
      env: buildDesktopAcpEnv(launch),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    const child = spawn(
      launch.nodeCommand || "node",
      ["-e", wrapper, launch.agentEntry, ...args],
      spawnOptions
    ) as ChildProcessWithoutNullStreams;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => handlers?.onDiagnostic?.(String(chunk)));
    const connection = new DesktopAcpConnection(
      child.stdout,
      child.stdin,
      handlers,
      (message) => handlers?.onDiagnostic?.(message)
    );
    return { child, connection };
  }

  async stop(): Promise<void> {
    for (const subs of this.subscribers.values()) {
      for (const sub of subs) sub.res.end();
    }
    this.subscribers.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    this.connection?.close("web-console-shutdown");
    this.connection = null;
    if (this.child && this.child.exitCode === null) {
      const child = this.child;
      const exited = new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      child.kill("SIGTERM");
      // Windows 下必须等子进程完全退出、文件句柄释放，否则目录删除会 EPERM
      await exited;
    }
    this.child = null;
    this.markClosed();
  }

  private fanOutSessionUpdate(params: unknown): void {
    const row = params as { sessionId?: string } | null;
    const sessionId = row?.sessionId;
    if (!sessionId) return;
    const replay = this.replayBuffers.get(sessionId);
    if (replay) replay.push(params);
    const subs = this.subscribers.get(sessionId);
    if (!subs || subs.size === 0) return;
    const payload = `data: ${JSON.stringify(params)}\n\n`;
    for (const sub of subs) sub.res.write(payload);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const candidate = bearer || url.searchParams.get("token") || "";
    if (candidate.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token));
  }

  /** Same-origin guard: reject cross-origin browser requests (CSRF/DNS-rebinding hardening). */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    const requestHost = req.headers.host ?? "";
    const check = (value: string): boolean => {
      try {
        return new URL(value).host === requestHost;
      } catch {
        return false;
      }
    };
    if (origin) return check(origin);
    if (referer) return check(referer);
    return true;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    if (pathname === "/" && req.method === "GET") {
      if (!this.authorized(req)) { res.writeHead(401); res.end("unauthorized"); return; }
      if (!this.sameOrigin(req)) { res.writeHead(403); res.end("forbidden"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(webConsolePageHtml());
      return;
    }
    if (!pathname.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
    if (req.method !== "GET" && req.method !== "POST") { res.writeHead(405); res.end(); return; }
    if (!this.authorized(req)) { this.json(res, 401, { error: "unauthorized" }); return; }
    if (!this.sameOrigin(req)) { this.json(res, 403, { error: "forbidden origin" }); return; }
    void this.route(pathname, url, req, res);
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private json(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }

  private async route(
    pathname: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const connection = this.connection;
    try {
      if (!connection) throw new Error("web console is not connected");
      if (pathname === "/api/health" && req.method === "GET") {
        this.json(res, 200, { ok: true, version: readVersion(), workspace: this.opts.workspace });
        return;
      }
      if (pathname === "/api/sessions" && req.method === "GET") {
        const row = (await connection.listSessions({ cwd: this.opts.workspace })) as {
          sessions?: Array<{ sessionId: string; title?: string; cwd?: string; updatedAt?: string }>;
        };
        this.json(res, 200, { sessions: row.sessions ?? [] });
        return;
      }
      const body = req.method === "POST" ? await this.readBody(req) : {};
      if (pathname === "/api/session/new") {
        const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : this.opts.workspace;
        const created = await connection.newSession(cwd);
        this.json(res, 200, { sessionId: created.sessionId });
        return;
      }
      if (pathname === "/api/session/prompt") {
        const sessionId = String(body.sessionId ?? "");
        const text = String(body.text ?? "");
        if (!sessionId || !text) throw new Error("sessionId/text required");
        const result = await connection.prompt(sessionId, text);
        this.json(res, 200, { stopReason: result.stopReason ?? "end_turn" });
        return;
      }
      if (pathname === "/api/session/cancel") {
        connection.cancel(String(body.sessionId ?? ""));
        this.json(res, 200, { ok: true });
        return;
      }
      // 缺口4：浏览器端审批/表单响应回传。resolve 对应的 pending（权限或 elicitation）。
      if (pathname === "/api/session/respond") {
        const requestId = String(body.requestId ?? "");
        if (!requestId) throw new Error("requestId required");
        if (typeof body.decision === "string") {
          const entry = this.pendingPermissions.get(requestId);
          if (!entry) throw new Error("unknown permission requestId");
          this.pendingPermissions.delete(requestId);
          // decision 形如 allow-once / reject-once；autoApprove 回退 allow_once
          entry.resolve(body.decision || "reject-once");
          this.json(res, 200, { ok: true });
          return;
        }
        if (body.fields !== undefined || body.value !== undefined) {
          const entry = this.pendingElicitations.get(requestId);
          if (!entry) throw new Error("unknown elicitation requestId");
          this.pendingElicitations.delete(requestId);
          const value = body.value !== undefined ? body.value : body.fields;
          entry.resolve(value);
          this.json(res, 200, { ok: true });
          return;
        }
        throw new Error("respond requires decision or fields/value");
      }
      if (pathname === "/api/session/set_mode") {
        const modeId = String(body.modeId ?? "");
        if (!["coder", "craft", "plan", "ask"].includes(modeId)) throw new Error("invalid modeId");
        await connection.setMode(String(body.sessionId ?? ""), modeId as "coder");
        this.json(res, 200, { ok: true });
        return;
      }
      if (pathname === "/api/session/history") {
        const sessionId = String(body.sessionId ?? "");
        const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : this.opts.workspace;
        if (!sessionId) throw new Error("sessionId required");
        const buffer: unknown[] = [];
        this.replayBuffers.set(sessionId, buffer);
        try {
          const loaded = (await connection.loadSession(sessionId, cwd)) as {
            modes?: { currentModeId?: string };
          };
          this.json(res, 200, {
            updates: buffer,
            modeId: loaded.modes?.currentModeId ?? null,
          });
        } finally {
          this.replayBuffers.delete(sessionId);
        }
        return;
      }
      if (pathname === "/api/session/events" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        if (!sessionId) throw new Error("sessionId required");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const sub: SseSubscriber = { res };
        let subs = this.subscribers.get(sessionId);
        if (!subs) { subs = new Set(); this.subscribers.set(sessionId, subs); }
        subs.add(sub);
        const keepalive = setInterval(() => {
          try { res.write(": ping\n\n"); } catch { /* connection already gone */ }
        }, 15000);
        req.on("close", () => {
          clearInterval(keepalive);
          subs!.delete(sub);
          if (subs!.size === 0) this.subscribers.delete(sessionId);
        });
        return;
      }
      this.json(res, 404, { error: "not found" });
    } catch (error: any) {
      this.json(res, 400, { error: error?.message ?? String(error) });
    }
  }
}
