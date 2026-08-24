import * as fs from "fs";
import * as path from "path";
import type { ExtensionAuditEvent } from "./contracts";
import type { ExtensionWatchEvent } from "./package-watcher";

export type ExtensionAuditSource = "runtime" | "watcher" | "management";

export interface DurableExtensionAuditRecord {
  seq: number;
  ts: string;
  source: ExtensionAuditSource;
  kind: string;
  extensionId?: string;
  generation?: number;
  version?: string;
  leaseId?: string;
  reason?: string;
  packageDir?: string;
  fingerprint?: string;
  missingDependencies?: string[];
  generations?: Array<{ id: string; generation: number; version: string }>;
  operation?: string;
  outcome?: "ok" | "error";
  error?: string;
  workerPid?: number;
  sandboxState?: string;
  isolation?: string;
}

const MAX_MEMORY_RECORDS = 2000;
const MAX_AUDIT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 4096;
const MAX_GENERATIONS = 256;
const MAX_DEPENDENCIES = 128;

function text(value: string | undefined, max = MAX_TEXT): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function validRecord(value: unknown): value is DurableExtensionAuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as DurableExtensionAuditRecord;
  return Number.isInteger(row.seq) && row.seq > 0 && typeof row.ts === "string" && typeof row.source === "string" && typeof row.kind === "string";
}

/** Process-level durable journal for ExtensionRuntime/watcher/operator lifecycle. */
export class ExtensionAuditJournal {
  private readonly rows: DurableExtensionAuditRecord[] = [];
  private seq = 0;
  private readonly filePath?: string;

  constructor(stateDir?: string) {
    if (!stateDir) return;
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "extension-audit.jsonl");
    if (!fs.existsSync(this.filePath)) return;
    try {
      for (const line of fs.readFileSync(this.filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as unknown;
          if (!validRecord(row)) continue;
          this.seq = Math.max(this.seq, row.seq);
          this.rows.push(row);
        } catch { /* corrupted audit rows are skipped, append sequence continues */ }
      }
      this.trim();
    } catch { /* audit recovery is best-effort and cannot break runtime startup */ }
  }

  appendRuntime(event: ExtensionAuditEvent): DurableExtensionAuditRecord {
    return this.append({
      source: "runtime",
      kind: event.kind,
      ...(text(event.extensionId, 256) ? { extensionId: text(event.extensionId, 256) } : {}),
      ...(event.generation !== undefined ? { generation: event.generation } : {}),
      ...(text(event.version, 256) ? { version: text(event.version, 256) } : {}),
      ...(text(event.leaseId, 256) ? { leaseId: text(event.leaseId, 256) } : {}),
      ...(text(event.reason) ? { reason: text(event.reason) } : {}),
      ...(event.missingDependencies?.length ? { missingDependencies: event.missingDependencies.slice(0, MAX_DEPENDENCIES).map((row) => text(row, 256)!) } : {}),
      ...(event.generations?.length ? { generations: event.generations.slice(0, MAX_GENERATIONS).map((row) => ({ id: text(row.id, 256)!, generation: row.generation, version: text(row.version, 256)! })) } : {}),
      ...(text(event.error) ? { error: text(event.error) } : {}),
      ...(event.workerPid !== undefined ? { workerPid: event.workerPid } : {}),
      ...(text(event.sandboxState, 64) ? { sandboxState: text(event.sandboxState, 64) } : {}),
      ...(text(event.isolation, 256) ? { isolation: text(event.isolation, 256) } : {}),
    });
  }

  appendWatcher(event: ExtensionWatchEvent): DurableExtensionAuditRecord {
    return this.append({
      source: "watcher",
      kind: event.kind,
      ...(text(event.extensionId, 256) ? { extensionId: text(event.extensionId, 256) } : {}),
      ...(text(event.packageDir) ? { packageDir: text(event.packageDir) } : {}),
      ...(text(event.fingerprint, 256) ? { fingerprint: text(event.fingerprint, 256) } : {}),
      ...(text(event.error) ? { error: text(event.error) } : {}),
    });
  }

  appendManagement(input: {
    operation: string;
    extensionId?: string;
    reason?: string;
    outcome: "ok" | "error";
    error?: string;
  }): DurableExtensionAuditRecord {
    return this.append({
      source: "management", kind: "operation", operation: text(input.operation, 128)!, outcome: input.outcome,
      ...(text(input.extensionId, 256) ? { extensionId: text(input.extensionId, 256) } : {}),
      ...(text(input.reason) ? { reason: text(input.reason) } : {}),
      ...(text(input.error) ? { error: text(input.error) } : {}),
    });
  }

  list(options: { extensionId?: string; limit?: number } = {}): DurableExtensionAuditRecord[] {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    const filtered = options.extensionId
      ? this.rows.filter((row) => row.extensionId === options.extensionId)
      : this.rows;
    return filtered.slice(Math.max(0, filtered.length - limit)).map((row) => ({
      ...row,
      ...(row.missingDependencies ? { missingDependencies: [...row.missingDependencies] } : {}),
      ...(row.generations ? { generations: row.generations.map((item) => ({ ...item })) } : {}),
    }));
  }

  private append(input: Omit<DurableExtensionAuditRecord, "seq" | "ts">): DurableExtensionAuditRecord {
    const row: DurableExtensionAuditRecord = { seq: ++this.seq, ts: new Date().toISOString(), ...input };
    this.rows.push(row);
    this.trim();
    if (this.filePath) {
      try {
        this.rotateIfNeeded();
        fs.appendFileSync(this.filePath, JSON.stringify(row) + "\n", "utf8");
      } catch { /* audit cannot change runtime semantics */ }
    }
    return row;
  }

  private rotateIfNeeded(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    if (fs.statSync(this.filePath).size < MAX_AUDIT_FILE_BYTES) return;
    const backup = `${this.filePath}.1`;
    fs.rmSync(backup, { force: true });
    fs.renameSync(this.filePath, backup);
  }

  private trim(): void {
    if (this.rows.length > MAX_MEMORY_RECORDS) this.rows.splice(0, this.rows.length - MAX_MEMORY_RECORDS);
  }
}
