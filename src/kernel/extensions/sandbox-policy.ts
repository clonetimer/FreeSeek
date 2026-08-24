import * as fs from "fs";
import * as path from "path";
import { assertExtensionId } from "./contributions";
import type { ExtensionManifest } from "./contracts";

export interface ExtensionSandboxFilesystemGrant {
  /** Host/operator-authorized roots readable only through the sandbox IPC broker. */
  read?: string[];
  /** Host/operator-authorized roots writable only through the sandbox IPC broker. */
  write?: string[];
}

export interface ExtensionSandboxNetworkGrant {
  /** Exact http(s) origins. Redirects are never followed implicitly. */
  allowedOrigins: string[];
}

export interface ExtensionSandboxGrant {
  filesystem?: ExtensionSandboxFilesystemGrant;
  network?: ExtensionSandboxNetworkGrant;
}

/** Host-owned policy. Packages can request capabilities but cannot widen these grants. */
export interface ExtensionSandboxPolicy {
  grants?: Record<string, ExtensionSandboxGrant | undefined>;
}

export interface ResolvedExtensionSandboxGrant {
  readRoots: string[];
  writeRoots: string[];
  allowedOrigins: string[];
}

const MAX_POLICY_BYTES = 256 * 1024;

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON object`);
  return value as Record<string, unknown>;
}

function onlyKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(row)) if (!allowed.includes(key)) throw new Error(`${label} 包含未知字段：${key}`);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是 string[]`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${label}[${index}] 必须是非空字符串`);
    return entry.trim();
  });
}

/** Startup-only operator policy. It is never writable through H3 management APIs. */
export function loadExtensionSandboxPolicyFile(fileInput: string): ExtensionSandboxPolicy {
  if (!path.isAbsolute(fileInput)) throw new Error("extension sandbox policy file 必须是绝对路径");
  if (fs.lstatSync(fileInput).isSymbolicLink()) throw new Error("extension sandbox policy file 不允许 symlink");
  const file = fs.realpathSync(fileInput);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`extension sandbox policy 不是普通文件：${file}`);
  if (stat.size > MAX_POLICY_BYTES) throw new Error(`extension sandbox policy 超过 ${MAX_POLICY_BYTES} bytes`);
  const root = plainObject(JSON.parse(fs.readFileSync(file, "utf8")), "extension sandbox policy");
  onlyKeys(root, ["schemaVersion", "grants"], "extension sandbox policy");
  if (root.schemaVersion !== 1) throw new Error(`extension sandbox policy schemaVersion 必须是 1`);
  const rawGrants = root.grants === undefined ? {} : plainObject(root.grants, "extension sandbox policy.grants");
  const grants: Record<string, ExtensionSandboxGrant> = {};
  for (const [idInput, value] of Object.entries(rawGrants)) {
    const id = assertExtensionId(idInput, "sandbox policy extension id");
    const row = plainObject(value, `sandbox policy grant ${id}`);
    onlyKeys(row, ["filesystem", "network"], `sandbox policy grant ${id}`);
    const grant: ExtensionSandboxGrant = {};
    if (row.filesystem !== undefined) {
      const filesystem = plainObject(row.filesystem, `sandbox policy ${id}.filesystem`);
      onlyKeys(filesystem, ["read", "write"], `sandbox policy ${id}.filesystem`);
      grant.filesystem = {
        read: stringArray(filesystem.read, `sandbox policy ${id}.filesystem.read`),
        write: stringArray(filesystem.write, `sandbox policy ${id}.filesystem.write`),
      };
    }
    if (row.network !== undefined) {
      const network = plainObject(row.network, `sandbox policy ${id}.network`);
      onlyKeys(network, ["allowedOrigins"], `sandbox policy ${id}.network`);
      grant.network = { allowedOrigins: stringArray(network.allowedOrigins, `sandbox policy ${id}.network.allowedOrigins`) };
    }
    grants[id] = grant;
  }
  return Object.freeze({ grants: Object.freeze(grants) });
}

function realDirectory(input: string, label: string): string {
  const absolute = path.resolve(String(input ?? ""));
  if (!path.isAbsolute(String(input ?? ""))) throw new Error(`${label} 必须是绝对路径`);
  const real = fs.realpathSync(absolute);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} 不是目录：${input}`);
  return real;
}

function origins(values: readonly string[] | undefined, label: string): string[] {
  const out = new Set<string>();
  for (const value of values ?? []) {
    let url: URL;
    try { url = new URL(String(value)); }
    catch { throw new Error(`${label} 非法 URL origin：${String(value)}`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} 仅允许 http(s) origin`);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error(`${label} 必须是纯 origin（scheme://host[:port]）：${String(value)}`);
    }
    out.add(url.origin);
  }
  return [...out].sort();
}

/** Resolve the effective operator grant and verify it cannot be widened by package metadata. */
export function resolveExtensionSandboxGrant(
  manifest: Readonly<ExtensionManifest>,
  policy: ExtensionSandboxPolicy | undefined
): ResolvedExtensionSandboxGrant {
  const id = assertExtensionId(manifest.id);
  const grant = policy?.grants?.[id] ?? {};
  const readRoots = [...new Set((grant.filesystem?.read ?? []).map((root) => realDirectory(root, `${id} sandbox read root`)))].sort();
  const writeRoots = [...new Set((grant.filesystem?.write ?? []).map((root) => realDirectory(root, `${id} sandbox write root`)))].sort();
  const allowedOrigins = origins(grant.network?.allowedOrigins, `${id} sandbox network grant`);
  const fsCapability = manifest.capabilities?.filesystem ?? "none";

  if (fsCapability === "none" && (readRoots.length || writeRoots.length)) {
    throw new Error(`extension ${id}: manifest filesystem=none，不能消费 Host filesystem grant`);
  }
  if (fsCapability === "read" && writeRoots.length) {
    throw new Error(`extension ${id}: filesystem=read 不能消费 write grant`);
  }
  if (fsCapability === "read" && !readRoots.length) {
    throw new Error(`extension ${id}: filesystem=read 需要 Host 显式 read root grant`);
  }
  if (fsCapability === "write" && !writeRoots.length) {
    throw new Error(`extension ${id}: filesystem=write 需要 Host 显式 write root grant`);
  }
  if (manifest.capabilities?.network === true && !allowedOrigins.length) {
    throw new Error(`extension ${id}: network=true 需要 Host 显式 allowedOrigins grant`);
  }
  if (manifest.capabilities?.network !== true && allowedOrigins.length) {
    throw new Error(`extension ${id}: 未声明 network=true，不能消费 Host network grant`);
  }
  if (manifest.capabilities?.shell === true) {
    throw new Error(`extension ${id}: H4 Linux sandbox v1 不开放 shell/process spawn；capabilities.shell=true fail-closed`);
  }
  return { readRoots, writeRoots, allowedOrigins };
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function rootFor(target: string, roots: readonly string[]): string | undefined {
  return [...roots].sort((a, b) => b.length - a.length).find((root) => inside(root, target));
}

/** Existing read target must resolve inside one explicitly authorized real root. */
export function resolveSandboxReadPath(targetInput: string, grant: ResolvedExtensionSandboxGrant): string {
  const target = path.resolve(String(targetInput ?? ""));
  const real = fs.realpathSync(target);
  if (!rootFor(real, [...grant.readRoots, ...grant.writeRoots])) throw new Error(`sandbox filesystem read 越权：${targetInput}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`sandbox filesystem read 仅支持普通文件：${targetInput}`);
  return real;
}

/** Write target may be new, but its real existing parent must stay inside an explicit write root. */
export function resolveSandboxWritePath(targetInput: string, grant: ResolvedExtensionSandboxGrant): string {
  const target = path.resolve(String(targetInput ?? ""));
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`sandbox filesystem write 拒绝 symlink target：${targetInput}`);
    const real = fs.realpathSync(target);
    if (!rootFor(real, grant.writeRoots)) throw new Error(`sandbox filesystem write 越权：${targetInput}`);
    if (!fs.statSync(real).isFile()) throw new Error(`sandbox filesystem write 仅支持普通文件：${targetInput}`);
    return real;
  }
  const parent = fs.realpathSync(path.dirname(target));
  if (!rootFor(parent, grant.writeRoots)) throw new Error(`sandbox filesystem write 越权：${targetInput}`);
  return path.join(parent, path.basename(target));
}
