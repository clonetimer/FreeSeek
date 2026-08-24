import * as path from "path";
import { ExtensionAuditJournal } from "./audit-store";
import { ExtensionIntentStore, ExtensionManagementService } from "./management";
import { ExtensionRuntime, type ExtensionRuntimeOptions } from "./runtime";
import { ExtensionPackageWatcher, type ExtensionPackageWatcherOptions } from "./package-watcher";
import type { ExtensionSandboxPolicy } from "./sandbox-policy";

export interface FileExtensionHostOptions {
  roots: readonly string[];
  /** Host-owned durable state directory for operator intent and process-level HMR audit. */
  stateDir?: string;
  runtime?: ExtensionRuntimeOptions;
  watcher?: ExtensionPackageWatcherOptions;
  /** H4 operator-owned capability grants for trust=untrusted packages. */
  sandboxPolicy?: ExtensionSandboxPolicy;
}

/** Process-level owner for one General HMR runtime, filesystem watcher and H3 management projection. */
export class FileExtensionHost {
  readonly runtime: ExtensionRuntime;
  readonly watcher: ExtensionPackageWatcher;
  readonly management: ExtensionManagementService;
  readonly audit: ExtensionAuditJournal;
  readonly intents: ExtensionIntentStore;
  private startTask?: Promise<void>;
  private disposed = false;

  constructor(options: FileExtensionHostOptions) {
    const roots = [...new Set(options.roots.map((root) => path.resolve(root)))].sort();
    this.audit = new ExtensionAuditJournal(options.stateDir);
    this.intents = new ExtensionIntentStore(options.stateDir);
    const runtimeAudit = options.runtime?.onAudit;
    const watcherEvent = options.watcher?.onEvent;
    this.runtime = new ExtensionRuntime({
      ...options.runtime,
      onAudit: (event) => {
        this.audit.appendRuntime(event);
        try { runtimeAudit?.(event); } catch { /* diagnostics cannot change runtime semantics */ }
      },
    });
    this.watcher = new ExtensionPackageWatcher(this.runtime, roots, {
      ...options.watcher,
      sandboxPolicy: options.sandboxPolicy,
      isEnabled: (id) => this.intents.enabled(id) && (options.watcher?.isEnabled?.(id) ?? true),
      onEvent: (event) => {
        this.audit.appendWatcher(event);
        try { watcherEvent?.(event); } catch { /* diagnostics cannot change watcher semantics */ }
      },
    });
    this.management = new ExtensionManagementService(this.runtime, this.watcher, this.intents, this.audit, roots);
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("FileExtensionHost 已释放");
    this.startTask ??= this.watcher.start();
    await this.startTask;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.watcher.stop();
    await this.startTask?.catch(() => undefined);
    await this.runtime.dispose();
  }
}
