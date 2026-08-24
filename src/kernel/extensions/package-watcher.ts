import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { EXTENSION_MANIFEST_FILE, ExtensionPackageLoader, type ExtensionPackageManifest } from "./package-loader";
import { ExtensionRuntime } from "./runtime";
import type { ExtensionSandboxPolicy } from "./sandbox-policy";

const DEFAULT_INTERVAL_MS = 500;
const MAX_FILES = 512;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

export type ExtensionWatchEventKind = "loaded" | "reloaded" | "removed" | "load-error" | "duplicate" | "scan-error";
export interface ExtensionWatchEvent {
  kind: ExtensionWatchEventKind;
  packageDir?: string;
  extensionId?: string;
  fingerprint?: string;
  error?: string;
}

export interface ExtensionPackageWatcherOptions {
  intervalMs?: number;
  onEvent?: (event: ExtensionWatchEvent) => void;
  /** Operator intent gate. Trust roots remain host-owned; disabled packages are not activated. */
  isEnabled?: (extensionId: string) => boolean;
  /** Host-owned H4 grants; packages cannot modify this policy. */
  sandboxPolicy?: ExtensionSandboxPolicy;
}

export interface ExtensionPackageObservation {
  extensionId: string;
  version: string;
  packageDir: string;
  fingerprint: string;
}

interface Candidate {
  packageDir: string;
  manifest: Readonly<ExtensionPackageManifest>;
  fingerprint: string;
}
interface LoadedRecord { packageDir: string; fingerprint: string; }

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function packageDirectories(rootInput: string): string[] {
  const root = fs.realpathSync(rootInput);
  if (!fs.statSync(root).isDirectory()) throw new Error(`extension root 不是目录：${rootInput}`);
  if (fs.existsSync(path.join(root, EXTENSION_MANIFEST_FILE))) return [root];
  const rows: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    const real = fs.realpathSync(candidate);
    if (!inside(root, real)) continue;
    if (fs.existsSync(path.join(real, EXTENSION_MANIFEST_FILE))) rows.push(real);
  }
  return rows.sort();
}

function fingerprintPackage(packageDir: string): string {
  const hash = crypto.createHash("sha256");
  let count = 0;
  let totalBytes = 0;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++count > MAX_FILES) throw new Error(`extension package 文件数超过 ${MAX_FILES}`);
      const bytes = fs.readFileSync(absolute);
      totalBytes += bytes.length;
      if (totalBytes > MAX_SCAN_BYTES) throw new Error(`extension package HMR 扫描超过 ${MAX_SCAN_BYTES} bytes`);
      hash.update(path.relative(packageDir, absolute).replace(/\\/g, "/"));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
  };
  visit(packageDir);
  return hash.digest("hex");
}

/** Polling watcher is intentionally cross-platform and dependency-free for Node >=18. */
export class ExtensionPackageWatcher {
  private readonly loader: ExtensionPackageLoader;
  private readonly roots: string[];
  private readonly loaded = new Map<string, LoadedRecord>();
  private readonly attempted = new Map<string, LoadedRecord>();
  private observed: ExtensionPackageObservation[] = [];
  private timer?: NodeJS.Timeout;
  private scanQueue: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(
    private readonly runtime: ExtensionRuntime,
    roots: readonly string[],
    private readonly options: ExtensionPackageWatcherOptions = {}
  ) {
    this.loader = new ExtensionPackageLoader(runtime, { sandboxPolicy: options.sandboxPolicy });
    this.roots = [...new Set(roots.map((root) => path.resolve(root)))].sort();
  }

  async start(): Promise<void> {
    if (!this.stopped) return this.scanNow();
    this.stopped = false;
    await this.scanNow();
    const interval = Math.max(100, Math.floor(this.options.intervalMs ?? DEFAULT_INTERVAL_MS));
    this.timer = setInterval(() => { void this.scanNow(); }, interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scanQueue;
  }

  scanNow(): Promise<void> {
    const run = this.scanQueue.then(() => this.scan());
    this.scanQueue = run.catch(() => undefined);
    return run;
  }

  /** Stable host/operator projection of the last completed discovery pass. */
  observations(): ExtensionPackageObservation[] {
    return this.observed.map((row) => ({ ...row }));
  }

  trustRoots(): string[] { return [...this.roots]; }

  /** Force one package reload even when its fingerprint did not change. */
  reload(id: string): Promise<void> {
    const run = this.scanQueue.then(() => this.reloadNow(id));
    this.scanQueue = run.catch(() => undefined);
    return run;
  }

  private event(event: ExtensionWatchEvent): void {
    try { this.options.onEvent?.(event); } catch { /* watcher diagnostics cannot break HMR */ }
  }

  private discover(): { candidates: Candidate[]; presentDirs: Set<string>; validDirToId: Map<string, string> } {
    const candidates: Candidate[] = [];
    const presentDirs = new Set<string>();
    const validDirToId = new Map<string, string>();
    for (const root of this.roots) {
      let dirs: string[];
      try { dirs = packageDirectories(root); }
      catch (error: any) {
        this.event({ kind: "scan-error", packageDir: root, error: error?.message ?? String(error) });
        continue;
      }
      for (const packageDir of dirs) {
        presentDirs.add(packageDir);
        try {
          const manifest = this.loader.inspect(packageDir);
          validDirToId.set(packageDir, manifest.id);
          candidates.push({ packageDir, manifest, fingerprint: fingerprintPackage(packageDir) });
        } catch (error: any) {
          this.event({ kind: "scan-error", packageDir, error: error?.message ?? String(error) });
        }
      }
    }
    return { candidates, presentDirs, validDirToId };
  }

  private async scan(): Promise<void> {
    const { candidates, presentDirs, validDirToId } = this.discover();
    this.observed = candidates.map((candidate) => ({
      extensionId: candidate.manifest.id,
      version: candidate.manifest.version,
      packageDir: candidate.packageDir,
      fingerprint: candidate.fingerprint,
    }));
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const rows = groups.get(candidate.manifest.id) ?? [];
      rows.push(candidate);
      groups.set(candidate.manifest.id, rows);
    }

    const seenIds = new Set<string>();
    for (const [id, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      seenIds.add(id);
      if (rows.length > 1) {
        this.event({ kind: "duplicate", extensionId: id, error: `duplicate extension id: ${rows.map((row) => row.packageDir).join(", ")}` });
        continue;
      }
      const candidate = rows[0];
      if (this.options.isEnabled && !this.options.isEnabled(id)) {
        if (this.runtime.status(id).state !== "absent") await this.runtime.remove(id, "operator-disabled");
        continue;
      }
      const priorAttempt = this.attempted.get(id);
      if (priorAttempt?.packageDir === candidate.packageDir && priorAttempt.fingerprint === candidate.fingerprint) continue;
      this.attempted.set(id, { packageDir: candidate.packageDir, fingerprint: candidate.fingerprint });
      const previous = this.loaded.get(id);
      const beforeGeneration = this.runtime.status(id).activeGeneration;
      try {
        const loaded = await this.loader.load(candidate.packageDir, previous ? "package-reload" : "package-load");
        const generationChanged = loaded.status.activeGeneration !== beforeGeneration;
        if (loaded.status.lastError && !generationChanged) {
          this.event({ kind: "load-error", extensionId: id, packageDir: candidate.packageDir, fingerprint: candidate.fingerprint, error: loaded.status.lastError });
          continue;
        }
        // A dependency-PENDING package is a valid desired package and should not be reloaded every scan.
        if (loaded.status.state === "active" || loaded.status.state === "pending") {
          this.loaded.set(id, { packageDir: candidate.packageDir, fingerprint: candidate.fingerprint });
        }
        this.event({ kind: previous ? "reloaded" : "loaded", extensionId: id, packageDir: candidate.packageDir, fingerprint: candidate.fingerprint });
      } catch (error: any) {
        this.event({ kind: "load-error", extensionId: id, packageDir: candidate.packageDir, fingerprint: candidate.fingerprint, error: error?.message ?? String(error) });
      }
    }

    for (const [id, attempted] of [...this.attempted]) {
      if (seenIds.has(id)) continue;
      const previous = this.loaded.get(id);
      const packageDir = previous?.packageDir ?? attempted.packageDir;
      const replacementId = validDirToId.get(packageDir);
      // Transient invalid/missing entry during an editor save preserves LKG until the package becomes valid or disappears.
      if (!replacementId && presentDirs.has(packageDir)) continue;
      await this.runtime.remove(id, replacementId ? `package-id-changed:${replacementId}` : "package-removed");
      this.loaded.delete(id);
      this.attempted.delete(id);
      this.event({ kind: "removed", extensionId: id, packageDir, fingerprint: previous?.fingerprint ?? attempted.fingerprint });
    }
  }
  private async reloadNow(idInput: string): Promise<void> {
    const id = String(idInput ?? "").trim();
    const { candidates } = this.discover();
    this.observed = candidates.map((candidate) => ({
      extensionId: candidate.manifest.id,
      version: candidate.manifest.version,
      packageDir: candidate.packageDir,
      fingerprint: candidate.fingerprint,
    }));
    const rows = candidates.filter((candidate) => candidate.manifest.id === id);
    if (!rows.length) throw new Error(`extension package 未发现：${id}`);
    if (rows.length > 1) throw new Error(`duplicate extension id: ${rows.map((row) => row.packageDir).join(", ")}`);
    if (this.options.isEnabled && !this.options.isEnabled(id)) throw new Error(`extension ${id} 已被 operator disabled`);
    const candidate = rows[0];
    const previous = this.loaded.get(id);
    const beforeGeneration = this.runtime.status(id).activeGeneration;
    this.attempted.set(id, { packageDir: candidate.packageDir, fingerprint: candidate.fingerprint });
    try {
      const loaded = await this.loader.load(candidate.packageDir, "operator-reload");
      const generationChanged = loaded.status.activeGeneration !== beforeGeneration;
      if (loaded.status.lastError && !generationChanged) {
        this.event({ kind: "load-error", extensionId: id, packageDir: candidate.packageDir, fingerprint: candidate.fingerprint, error: loaded.status.lastError });
        throw new Error(loaded.status.lastError);
      }
      if (loaded.status.state === "active" || loaded.status.state === "pending") {
        this.loaded.set(id, { packageDir: candidate.packageDir, fingerprint: candidate.fingerprint });
      }
      this.event({ kind: previous ? "reloaded" : "loaded", extensionId: id, packageDir: candidate.packageDir, fingerprint: candidate.fingerprint });
    } catch (error: any) {
      this.event({ kind: "load-error", extensionId: id, packageDir: candidate.packageDir, fingerprint: candidate.fingerprint, error: error?.message ?? String(error) });
      throw error;
    }
  }

}
