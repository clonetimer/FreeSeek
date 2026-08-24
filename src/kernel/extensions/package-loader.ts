import * as fs from "fs";
import * as path from "path";
import type { ExtensionManifest, ExtensionModule, ExtensionSandboxStatus, ExtensionStatus } from "./contracts";
import { ExtensionRuntime } from "./runtime";
import type { ExtensionPackageContributions } from "./package-contributions";
import { resolveExtensionSandboxGrant, type ExtensionSandboxPolicy } from "./sandbox-policy";
import { SandboxWorkerSupervisor } from "./sandbox-supervisor";

export const EXTENSION_MANIFEST_FILE = "freeseek-extension.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const ENTRY_EXTENSIONS = new Set([".js", ".cjs"]);

/** Filesystem package descriptor. Executable metadata remains in the core ExtensionManifest. */
export interface ExtensionPackageManifest extends ExtensionManifest {
  entry: string;
  contributions?: ExtensionPackageContributions;
}

export interface LoadedExtensionPackage {
  readonly packageDir: string;
  readonly entryPath: string;
  readonly manifest: Readonly<ExtensionPackageManifest>;
  readonly status: ExtensionStatus;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readPackageManifest(packageDir: string): { packageDir: string; manifest: ExtensionPackageManifest; entryPath: string } {
  const realPackage = fs.realpathSync(packageDir);
  const stat = fs.statSync(realPackage);
  if (!stat.isDirectory()) throw new Error(`extension package 不是目录：${packageDir}`);
  const manifestPath = path.join(realPackage, EXTENSION_MANIFEST_FILE);
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error(`extension manifest 不允许 symlink：${manifestPath}`);
  const manifestStat = fs.statSync(manifestPath);
  if (!manifestStat.isFile()) throw new Error(`extension manifest 不是文件：${manifestPath}`);
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error(`extension manifest 超过 ${MAX_MANIFEST_BYTES} bytes：${manifestPath}`);
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExtensionPackageManifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`extension manifest 必须是 JSON object：${manifestPath}`);
  const entry = String(raw.entry ?? "").trim();
  if (!entry || path.isAbsolute(entry)) throw new Error(`extension ${String(raw.id ?? "<unknown>")}: entry 必须是 package 内相对路径`);
  if (!ENTRY_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
    throw new Error(`extension ${String(raw.id ?? "<unknown>")}: v1 entry 仅允许 .js/.cjs`);
  }
  const unresolved = path.resolve(realPackage, entry);
  if (!inside(realPackage, unresolved)) throw new Error(`extension ${String(raw.id ?? "<unknown>")}: entry 路径逃逸 package`);
  if (fs.lstatSync(unresolved).isSymbolicLink()) throw new Error(`extension ${String(raw.id ?? "<unknown>")}: v1 entry 不允许 symlink`);
  const entryPath = fs.realpathSync(unresolved);
  if (!inside(realPackage, entryPath)) throw new Error(`extension ${String(raw.id ?? "<unknown>")}: entry symlink 逃逸 package`);
  if (!fs.statSync(entryPath).isFile()) throw new Error(`extension entry 不是文件：${entryPath}`);
  return { packageDir: realPackage, manifest: { ...raw, entry }, entryPath };
}

function purgePackageRequireCache(packageDir: string): void {
  for (const filename of Object.keys(require.cache)) {
    let real = filename;
    try { real = fs.realpathSync(filename); } catch { /* deleted cache entry: use original path */ }
    if (inside(packageDir, real)) delete require.cache[filename];
  }
}

function executableModule(exported: any, manifest: ExtensionPackageManifest, packageDir: string): ExtensionModule {
  const candidate = exported?.default ?? exported;
  const activate = typeof candidate === "function"
    ? candidate
    : typeof candidate?.activate === "function"
      ? candidate.activate.bind(candidate)
      : undefined;
  if (!activate) throw new Error(`extension ${manifest.id}: entry 必须 export activate(context) 或 module.exports = function`);
  const { entry: _entry, contributions, ...coreManifest } = manifest;
  return {
    manifest: coreManifest,
    activate: async (ctx) => {
      const { mountPackageContributions } = require("./package-contributions") as typeof import("./package-contributions");
      await mountPackageContributions(ctx, packageDir, contributions);
      return activate(ctx);
    },
  };
}

export interface ExtensionPackageLoaderOptions {
  sandboxPolicy?: ExtensionSandboxPolicy;
}

function sandboxedModule(
  runtime: ExtensionRuntime,
  descriptor: { packageDir: string; manifest: ExtensionPackageManifest; entryPath: string },
  policy: ExtensionSandboxPolicy | undefined
): ExtensionModule {
  const { entry, contributions, ...coreManifest } = descriptor.manifest;
  const caps = coreManifest.capabilities ?? {};
  for (const key of ["connectors", "skills", "hooks", "mcp", "persistence", "ui"] as const) {
    if (caps[key]) throw new Error(`extension ${coreManifest.id}: H4 sandbox v1 仅支持 untrusted tool contribution；capabilities.${key}=true fail-closed`);
  }
  if (contributions && Object.keys(contributions).length) {
    throw new Error(`extension ${coreManifest.id}: H4 sandbox v1 不执行 declarative H2 contributions`);
  }
  if (caps.tools !== true) throw new Error(`extension ${coreManifest.id}: trust=untrusted H4 v1 需要 capabilities.tools=true`);
  const grant = resolveExtensionSandboxGrant(coreManifest, policy);
  let worker: SandboxWorkerSupervisor | undefined;
  const starting: ExtensionSandboxStatus = {
    mode: "sandbox", state: "starting", platform: "linux",
    isolation: "linux-user-mount-pid-ipc-uts-net-chroot-node-permission-broker-v1",
  };
  const module: ExtensionModule = {
    manifest: coreManifest,
    execution: { mode: "sandbox", enforced: true, status: () => worker?.status() ?? starting },
    activate: async (ctx) => {
      worker = new SandboxWorkerSupervisor({
        packageDir: descriptor.packageDir,
        entry,
        manifest: coreManifest as unknown as Record<string, unknown>,
        generation: ctx.generation,
        grant,
        onLifecycle: (event) => runtime.recordSandboxLifecycle({
          kind: event.kind, extensionId: coreManifest.id, generation: ctx.generation, version: coreManifest.version,
          ...(event.pid ? { workerPid: event.pid } : {}),
          sandboxState: worker?.status().state ?? (event.kind === "sandbox-spawn" ? "starting" : undefined),
          isolation: "linux-user-mount-pid-ipc-uts-net-chroot-node-permission-broker-v1",
          ...(event.error ? { error: event.error } : {}),
        }),
      });
      ctx.effect(() => worker?.dispose(), "sandbox-worker");
      const tools = await worker.start();
      for (const tool of tools) {
        ctx.registerTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          runtime: tool.runtime,
          execute: (args, toolCtx) => worker!.call(tool.name, args, toolCtx.signal, tool.runtime?.timeoutMs),
        });
      }
    },
  };
  return module;
}

/** Filesystem package loader. Trusted code is in-process; untrusted code is never required by the Host. */
export class ExtensionPackageLoader {
  constructor(private readonly runtime: ExtensionRuntime, private readonly options: ExtensionPackageLoaderOptions = {}) {}

  inspect(packageDir: string): Readonly<ExtensionPackageManifest> {
    return Object.freeze({ ...readPackageManifest(packageDir).manifest });
  }

  async load(packageDir: string, reason = "package-load"): Promise<LoadedExtensionPackage> {
    const descriptor = readPackageManifest(packageDir);
    let module: ExtensionModule;
    if (descriptor.manifest.trust === "untrusted") {
      module = sandboxedModule(this.runtime, descriptor, this.options.sandboxPolicy);
    } else {
      purgePackageRequireCache(descriptor.packageDir);
      let exported: any;
      try {
        exported = require(descriptor.entryPath);
      } catch (error: any) {
        throw new Error(`extension ${descriptor.manifest.id}: entry load failed: ${error?.message ?? String(error)}`);
      }
      module = executableModule(exported, descriptor.manifest, descriptor.packageDir);
    }
    const status = await this.runtime.apply(module, reason);
    return {
      packageDir: descriptor.packageDir,
      entryPath: descriptor.entryPath,
      manifest: Object.freeze({ ...descriptor.manifest }),
      status,
    };
  }
}
