/**
 * Remote command-execution provider for the CommandRunner seam.
 *
 * This deliberately does not pretend that a local cwd exists remotely. A mapper must bind the
 * local workspace/cwd to a pre-provisioned remote workspace id + remote cwd. Workspace upload /
 * sync stays a separate future capability instead of being hidden inside shell execution.
 */
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
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

// ════════════════════════════════════════════════════════════════════════════
// 缺口3：远程 / 云沙箱 provider 实装
// ──────────────────────────────────────────────────────────────────────────────
// 0.24 仅定义了 RemoteSandboxTransport 接口与 HTTP 传输；本版本补齐三种可直接
// 落地运行的 provider，对标 dsh 的 e2b/landlock 实装：
//   - createLocalDockerRemoteSandboxTransport：docker exec 进一个已起容器的隔离环境
//   - createSshRemoteSandboxTransport：经 SSH 在远端主机执行（复用 ssh/ControlMaster）
//   - createE2BRemoteSandboxTransport：E2B 沙箱 API（POST /sandboxes/:id/commands）
// 三者都满足 RemoteSandboxTransport 契约，经 createRemoteCommandRunner 注入
// CommandRunner seam（seam.setCommandRunner），无需改动工具执行链路。
// ════════════════════════════════════════════════════════════════════════════

/** 本地 Docker 容器执行：把命令通过 `docker exec` 送进一个常驻容器（隔离、可配只读挂载）。 */
export interface LocalDockerRemoteSandboxOptions {
  container: string;
  /** docker 可执行文件（默认 "docker"）。 */
  docker?: string;
  /** 命令失败/超时的整进程硬超时（默认 5 分钟）。 */
  requestTimeoutMs?: number;
}

export function createLocalDockerRemoteSandboxTransport(
  options: LocalDockerRemoteSandboxOptions
): RemoteSandboxTransport {
  const docker = options.docker ?? "docker";
  const timeoutMs = options.requestTimeoutMs ?? 5 * 60 * 1000;
  return {
    async execute(req, parentSignal) {
      const args = ["exec", "-i"];
      if (req.networkMode === "off" || req.networkMode === "localhost") {
        args.push("--network", "none");
      }
      if (req.label) args.push("--workdir", req.cwd);
      args.push(options.container, "sh", "-c", req.command);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("DOCKER_SANDBOX_TIMEOUT")), timeoutMs);
      const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("DOCKER_SANDBOX_CANCEL"));
      if (parentSignal?.aborted) onAbort();
      else parentSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const proc = execFile(docker, args, {
          timeout: req.timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
          signal: controller.signal,
          ...(req.input ? { input: req.input } : {}),
        });
        const stdout = await proc;
        return { exitCode: 0, stdout: stdout.toString(), sandbox: `docker:${options.container}` };
      } catch (e: any) {
        if (e?.killed || e?.name === "AbortError") {
          return { exitCode: null, timedOut: true, cancelled: e?.name === "AbortError", sandbox: `docker:${options.container}` };
        }
        return {
          exitCode: e?.code ?? 1,
          stdout: e?.stdout ? String(e.stdout) : undefined,
          stderr: e?.stderr ? String(e.stderr) : e?.message,
          sandbox: `docker:${options.container}`,
        };
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** SSH 远端执行：依赖本机 ssh + 可选 ControlMaster 复用连接。 */
export interface SshRemoteSandboxOptions {
  /** user@host 或 host（~/.ssh/config 别名）。 */
  host: string;
  /** ssh 可执行文件（默认 "ssh"）。 */
  ssh?: string;
  /** 额外 ssh 参数（如 -p 2222、-i key.pem、-o ControlMaster=auto 等）。 */
  sshArgs?: string[];
  requestTimeoutMs?: number;
}

export function createSshRemoteSandboxTransport(options: SshRemoteSandboxOptions): RemoteSandboxTransport {
  const ssh = options.ssh ?? "ssh";
  const timeoutMs = options.requestTimeoutMs ?? 5 * 60 * 1000;
  return {
    async execute(req, parentSignal) {
      const controlled = req.networkMode === "off" ? [] : []; // SSH 层不额外封网，由远端 shell 策略负责
      const remoteCmd = `cd ${JSON.stringify(req.cwd)} 2>/dev/null || true; ${req.command}`;
      const args = [
        ...(options.sshArgs ?? []),
        options.host,
        ...controlled,
        "sh",
        "-c",
        remoteCmd,
      ];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("SSH_SANDBOX_TIMEOUT")), timeoutMs);
      const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("SSH_SANDBOX_CANCEL"));
      if (parentSignal?.aborted) onAbort();
      else parentSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const proc = execFile(ssh, args, {
          timeout: req.timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
          signal: controller.signal,
          ...(req.input ? { input: req.input } : {}),
        });
        const stdout = await proc;
        return { exitCode: 0, stdout: stdout.toString(), sandbox: `ssh:${options.host}` };
      } catch (e: any) {
        if (e?.killed || e?.name === "AbortError") {
          return { exitCode: null, timedOut: true, cancelled: e?.name === "AbortError", sandbox: `ssh:${options.host}` };
        }
        return {
          exitCode: e?.code ?? 1,
          stdout: e?.stdout ? String(e.stdout) : undefined,
          stderr: e?.stderr ? String(e.stderr) : e?.message,
          sandbox: `ssh:${options.host}`,
        };
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** E2B 云沙箱执行：调用 E2B 沙箱命令 API。 */
export interface E2BRemoteSandboxOptions {
  sandboxId: string;
  apiKey: string;
  /** E2B API 基址（默认 https://api.e2b.dev）。 */
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export function createE2BRemoteSandboxTransport(options: E2BRemoteSandboxOptions): RemoteSandboxTransport {
  const base = (options.baseUrl ?? "https://api.e2b.dev").replace(/\/$/, "");
  const url = `${base}/sandboxes/${encodeURIComponent(options.sandboxId)}/commands`;
  const timeoutMs = options.requestTimeoutMs ?? 5 * 60 * 1000;
  return {
    async execute(req, parentSignal) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("E2B_SANDBOX_TIMEOUT")), timeoutMs);
      const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("E2B_SANDBOX_CANCEL"));
      if (parentSignal?.aborted) onAbort();
      else parentSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            command: req.command,
            cwd: req.cwd,
            timeoutMs: req.timeoutMs,
            ...(req.argv?.length ? { argv: req.argv } : {}),
            ...(req.input ? { input: req.input } : {}),
          }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`E2B HTTP ${res.status}: ${text.slice(0, 500)}`);
        const parsed = JSON.parse(text) as {
          exitCode?: number; stdout?: string; stderr?: string; error?: string;
        };
        return {
          exitCode: parsed.exitCode ?? (parsed.error ? 1 : 0),
          stdout: parsed.stdout,
          stderr: parsed.stderr ?? parsed.error,
          sandbox: `e2b:${options.sandboxId}`,
        };
      } catch (e: any) {
        if (e?.name === "AbortError") {
          return { exitCode: null, cancelled: true, sandbox: `e2b:${options.sandboxId}` };
        }
        return { exitCode: 1, stderr: e?.message, sandbox: `e2b:${options.sandboxId}` };
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
