import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import type { ToolRuntimeSpec } from "../../tool-runtime-spec";
import { SANDBOX_WORKER_BOOTSTRAP } from "./sandbox-worker-bootstrap";
import {
  resolveSandboxReadPath,
  resolveSandboxWritePath,
  type ResolvedExtensionSandboxGrant,
} from "./sandbox-policy";

const IPC_VERSION = 1;
const MAX_PROTOCOL_LINE = 512 * 1024;
const MAX_CALL_BYTES = 256 * 1024;
const MAX_FILE_BROKER_BYTES = 1024 * 1024;
const MAX_NETWORK_RESPONSE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PACKAGE_FILES = 512;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const ACTIVATION_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const MAX_CALL_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 250;
const DISPOSE_GRACE_MS = 500;

export type SandboxWorkerState = "starting" | "running" | "crashed" | "stopped";

export interface SandboxToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  runtime: Omit<ToolRuntimeSpec, "name">;
}

export interface SandboxWorkerStatus {
  mode: "sandbox";
  state: SandboxWorkerState;
  platform: "linux";
  isolation: "linux-user-mount-pid-ipc-uts-net-chroot-node-permission-broker-v1";
  pid?: number;
  lastError?: string;
}

export type SandboxLifecycleKind =
  | "sandbox-spawn"
  | "sandbox-ready"
  | "sandbox-timeout"
  | "sandbox-crash"
  | "sandbox-protocol"
  | "sandbox-dispose";

export interface SandboxWorkerOptions {
  packageDir: string;
  entry: string;
  manifest: Record<string, unknown>;
  generation: number;
  grant: ResolvedExtensionSandboxGrant;
  onLifecycle?: (event: { kind: SandboxLifecycleKind; pid?: number; error?: string }) => void;
}

interface PendingCall {
  tool: string;
  resolve(value: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
}

let capabilityProbe: { ok: boolean; reason?: string } | undefined;

function commandPath(name: string): string | undefined {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return undefined;
  const resolved = String(result.stdout ?? "").trim().split(/\r?\n/, 1)[0];
  return resolved && path.isAbsolute(resolved) && fs.existsSync(resolved) ? fs.realpathSync(resolved) : undefined;
}

function commandExists(name: string): boolean {
  return commandPath(name) !== undefined;
}

/** H4 local untrusted execution is intentionally Linux-only until equivalent enforcement is proven elsewhere. */
export function probeLinuxExtensionSandbox(): { ok: boolean; reason?: string } {
  if (capabilityProbe) return { ...capabilityProbe };
  if (process.platform !== "linux") return capabilityProbe = { ok: false, reason: `H4 local sandbox 当前仅支持 Linux；platform=${process.platform}` };
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 22) return capabilityProbe = { ok: false, reason: `H4 local sandbox 要求 Node >=22 Permission Model；当前 ${process.version}` };
  for (const command of ["unshare", "mount", "chroot", "ldd", "/bin/sh"]) {
    if (command.startsWith("/") ? !fs.existsSync(command) : !commandExists(command)) {
      return capabilityProbe = { ok: false, reason: `H4 local sandbox 缺少 ${command}` };
    }
  }
  const userNet = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--net", "true"], { encoding: "utf8", timeout: 3000 });
  if (userNet.status !== 0) {
    return capabilityProbe = { ok: false, reason: `unprivileged user/mount/net namespace 不可用：${String(userNet.stderr || userNet.error?.message || userNet.status).trim()}` };
  }
  const permission = spawnSync(process.execPath, ["--permission", "-e", "process.exit(0)"], { encoding: "utf8", timeout: 3000 });
  if (permission.status !== 0) {
    return capabilityProbe = { ok: false, reason: `Node Permission Model 不可用：${String(permission.stderr || permission.error?.message || permission.status).trim()}` };
  }
  return capabilityProbe = { ok: true };
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function snapshotPackage(packageDirInput: string): { dir: string; entryRoot: string } {
  const packageDir = fs.realpathSync(packageDirInput);
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-ext-snapshot-"));
  const targetRoot = path.join(snapshotRoot, "package");
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  let files = 0;
  let bytes = 0;
  const visit = (source: string, target: string): void => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) throw new Error(`H4 untrusted package 不允许 symlink：${path.join(source, entry.name)}`);
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(targetPath, { mode: 0o700 });
        visit(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`H4 untrusted package 只允许普通文件/目录：${sourcePath}`);
      const stat = fs.statSync(sourcePath);
      files += 1; bytes += stat.size;
      if (files > MAX_PACKAGE_FILES) throw new Error(`H4 untrusted package 文件数超过 ${MAX_PACKAGE_FILES}`);
      if (bytes > MAX_PACKAGE_BYTES) throw new Error(`H4 untrusted package 大小超过 ${MAX_PACKAGE_BYTES} bytes`);
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, 0o400);
    }
  };
  try { visit(packageDir, targetRoot); }
  catch (error) { fs.rmSync(snapshotRoot, { recursive: true, force: true }); throw error; }
  return { dir: snapshotRoot, entryRoot: targetRoot };
}

interface DynamicLibraryMount { source: string; target: string }

function dynamicLibraries(nodePath: string): DynamicLibraryMount[] {
  const result = spawnSync("ldd", [nodePath], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) throw new Error(`ldd Node runtime 失败：${String(result.stderr || result.stdout).trim()}`);
  const out = new Map<string, string>();
  for (const line of String(result.stdout).split("\n")) {
    for (const token of line.trim().split(/\s+/)) {
      if (token.startsWith("/") && fs.existsSync(token)) {
        // Keep the loader/library path expected by the ELF binary as the chroot target.
        // The host source may be a symlink; bind its real backing file onto that exact target.
        out.set(token, fs.realpathSync(token));
        break;
      }
    }
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([target, source]) => ({ source, target }));
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function mountFile(source: string, target: string): string {
  const dir = path.posix.dirname(target);
  return `mkdir -p "$ROOT${dir}"; touch "$ROOT${target}"; mount --bind ${shQuote(source)} "$ROOT${target}"; mount -o remount,bind,ro "$ROOT${target}"`;
}

function sandboxScript(root: string, nodePath: string, packageSnapshot: string, workerArgs: string[]): string {
  const libs = dynamicLibraries(nodePath);
  const envPath = commandPath("env");
  const chrootPath = commandPath("chroot");
  if (!envPath || !chrootPath) throw new Error("H4 sandbox 缺少 host env/chroot executable");
  const lines = [
    "set -eu",
    `ROOT=${shQuote(root)}`,
    "mount --make-rprivate /",
    `mount -t tmpfs -o mode=0755,size=128m tmpfs "$ROOT"`,
    "mkdir -p \"$ROOT/runtime\" \"$ROOT/package\" \"$ROOT/dev\" \"$ROOT/tmp\"",
    `touch "$ROOT/runtime/node"; mount --bind ${shQuote(nodePath)} "$ROOT/runtime/node"; mount -o remount,bind,ro "$ROOT/runtime/node"`,
    ...libs.map((lib) => mountFile(lib.source, lib.target)),
    `mount --bind ${shQuote(packageSnapshot)} "$ROOT/package"; mount -o remount,bind,ro "$ROOT/package"`,
    ...["/dev/null", "/dev/urandom"].filter(fs.existsSync).map((dev) => `mkdir -p \"$ROOT/dev\"; touch \"$ROOT${dev}\"; mount --bind ${shQuote(dev)} \"$ROOT${dev}\"`),
    "chmod 1777 \"$ROOT/tmp\"",
    `exec ${shQuote(envPath)} -i PATH=/runtime HOME=/nonexistent TMPDIR=/tmp LANG=C.UTF-8 ${shQuote(chrootPath)} "$ROOT" /runtime/node --permission --allow-fs-read=/package --no-experimental-fetch --max-old-space-size=64 -e ${shQuote(SANDBOX_WORKER_BOOTSTRAP)} -- ${workerArgs.map(shQuote).join(" ")}`,
  ];
  return lines.join("\n");
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); }
  catch { throw new Error("sandbox IPC payload 必须可 JSON 序列化"); }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const row = await reader.read();
      if (row.done) break;
      total += row.value.byteLength;
      if (total > MAX_NETWORK_RESPONSE_BYTES) throw new Error(`sandbox network response 超过 ${MAX_NETWORK_RESPONSE_BYTES} bytes`);
      chunks.push(row.value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export class SandboxWorkerSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private state: SandboxWorkerState = "starting";
  private lastError?: string;
  private stderr = "";
  private outputBuffer = "";
  private callSeq = 0;
  private pending = new Map<string, PendingCall>();
  private tools = new Map<string, SandboxToolDescriptor>();
  private cancelKills = new Map<string, NodeJS.Timeout>();
  private ready?: Promise<SandboxToolDescriptor[]>;
  private resolveReady?: (tools: SandboxToolDescriptor[]) => void;
  private rejectReady?: (error: Error) => void;
  private sandboxRoot?: string;
  private packageSnapshotRoot?: string;

  constructor(private readonly options: SandboxWorkerOptions) {}

  status(): SandboxWorkerStatus {
    return {
      mode: "sandbox",
      state: this.state,
      platform: "linux",
      isolation: "linux-user-mount-pid-ipc-uts-net-chroot-node-permission-broker-v1",
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(): Promise<SandboxToolDescriptor[]> {
    if (this.ready) return this.ready;
    const probe = probeLinuxExtensionSandbox();
    if (!probe.ok) throw new Error(`H4 sandbox unavailable (fail-closed): ${probe.reason}`);
    const packageDir = fs.realpathSync(this.options.packageDir);
    const entryAbsolute = path.resolve(packageDir, this.options.entry);
    if (!inside(packageDir, entryAbsolute)) throw new Error("sandbox entry 路径逃逸 package");
    const snapshot = snapshotPackage(packageDir);
    this.packageSnapshotRoot = snapshot.dir;
    const entryRelative = path.relative(packageDir, entryAbsolute).replace(/\\/g, "/");
    const entryInSandbox = `/package/${entryRelative}`;
    if (!fs.existsSync(path.join(snapshot.entryRoot, entryRelative))) throw new Error(`sandbox snapshot 缺少 entry：${entryRelative}`);
    this.sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-ext-sandbox-"));
    const manifestArg = Buffer.from(safeJson(this.options.manifest), "utf8").toString("base64url");
    const grantArg = Buffer.from(safeJson(this.options.grant), "utf8").toString("base64url");
    const script = sandboxScript(this.sandboxRoot, fs.realpathSync(process.execPath), snapshot.entryRoot, [entryInSandbox, manifestArg, String(this.options.generation), grantArg]);
    this.ready = new Promise<SandboxToolDescriptor[]>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    const child = spawn("unshare", [
      "--user", "--map-root-user", "--mount", "--net", "--pid", "--ipc", "--uts", "--fork", "--kill-child", "/bin/sh", "-c", script,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.lifecycle("sandbox-spawn", undefined, child.pid);
    const activationTimer = setTimeout(() => this.fault("sandbox-timeout", "sandbox activation handshake timeout"), ACTIVATION_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stdin.on("error", (error) => {
      if (this.state !== "stopped" && this.state !== "crashed") this.fault("sandbox-crash", `sandbox stdin failed: ${error.message}`);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.stderr.length < MAX_STDERR_BYTES) this.stderr += chunk.slice(0, MAX_STDERR_BYTES - this.stderr.length);
    });
    child.once("error", (error) => this.fault("sandbox-crash", `sandbox spawn failed: ${error.message}`));
    child.once("exit", (code, signal) => {
      clearTimeout(activationTimer);
      if (this.state !== "stopped" && this.state !== "crashed") {
        this.state = "crashed";
        this.lastError = `sandbox worker exited code=${code ?? "?"} signal=${signal ?? "?"}${this.stderr ? `: ${this.stderr.slice(-2048)}` : ""}`;
        this.lifecycle("sandbox-crash", this.lastError);
      }
      this.rejectAll(new Error(this.lastError ?? "sandbox worker disconnected"));
      this.rejectReady?.(new Error(this.lastError ?? "sandbox worker disconnected"));
      this.cleanupPaths();
    });
    try {
      const tools = await this.ready;
      clearTimeout(activationTimer);
      return tools;
    } catch (error) {
      clearTimeout(activationTimer);
      throw error;
    }
  }

  async call(tool: string, args: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    if (this.state !== "running" || !this.child) throw new Error(`sandbox worker 不可用：${this.state}${this.lastError ? `: ${this.lastError}` : ""}`);
    const callId = `sbox-${(++this.callSeq).toString(36)}`;
    const row = { v: IPC_VERSION, type: "call", callId, tool, args };
    const encoded = safeJson(row) + "\n";
    if (Buffer.byteLength(encoded) > MAX_CALL_BYTES) throw new Error(`sandbox call payload 超过 ${MAX_CALL_BYTES} bytes`);
    const budget = Math.max(100, Math.min(Math.floor(timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS), MAX_CALL_TIMEOUT_MS));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        this.fault("sandbox-timeout", `sandbox tool ${tool} timeout after ${budget}ms`);
        reject(new Error(`sandbox tool timeout after ${budget}ms`));
      }, budget);
      const pending: PendingCall = { tool, resolve, reject, timer };
      if (signal) {
        const abort = () => {
          if (!this.pending.has(callId)) return;
          this.send({ v: IPC_VERSION, type: "cancel", callId });
          const kill = setTimeout(() => this.fault("sandbox-timeout", `sandbox tool ${tool} ignored cancellation`), CANCEL_GRACE_MS);
          this.cancelKills.set(callId, kill);
          clearTimeout(timer);
          this.pending.delete(callId);
          reject(new Error("sandbox tool cancelled"));
        };
        if (signal.aborted) { clearTimeout(timer); reject(new Error("sandbox tool cancelled")); return; }
        signal.addEventListener("abort", abort, { once: true });
        pending.abortCleanup = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(callId, pending);
      this.child!.stdin.write(encoded);
    });
  }

  async dispose(): Promise<void> {
    if (this.state === "stopped") return;
    if (!this.child || this.child.exitCode !== null) { this.state = "stopped"; this.cleanupPaths(); return; }
    this.send({ v: IPC_VERSION, type: "dispose" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child?.kill("SIGKILL"); resolve(); }, DISPOSE_GRACE_MS);
      this.child!.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.state = "stopped";
    this.lifecycle("sandbox-dispose");
    this.cleanupPaths();
  }

  private onStdout(chunk: string): void {
    this.outputBuffer += chunk;
    if (Buffer.byteLength(this.outputBuffer) > MAX_PROTOCOL_LINE) { this.fault("sandbox-protocol", "sandbox protocol line overflow"); return; }
    for (;;) {
      const index = this.outputBuffer.indexOf("\n");
      if (index < 0) break;
      const line = this.outputBuffer.slice(0, index); this.outputBuffer = this.outputBuffer.slice(index + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE) { this.fault("sandbox-protocol", "sandbox protocol line too large"); return; }
      let msg: any;
      try { msg = JSON.parse(line); }
      catch { this.fault("sandbox-protocol", `sandbox emitted non-JSON protocol output: ${line.slice(0, 256)}`); return; }
      if (!msg || msg.v !== IPC_VERSION || typeof msg.type !== "string") { this.fault("sandbox-protocol", "sandbox protocol version/type invalid"); return; }
      void this.handleMessage(msg);
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.type === "ready") {
      if (this.state !== "starting") { this.fault("sandbox-protocol", "duplicate sandbox ready"); return; }
      if (msg.extensionId !== this.options.manifest.id || msg.version !== this.options.manifest.version || msg.generation !== this.options.generation || !Array.isArray(msg.tools)) {
        this.fault("sandbox-protocol", "sandbox ready identity mismatch"); return;
      }
      const tools = msg.tools as SandboxToolDescriptor[];
      this.tools = new Map(tools.map((tool) => [String(tool.name), tool]));
      if (this.tools.size !== tools.length) { this.fault("sandbox-protocol", "duplicate sandbox tool descriptor"); return; }
      this.state = "running";
      this.lifecycle("sandbox-ready", undefined, this.child?.pid);
      this.resolveReady?.(tools);
      return;
    }
    if (msg.type === "activationError") {
      this.fault("sandbox-crash", `sandbox activation failed: ${String(msg.error ?? "unknown").slice(0, 8192)}`); return;
    }
    if (msg.type === "result") {
      const callId = String(msg.callId ?? "");
      const cancelKill = this.cancelKills.get(callId);
      if (cancelKill) { clearTimeout(cancelKill); this.cancelKills.delete(callId); }
      const pending = this.pending.get(callId);
      if (!pending) return;
      this.pending.delete(callId); clearTimeout(pending.timer); pending.abortCleanup?.();
      if (msg.ok) pending.resolve(String(msg.result ?? "")); else pending.reject(new Error(String(msg.error ?? "sandbox tool failed")));
      return;
    }
    if (msg.type === "broker") { await this.handleBroker(msg); return; }
    if (msg.type === "disposed") return;
    this.fault("sandbox-protocol", `unknown sandbox protocol message: ${String(msg.type)}`);
  }

  private async handleBroker(msg: any): Promise<void> {
    const brokerId = String(msg.brokerId ?? "");
    const callId = String(msg.callId ?? "");
    if (!/^b-[a-z0-9]+$/.test(brokerId)) { this.fault("sandbox-protocol", "invalid brokerId"); return; }
    const pending = this.pending.get(callId);
    const descriptor = pending ? this.tools.get(pending.tool) : undefined;
    if (!pending || !descriptor) { this.fault("sandbox-protocol", "sandbox broker is not bound to an active tool call"); return; }
    const runtime = descriptor.runtime;
    try {
      let value: unknown;
      if (msg.op === "fs.readText") {
        if (!["read", "write", "destructive"].includes(runtime.effect)) throw new Error(`sandbox tool ${pending.tool} 未声明 filesystem-compatible effect`);
        const target = resolveSandboxReadPath(String(msg.payload?.path ?? ""), this.options.grant);
        const stat = fs.statSync(target);
        if (stat.size > MAX_FILE_BROKER_BYTES) throw new Error(`sandbox read file 超过 ${MAX_FILE_BROKER_BYTES} bytes`);
        value = fs.readFileSync(target, "utf8");
      } else if (msg.op === "fs.writeText") {
        if (!["write", "destructive"].includes(runtime.effect)) throw new Error(`sandbox tool ${pending.tool} 未声明 write/destructive effect`);
        const text = String(msg.payload?.text ?? "");
        if (Buffer.byteLength(text) > MAX_FILE_BROKER_BYTES) throw new Error(`sandbox write payload 超过 ${MAX_FILE_BROKER_BYTES} bytes`);
        const target = resolveSandboxWritePath(String(msg.payload?.path ?? ""), this.options.grant);
        fs.writeFileSync(target, text, "utf8");
        value = { bytes: Buffer.byteLength(text) };
      } else if (msg.op === "net.fetchText") {
        if (runtime.requiresNetwork !== true) throw new Error(`sandbox tool ${pending.tool} 未声明 runtime.requiresNetwork=true`);
        value = await this.networkFetch(msg.payload);
      } else {
        throw new Error(`sandbox broker op 不支持：${String(msg.op)}`);
      }
      this.sendBrokerResult(brokerId, value);
    } catch (error: any) {
      this.send({ v: IPC_VERSION, type: "brokerResult", brokerId, ok: false, error: String(error?.message ?? error).slice(0, 8192) });
    }
  }

  private sendBrokerResult(brokerId: string, value: unknown): void {
    const row = { v: IPC_VERSION, type: "brokerResult", brokerId, ok: true, value };
    const encoded = safeJson(row) + "\n";
    if (Buffer.byteLength(encoded) > MAX_PROTOCOL_LINE) {
      this.send({ v: IPC_VERSION, type: "brokerResult", brokerId, ok: false, error: `sandbox broker response exceeds ${MAX_PROTOCOL_LINE} bytes` });
      return;
    }
    this.child?.stdin.write(encoded);
  }

  private async networkFetch(payload: any): Promise<string> {
    const url = new URL(String(payload?.url ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("sandbox network broker 仅允许 http(s)");
    if (url.username || url.password) throw new Error("sandbox network broker 禁止 URL credentials");
    if (!this.options.grant.allowedOrigins.includes(url.origin)) throw new Error(`sandbox network origin 未授权：${url.origin}`);
    const input = payload?.options && typeof payload.options === "object" ? payload.options : {};
    const method = String(input.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error("sandbox network broker 仅允许 GET/POST");
    const body = input.body === undefined ? undefined : String(input.body);
    if (body && Buffer.byteLength(body) > MAX_CALL_BYTES) throw new Error("sandbox network request body too large");
    const headers: Record<string, string> = {};
    if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
      for (const [key, value] of Object.entries(input.headers)) {
        const lower = key.toLowerCase();
        if (!["accept", "content-type", "user-agent"].includes(lower)) throw new Error(`sandbox network header 未允许：${key}`);
        headers[key] = String(value).slice(0, 2048);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new Error(`sandbox network redirect 被拒绝：HTTP ${response.status}`);
      const text = await readBoundedResponse(response);
      return `HTTP ${response.status}\n${text}`;
    } finally { clearTimeout(timer); }
  }

  private send(row: unknown): void {
    if (!this.child || this.child.exitCode !== null) return;
    const encoded = safeJson(row) + "\n";
    if (Buffer.byteLength(encoded) > MAX_PROTOCOL_LINE) { this.fault("sandbox-protocol", "host sandbox response too large"); return; }
    this.child.stdin.write(encoded);
  }

  private fault(kind: SandboxLifecycleKind, error: string): void {
    if (this.state === "stopped" || this.state === "crashed") return;
    this.state = "crashed"; this.lastError = error;
    this.lifecycle(kind, error, this.child?.pid);
    this.rejectReady?.(new Error(error));
    this.rejectAll(new Error(error));
    this.child?.kill("SIGKILL");
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.abortCleanup?.(); pending.reject(error); }
    this.pending.clear();
    for (const timer of this.cancelKills.values()) clearTimeout(timer);
    this.cancelKills.clear();
  }

  private lifecycle(kind: SandboxLifecycleKind, error?: string, pid?: number): void {
    try { this.options.onLifecycle?.({ kind, ...(pid ? { pid } : {}), ...(error ? { error } : {}) }); } catch { /* diagnostics cannot alter containment */ }
  }

  private cleanupPaths(): void {
    for (const target of [this.sandboxRoot, this.packageSnapshotRoot]) {
      if (!target) continue;
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort after namespace exit */ }
    }
    this.sandboxRoot = undefined; this.packageSnapshotRoot = undefined;
  }
}
