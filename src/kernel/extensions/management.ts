import * as fs from "fs";
import * as path from "path";
import { assertExtensionId } from "./contributions";
import type { ExtensionStatus } from "./contracts";
import type { DurableExtensionAuditRecord, ExtensionAuditJournal } from "./audit-store";
import type { ExtensionPackageWatcher, ExtensionPackageObservation } from "./package-watcher";
import type { ExtensionRuntime } from "./runtime";

interface ExtensionIntentFile {
  schemaVersion: 1;
  disabled: string[];
}

/** Durable operator intent. It can disable packages inside host-owned trust roots, but cannot add roots. */
export class ExtensionIntentStore {
  private readonly disabledIds = new Set<string>();
  private readonly filePath?: string;

  constructor(stateDir?: string) {
    if (!stateDir) return;
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "extension-intent.json");
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as ExtensionIntentFile;
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.disabled)) throw new Error("invalid schema");
      for (const id of parsed.disabled) this.disabledIds.add(assertExtensionId(id));
    } catch (error: any) {
      // Operator disable state is security-relevant. Corruption must not silently reactivate trusted code.
      throw new Error(`extension intent state 损坏：${this.filePath}: ${error?.message ?? String(error)}`);
    }
  }

  enabled(idInput: string): boolean { return !this.disabledIds.has(assertExtensionId(idInput)); }
  disabled(): string[] { return [...this.disabledIds].sort(); }

  setEnabled(idInput: string, enabled: boolean): void {
    const id = assertExtensionId(idInput);
    if (enabled) this.disabledIds.delete(id); else this.disabledIds.add(id);
    this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    const payload: ExtensionIntentFile = { schemaVersion: 1, disabled: this.disabled() };
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}

export type ExtensionManagedHealth = "ok" | "degraded" | "pending" | "error" | "disabled" | "absent" | "conflict";

export interface ExtensionManagedStatus {
  id: string;
  enabled: boolean;
  health: ExtensionManagedHealth;
  runtime: ExtensionStatus;
  packageVersion?: string;
  packageDirs: string[];
  fingerprints: string[];
  conflict: boolean;
  lastKnownGood: boolean;
}

export interface ExtensionManagementSnapshot {
  trustRoots: string[];
  extensions: ExtensionManagedStatus[];
}

/** Host-neutral operator management plane layered above an existing FileExtensionHost. */
export class ExtensionManagementService {
  constructor(
    private readonly runtime: ExtensionRuntime,
    private readonly watcher: ExtensionPackageWatcher,
    private readonly intents: ExtensionIntentStore,
    private readonly auditJournal: ExtensionAuditJournal,
    private readonly roots: readonly string[]
  ) {}

  snapshot(): ExtensionManagementSnapshot {
    const observations = this.watcher.observations();
    const ids = new Set<string>([
      ...this.runtime.list().map((row) => row.id),
      ...observations.map((row) => row.extensionId),
      ...this.intents.disabled(),
    ]);
    return {
      trustRoots: [...this.roots],
      extensions: [...ids].sort().map((id) => this.compose(id, observations)),
    };
  }

  list(): ExtensionManagedStatus[] { return this.snapshot().extensions; }

  status(idInput: string): ExtensionManagedStatus {
    const id = assertExtensionId(idInput);
    return this.compose(id, this.watcher.observations());
  }

  audit(options: { extensionId?: string; limit?: number } = {}): DurableExtensionAuditRecord[] {
    const extensionId = options.extensionId ? assertExtensionId(options.extensionId) : undefined;
    return this.auditJournal.list({ ...(extensionId ? { extensionId } : {}), limit: options.limit });
  }

  async reload(idInput: string): Promise<ExtensionManagedStatus> {
    const id = assertExtensionId(idInput);
    return this.operation("reload", id, async () => {
      if (!this.intents.enabled(id)) throw new Error(`extension ${id} 已被 operator disabled；先 config enabled=true`);
      await this.watcher.reload(id);
      return this.status(id);
    });
  }

  /** Remove means durable operator disable; package bytes are never deleted by H3. */
  async remove(idInput: string): Promise<ExtensionManagedStatus> {
    const id = assertExtensionId(idInput);
    return this.operation("remove", id, async () => {
      this.intents.setEnabled(id, false);
      await this.runtime.remove(id, "operator-remove");
      return this.status(id);
    });
  }

  async configure(idInput: string, input: { enabled: boolean }): Promise<ExtensionManagedStatus> {
    const id = assertExtensionId(idInput);
    if (typeof input.enabled !== "boolean") throw new Error("extension config.enabled 必须是 boolean");
    return this.operation("config", id, async () => {
      this.intents.setEnabled(id, input.enabled);
      if (input.enabled) await this.watcher.reload(id);
      else await this.runtime.remove(id, "operator-disabled");
      return this.status(id);
    });
  }

  async reconcile(): Promise<ExtensionManagementSnapshot> {
    return this.operation("reconcile", undefined, async () => {
      await this.watcher.scanNow();
      await this.runtime.reconcile();
      return this.snapshot();
    });
  }

  private compose(id: string, observations: readonly ExtensionPackageObservation[]): ExtensionManagedStatus {
    const runtime = this.runtime.status(id);
    const packages = observations.filter((row) => row.extensionId === id);
    const conflict = packages.length > 1;
    const enabled = this.intents.enabled(id);
    const sandboxFault = !!runtime.sandbox && runtime.sandbox.state !== "running";
    const lastKnownGood = !!runtime.activeGeneration && !!runtime.lastError && !sandboxFault;
    let health: ExtensionManagedHealth;
    if (!enabled) health = "disabled";
    else if (conflict) health = "conflict";
    else if (runtime.state === "pending") health = "pending";
    else if (runtime.state === "error" || sandboxFault) health = "error";
    else if (lastKnownGood) health = "degraded";
    else if (runtime.state === "active") health = "ok";
    else health = "absent";
    return {
      id, enabled, health, runtime,
      ...(packages[0]?.version ? { packageVersion: packages[0].version } : {}),
      packageDirs: packages.map((row) => row.packageDir),
      fingerprints: packages.map((row) => row.fingerprint),
      conflict,
      lastKnownGood,
    };
  }

  private async operation<T>(operation: string, extensionId: string | undefined, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      this.auditJournal.appendManagement({ operation, ...(extensionId ? { extensionId } : {}), outcome: "ok" });
      return result;
    } catch (error: any) {
      const message = error?.message ?? String(error);
      this.auditJournal.appendManagement({ operation, ...(extensionId ? { extensionId } : {}), outcome: "error", error: message });
      throw error;
    }
  }
}
