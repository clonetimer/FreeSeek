/**
 * Remote command-execution provider for the CommandRunner seam.
 *
 * This deliberately does not pretend that a local cwd exists remotely. A mapper must bind the
 * local workspace/cwd to a pre-provisioned remote workspace id + remote cwd. Workspace upload /
 * sync stays a separate future capability instead of being hidden inside shell execution.
 */
import * as fs from "fs";
import * as path from "path";
import type { CommandRunner } from "./seam";

export interface RemoteWorkspaceTarget {
  workspaceId: string;
  remoteCwd: string;
}

export interface RemoteSandboxRequest {
  version: 1;
  workspaceId: string;
  cwd: string;
  command: string;
  argv?: string[];
  timeoutMs: number;
  input?: string;
  networkMode: "off" | "localhost" | "allow";
  restricted: boolean;
  label?: string;
}

export interface RemoteSandboxResponse {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  sandbox?: string;
}

export interface RemoteSandboxTransport {
  execute(request: RemoteSandboxRequest, signal?: AbortSignal): Promise<RemoteSandboxResponse>;
}

export interface RemoteCommandRunnerOptions {
  transport: RemoteSandboxTransport;
  mapCwd(localCwd: string): RemoteWorkspaceTarget;
}

function isOutside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/** Static mapper for a workspace already provisioned on the remote sandbox service. */
export function createStaticRemoteWorkspaceMapper(
  localRoot: string,
  workspaceId: string,
  remoteRoot = "/workspace"
): (localCwd: string) => RemoteWorkspaceTarget {
  const localResolved = path.resolve(localRoot);
  const local = fs.existsSync(localResolved) ? fs.realpathSync(localResolved) : localResolved;
  if (!workspaceId.trim()) throw new Error("remote workspaceId 不能为空");
  return (localCwd: string) => {
    const cwdResolved = path.resolve(localCwd);
    const cwd = fs.existsSync(cwdResolved) ? fs.realpathSync(cwdResolved) : cwdResolved;
    if (isOutside(local, cwd)) throw new Error(`remote sandbox cwd 越界：${localCwd}`);
    const rel = path.relative(local, cwd);
    const remoteCwd = rel ? path.posix.join(remoteRoot.replace(/\\/g, "/"), rel.split(path.sep).join("/")) : remoteRoot;
    return { workspaceId, remoteCwd };
  };
}

function renderRemoteResult(result: RemoteSandboxResponse, timeoutMs: number): string {
  const stdout = result.stdout ? `\n--- stdout ---\n${result.stdout}` : "";
  const stderr = result.stderr ? `\n--- stderr ---\n${result.stderr}` : "";
  const tag = result.sandbox ? `[Remote Sandbox: ${result.sandbox}]\n` : "[Remote Sandbox]\n";
  if (result.cancelled) return `${tag}⛔ 远程命令已取消。${stdout}${stderr}`;
  if (result.timedOut) return `${tag}⛔ 远程命令超时（>${Math.round(timeoutMs / 1000)}s）。${stdout}${stderr}`;
  if (result.exitCode === 0) return `${tag}exit 0${stdout}${stderr}`;
  return `${tag}命令执行失败（code=${result.exitCode ?? "?"}）。${stdout}${stderr}`;
}

/** Adapt a remote transport to the existing CommandRunner capability seam. */
export function createRemoteCommandRunner(options: RemoteCommandRunnerOptions): CommandRunner {
  return {
    async run(input) {
      const target = options.mapCwd(input.cwd);
      const result = await options.transport.execute({
        version: 1,
        workspaceId: target.workspaceId,
        cwd: target.remoteCwd,
        command: input.command,
        ...(input.argv?.length ? { argv: input.argv } : {}),
        timeoutMs: input.timeoutMs,
        ...(input.input ? { input: input.input } : {}),
        networkMode: input.network.mode ?? "off",
        restricted: input.exec.restricted,
        ...(input.label ? { label: input.label } : {}),
      }, input.signal);
      return renderRemoteResult(result, input.timeoutMs);
    },
  };
}

export interface HttpRemoteSandboxTransportOptions {
  endpoint: string;
  token?: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
}

/** Minimal JSON/HTTP transport; endpoint must implement the RemoteSandboxRequest v1 contract. */
export function createHttpRemoteSandboxTransport(options: HttpRemoteSandboxTransportOptions): RemoteSandboxTransport {
  const endpoint = new URL(options.endpoint);
  if (!/^https?:$/.test(endpoint.protocol)) throw new Error("remote sandbox endpoint 仅支持 http/https");
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(endpoint.hostname);
  if (options.token && endpoint.protocol !== "https:" && !loopback) {
    throw new Error("携带 remote sandbox token 时非本机 endpoint 必须使用 HTTPS");
  }
  return {
    async execute(request, parentSignal) {
      const controller = new AbortController();
      const timeoutMs = Math.max(100, Math.min(options.requestTimeoutMs ?? request.timeoutMs + 5000, 10 * 60 * 1000));
      const timer = setTimeout(() => controller.abort(new Error("REMOTE_SANDBOX_TIMEOUT")), timeoutMs);
      const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("REMOTE_SANDBOX_CANCELLED"));
      if (parentSignal?.aborted) onAbort();
      else parentSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const headers: Record<string, string> = { "content-type": "application/json", ...(options.headers ?? {}) };
        if (options.token) headers.authorization = `Bearer ${options.token}`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`remote sandbox HTTP ${response.status}: ${text.slice(0, 1000)}`);
        const parsed = JSON.parse(text) as RemoteSandboxResponse;
        if (parsed.exitCode !== null && !Number.isInteger(parsed.exitCode)) throw new Error("remote sandbox 响应缺少合法 exitCode");
        return parsed;
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
