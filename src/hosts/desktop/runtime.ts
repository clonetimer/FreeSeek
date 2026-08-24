import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  spawnDesktopAcpConnection,
  type DesktopAcpConnection,
  type DesktopAcpHandlers,
  type DesktopAcpLaunchOptions,
  type DesktopAcpMcpServer,
} from "./acp-client";

/** Launch contract for one Desktop-owned ACP session. */
export interface DesktopRuntimeStartOptions {
  readonly clientVersion: string;
  readonly workspace: string;
  readonly acp: DesktopAcpLaunchOptions;
  readonly session?: {
    readonly additionalDirectories?: readonly string[];
    readonly mcpServers?: readonly DesktopAcpMcpServer[];
  };
}

/** Desktop Host lifecycle callbacks that are independent from Electron. */
export interface DesktopRuntimeHandlers extends DesktopAcpHandlers {
  onSessionChanged?(sessionId: string): void;
  onChildExit?(code: number | null, signal: NodeJS.Signals | null): void;
}

/**
 * Owns one Desktop ACP child process and one active FreeSeek session.
 *
 * This controller deliberately has no Electron dependency. BrowserWindow/IPC
 * are presentation adapters over this lifecycle, while all Agent execution
 * remains behind the stable ACP process boundary.
 */
export class DesktopRuntimeController {
  private connection: DesktopAcpConnection | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private activeSessionId = "";
  private generation = 0;

  constructor(private readonly handlers: DesktopRuntimeHandlers = {}) {}

  /** Return the currently active ACP session id, or an empty string when idle. */
  get sessionId(): string { return this.activeSessionId; }

  /** Whether the controller currently owns a live ACP connection. */
  get connected(): boolean { return this.connection !== null; }

  /** Start an initialized ACP sidecar without creating a session yet. */
  async connect(options: DesktopRuntimeStartOptions): Promise<void> {
    await this.stop("desktop-reconnect");
    await this.launch(options);
  }

  /** Spawn ACP, initialize the protocol and create a new durable session. */
  async start(options: DesktopRuntimeStartOptions): Promise<{ sessionId: string }> {
    await this.connect(options);
    try {
      const created = await this.connection!.newSession(options.workspace, options.session);
      this.setSession(created.sessionId);
      return { sessionId: created.sessionId };
    } catch (error) {
      await this.stop("desktop-start-failed");
      throw error;
    }
  }

  /** Reconnect ACP and resume a durable session in the same authorized workspace. */
  async resume(options: DesktopRuntimeStartOptions, sessionId: string): Promise<{ sessionId: string }> {
    await this.connect(options);
    try {
      await this.connection!.resumeSession(sessionId, options.workspace, options.session);
      this.setSession(sessionId);
      return { sessionId };
    } catch (error) {
      await this.stop("desktop-resume-failed");
      throw error;
    }
  }

  /** Reconnect ACP, restore a durable session and replay its history to presentation callbacks. */
  async load(options: DesktopRuntimeStartOptions, sessionId: string): Promise<{ sessionId: string }> {
    await this.connect(options);
    try {
      await this.connection!.loadSession(sessionId, options.workspace, options.session);
      this.setSession(sessionId);
      return { sessionId };
    } catch (error) {
      await this.stop("desktop-load-failed");
      throw error;
    }
  }

  /** Submit one prompt to the active session. */
  async prompt(text: string, signal?: AbortSignal): Promise<{ stopReason?: string }> {
    const { connection, sessionId } = this.requireActive();
    return connection.prompt(sessionId, text, signal);
  }

  /** Change the active Agent mode through ACP. */
  async setMode(mode: "coder" | "craft" | "plan" | "ask"): Promise<void> {
    const { connection, sessionId } = this.requireActive();
    await connection.setMode(sessionId, mode);
  }

  /** Cancel the current turn without killing the desktop sidecar. */
  cancel(): void {
    const { connection, sessionId } = this.requireActive();
    connection.cancel(sessionId);
  }

  /** List durable sessions visible to this ACP sidecar. */
  async listSessions(cwd?: string): Promise<unknown> {
    if (!this.connection) return { sessions: [] };
    return this.connection.listSessions(cwd ? { cwd } : {});
  }

  async extensionsList(): Promise<unknown> {
    if (!this.connection) return { trustRoots: [], extensions: [] };
    return this.connection.extensionsList();
  }

  async extensionReload(id: string): Promise<unknown> {
    if (!this.connection) throw new Error("Desktop ACP 尚未连接");
    return this.connection.extensionReload(id);
  }

  async extensionRemove(id: string): Promise<unknown> {
    if (!this.connection) throw new Error("Desktop ACP 尚未连接");
    return this.connection.extensionRemove(id);
  }

  async extensionConfigure(id: string, enabled: boolean): Promise<unknown> {
    if (!this.connection) throw new Error("Desktop ACP 尚未连接");
    return this.connection.extensionConfigure(id, enabled);
  }

  async extensionsReconcile(): Promise<unknown> {
    if (!this.connection) throw new Error("Desktop ACP 尚未连接");
    return this.connection.extensionsReconcile();
  }

  async extensionAudit(id?: string, limit = 100): Promise<unknown> {
    if (!this.connection) return { events: [] };
    return this.connection.extensionAudit(id, limit);
  }

  /** Close the active session but keep its durable EventLog for later resume. */
  async closeSession(): Promise<void> {
    if (!this.connection || !this.activeSessionId) return;
    const sessionId = this.activeSessionId;
    await this.connection.closeSession(sessionId);
    this.setSession("");
  }

  /** Tear down session and ACP transport. Safe to call repeatedly. */
  async stop(reason = "desktop-stop"): Promise<void> {
    const connection = this.connection;
    const child = this.child;
    const sessionId = this.activeSessionId;
    this.generation++;
    this.connection = null;
    this.child = null;
    this.setSession("");
    if (sessionId && connection) {
      try { await connection.closeSession(sessionId); } catch { /* transport may already be closed */ }
    }
    connection?.close(reason);
    if (child && child.exitCode === null) {
      if (!child.killed) child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, 1_500);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }


  private async launch(options: DesktopRuntimeStartOptions): Promise<void> {
    const generation = ++this.generation;
    const launched = spawnDesktopAcpConnection(options.acp, this.handlers);
    this.child = launched.child;
    this.connection = launched.connection;
    launched.child.once("exit", (code, signal) => {
      if (this.generation !== generation) return;
      this.connection?.close("desktop-acp-exit");
      this.connection = null;
      this.child = null;
      this.setSession("");
      this.handlers.onChildExit?.(code, signal);
    });
    try {
      await launched.connection.initialize(options.clientVersion);
    } catch (error) {
      await this.stop("desktop-connect-failed");
      throw error;
    }
  }

  private setSession(sessionId: string): void {
    if (this.activeSessionId === sessionId) return;
    this.activeSessionId = sessionId;
    this.handlers.onSessionChanged?.(sessionId);
  }

  private requireActive(): { connection: DesktopAcpConnection; sessionId: string } {
    if (!this.connection || !this.activeSessionId) throw new Error("Desktop ACP 尚未启动活动会话");
    return { connection: this.connection, sessionId: this.activeSessionId };
  }
}
