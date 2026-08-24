import type { ToolDefinition } from "../../provider";
import type { ToolRegistration } from "../../tool-registry";
import {
  assertExtensionId,
  createGenerationContributions,
} from "./contributions";
import type {
  ExtensionAuditEvent,
  ExtensionDisposer,
  ExtensionGenerationSummary,
  ExtensionHookContribution,
  ExtensionHookResult,
  ExtensionAuditKind,
  ExtensionManifest,
  ExtensionModule,
  ExtensionPolicyContribution,
  ExtensionPolicyResult,
  ExtensionSkillContribution,
  ExtensionStatus,
} from "./contracts";

export type { ExtensionModule, ExtensionStatus, ExtensionAuditEvent } from "./contracts";
export { extensionToolName, extensionConnectorToolName, extensionMcpToolName } from "./contributions";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function freezeJson<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  return value;
}

function cloneManifest(manifest: ExtensionManifest): Readonly<ExtensionManifest> {
  return freezeJson(JSON.parse(JSON.stringify(manifest)) as ExtensionManifest);
}

function validateManifest(input: ExtensionManifest): Readonly<ExtensionManifest> {
  if (!input || typeof input !== "object") throw new Error("extension manifest 缺失");
  if (input.schemaVersion !== 1) throw new Error(`extension manifest schemaVersion 不支持：${String((input as any).schemaVersion)}`);
  const id = assertExtensionId(input.id);
  const version = String(input.version ?? "").trim();
  if (!VERSION_RE.test(version)) throw new Error(`extension ${id}: version 必须是 SemVer：${version || "<empty>"}`);
  if (input.trust !== "trusted" && input.trust !== "untrusted") {
    throw new Error(`extension ${id}: trust 必须是 trusted|untrusted`);
  }
  const capabilities = input.capabilities ?? {};
  if (capabilities.ui) throw new Error(`extension ${id}: v1 禁止 host-specific UI contribution`);
  if (capabilities.filesystem && !["none", "read", "write"].includes(capabilities.filesystem)) {
    throw new Error(`extension ${id}: filesystem capability 非法`);
  }
  const deps = [...new Set(input.requires?.extensions ?? [])].map((dep) =>
    assertExtensionId(dep, `extension ${id} dependency`)
  );
  if (deps.includes(id)) throw new Error(`extension ${id}: 不允许依赖自身`);
  return cloneManifest({
    ...input, id, version, capabilities: { ...capabilities },
    ...(deps.length ? { requires: { extensions: deps } } : { requires: undefined }),
  });
}

class EffectScope {
  private rows: Array<{ disposer: ExtensionDisposer; label?: string }> = [];
  private disposed = false;

  add(disposer: ExtensionDisposer, label?: string): void {
    if (this.disposed) throw new Error("extension effect scope 已释放");
    if (typeof disposer !== "function") throw new Error("extension effect disposer 必须是函数");
    this.rows.push({ disposer, label });
  }

  async dispose(): Promise<string[]> {
    if (this.disposed) return [];
    this.disposed = true;
    const errors: string[] = [];
    for (let i = this.rows.length - 1; i >= 0; i--) {
      try {
        await this.rows[i].disposer();
      } catch (error: any) {
        errors.push(`${this.rows[i].label ?? `effect#${i + 1}`}: ${error?.message ?? String(error)}`);
      }
    }
    this.rows = [];
    return errors;
  }
}

interface Generation {
  id: string;
  generation: number;
  manifest: Readonly<ExtensionManifest>;
  module: ExtensionModule;
  registrations: readonly ToolRegistration[];
  skills: readonly Readonly<ExtensionSkillContribution>[];
  policies: readonly Readonly<ExtensionPolicyContribution>[];
  hooks: readonly Readonly<ExtensionHookContribution>[];
  execution?: ExtensionModule["execution"];
  scope: EffectScope;
  leases: number;
  retired: boolean;
  disposed: boolean;
}

interface Slot {
  active?: Generation;
  pending?: { module: ExtensionModule; manifest: Readonly<ExtensionManifest>; missing: string[] };
  retired: Generation[];
  lastError?: string;
}

export interface ExtensionRuntimeOptions {
  onAudit?: (event: ExtensionAuditEvent) => void;
}

/**
 * A lease pins active generations for exactly one Agent run/turn.
 * Retired generations cannot dispose until every retained lease has released.
 */
export class ExtensionLease {
  private released = false;

  constructor(
    private readonly runtime: ExtensionRuntime,
    readonly id: string,
    private readonly generations: readonly Generation[]
  ) {}

  /** Retain the same generation set for a child Agent spawned inside this turn. */
  retain(): ExtensionLease {
    if (this.released) throw new Error(`extension lease ${this.id} 已释放`);
    return this.runtime.retainGenerations(this.generations);
  }

  /** Provider-visible definitions contributed by the pinned generations. */
  toolDefinitions(): readonly ToolDefinition[] {
    return this.generations.flatMap((generation) => generation.registrations.map((row) => row.definition));
  }

  /** Full Registry rows preserve executors/runtime policy for the pinned generations. */
  toolRegistrations(): readonly ToolRegistration[] {
    return this.generations.flatMap((generation) => generation.registrations);
  }

  /** Immutable skill assets contributed by the pinned generations. */
  skillContributions(): readonly Readonly<ExtensionSkillContribution>[] {
    return this.generations.flatMap((generation) => generation.skills);
  }

  /** Monotonic generation-pinned pre-tool policies. */
  async evaluatePolicies(toolName: string, input: any, ctx: import("../../tools").ToolContext): Promise<ExtensionPolicyResult> {
    const warnings: string[] = [];
    for (const generation of this.generations) {
      for (const policy of generation.policies) {
        const result = await policy.evaluate(toolName, input, ctx);
        if (!result) continue;
        if (result.blocked) return { blocked: String(result.blocked), warnings };
        if (result.warnings?.length) warnings.push(...result.warnings.map(String));
      }
    }
    return warnings.length ? { warnings } : {};
  }

  /** Generation-pinned pre/post hooks; post hooks cannot block a result already produced. */
  async runHooks(
    event: "pre-tool" | "post-tool",
    input: { toolName: string; args: any; result?: string; ctx: import("../../tools").ToolContext }
  ): Promise<ExtensionHookResult> {
    const warnings: string[] = [];
    const notes: string[] = [];
    for (const generation of this.generations) {
      for (const hook of generation.hooks) {
        if (hook.event !== event) continue;
        const result = await hook.run(input);
        if (!result) continue;
        if (event === "pre-tool" && result.blocked) return { blocked: String(result.blocked), warnings };
        if (result.warnings?.length) warnings.push(...result.warnings.map(String));
        if (event === "post-tool" && result.note) notes.push(String(result.note));
      }
    }
    return {
      ...(warnings.length ? { warnings } : {}),
      ...(notes.length ? { note: notes.join("\n") } : {}),
    };
  }

  /** Stable audit projection of the generations used by this turn. */
  generationsSummary(): Array<{ id: string; generation: number; version: string }> {
    return this.generations.map((generation) => ({
      id: generation.id,
      generation: generation.generation,
      version: generation.manifest.version,
    }));
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.runtime.releaseLease(this);
  }

  /** @internal runtime-only access; callers should use public projections above. */
  _generationRefs(): readonly Generation[] {
    return this.generations;
  }
}

/**
 * Host-neutral General Extension Runtime core.
 *
 * It never mutates a live ToolRegistry. A new generation is staged and atomically becomes
 * the active pointer; Agent runs acquire immutable generation leases at their boundary.
 */
export class ExtensionRuntime {
  private readonly slots = new Map<string, Slot>();
  private generationSeq = 0;
  private auditSeq = 0;
  private leaseSeq = 0;
  private closed = false;

  constructor(private readonly options: ExtensionRuntimeOptions = {}) {}

  private audit(event: Omit<ExtensionAuditEvent, "seq" | "ts">): void {
    const row: ExtensionAuditEvent = {
      seq: ++this.auditSeq,
      ts: new Date().toISOString(),
      ...event,
    };
    try { this.options.onAudit?.(row); } catch { /* audit sink cannot break runtime semantics */ }
  }

  private slot(id: string): Slot {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = { retired: [] };
      this.slots.set(id, slot);
    }
    return slot;
  }

  private missingDependencies(manifest: Readonly<ExtensionManifest>): string[] {
    return (manifest.requires?.extensions ?? []).filter((id) => !this.slots.get(id)?.active);
  }

  /** Discover/stage a module. Successful reloads atomically replace only the active pointer. */
  async apply(module: ExtensionModule, reason = "apply"): Promise<ExtensionStatus> {
    if (this.closed) throw new Error("ExtensionRuntime 已关闭");
    const manifest = validateManifest(module.manifest);
    if (manifest.trust === "untrusted" && (module.execution?.mode !== "sandbox" || module.execution.enforced !== true)) {
      throw new Error(`extension ${manifest.id}: trust=untrusted 必须使用 H4 out-of-process sandbox；禁止 in-process fallback`);
    }
    const id = manifest.id;
    const slot = this.slot(id);
    this.audit({ kind: "discover", extensionId: id, version: manifest.version, reason });

    const missing = this.missingDependencies(manifest);
    if (missing.length) {
      slot.pending = { module, manifest, missing };
      slot.lastError = undefined;
      this.audit({ kind: "pending", extensionId: id, version: manifest.version, reason, missingDependencies: missing });
      return this.status(id);
    }

    await this.activateCandidate(slot, module, manifest, reason);
    await this.reconcilePending();
    return this.status(id);
  }

  private async activateCandidate(
    slot: Slot,
    module: ExtensionModule,
    manifest: Readonly<ExtensionManifest>,
    reason: string
  ): Promise<void> {
    const generation = ++this.generationSeq;
    const scope = new EffectScope();
    const contributions = createGenerationContributions(
      manifest,
      generation,
      (disposer, label) => scope.add(disposer, label)
    );
    this.audit({ kind: "stage", extensionId: manifest.id, generation, version: manifest.version, reason });

    try {
      const disposer = await module.activate(contributions.context);
      if (typeof disposer === "function") scope.add(disposer, "activate:return");

      const currentMissing = this.missingDependencies(manifest);
      if (currentMissing.length) {
        await scope.dispose();
        slot.pending = { module, manifest, missing: currentMissing };
        this.audit({
          kind: "pending",
          extensionId: manifest.id,
          generation,
          version: manifest.version,
          reason: "dependency changed during stage",
          missingDependencies: currentMissing,
        });
        return;
      }

      const previous = slot.active;
      const next: Generation = {
        id: manifest.id,
        generation,
        manifest,
        module,
        registrations: Object.freeze([...contributions.registrations]),
        skills: Object.freeze([...contributions.skills]),
        policies: Object.freeze([...contributions.policies]),
        hooks: Object.freeze([...contributions.hooks]),
        execution: module.execution,
        scope,
        leases: 0,
        retired: false,
        disposed: false,
      };
      slot.active = next;
      slot.pending = undefined;
      slot.lastError = undefined;
      this.audit({
        kind: previous ? "reload" : "activate",
        extensionId: manifest.id,
        generation,
        version: manifest.version,
        reason,
      });
      if (previous) await this.retire(previous, `replaced by generation ${generation}`);
    } catch (error: any) {
      const cleanupErrors = await scope.dispose();
      const message = error?.message ?? String(error);
      slot.lastError = cleanupErrors.length ? `${message}; cleanup: ${cleanupErrors.join("; ")}` : message;
      slot.pending = undefined;
      this.audit({
        kind: "rollback",
        extensionId: manifest.id,
        generation,
        version: manifest.version,
        reason,
        error: slot.lastError,
      });
    }
  }

  private async reconcilePending(): Promise<void> {
    let progressed = true;
    let guard = 0;
    while (progressed && guard++ < this.slots.size + 1) {
      progressed = false;
      for (const slot of this.slots.values()) {
        const pending = slot.pending;
        if (!pending) continue;
        const missing = this.missingDependencies(pending.manifest);
        if (missing.length) {
          pending.missing = missing;
          continue;
        }
        slot.pending = undefined;
        await this.activateCandidate(slot, pending.module, pending.manifest, "dependency-satisfied");
        progressed = true;
      }
    }
  }

  private async retire(generation: Generation, reason: string): Promise<void> {
    if (generation.retired) return;
    generation.retired = true;
    const slot = this.slot(generation.id);
    slot.retired.push(generation);
    this.audit({
      kind: "retire",
      extensionId: generation.id,
      generation: generation.generation,
      version: generation.manifest.version,
      reason,
    });
    if (generation.leases === 0) await this.disposeGeneration(generation);
  }

  private async disposeGeneration(generation: Generation): Promise<void> {
    if (generation.disposed || generation.leases > 0) return;
    generation.disposed = true;
    const errors = await generation.scope.dispose();
    const slot = this.slot(generation.id);
    slot.retired = slot.retired.filter((row) => row !== generation);
    this.audit({
      kind: "dispose",
      extensionId: generation.id,
      generation: generation.generation,
      version: generation.manifest.version,
      ...(errors.length ? { error: errors.join("; ") } : {}),
    });
  }

  /** H4 supervisor lifecycle is process-level audit; faults on the active generation surface in status. */
  recordSandboxLifecycle(input: {
    kind: Extract<ExtensionAuditKind, "sandbox-spawn" | "sandbox-ready" | "sandbox-timeout" | "sandbox-crash" | "sandbox-protocol" | "sandbox-dispose">;
    extensionId: string;
    generation: number;
    version: string;
    workerPid?: number;
    sandboxState?: "starting" | "running" | "crashed" | "stopped";
    isolation?: string;
    error?: string;
  }): void {
    const id = assertExtensionId(input.extensionId);
    this.audit({
      kind: input.kind, extensionId: id, generation: input.generation, version: input.version,
      ...(input.workerPid ? { workerPid: input.workerPid } : {}),
      ...(input.sandboxState ? { sandboxState: input.sandboxState } : {}),
      ...(input.isolation ? { isolation: input.isolation } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
    if (["sandbox-timeout", "sandbox-crash", "sandbox-protocol"].includes(input.kind)) {
      const slot = this.slots.get(id);
      if (slot?.active?.generation === input.generation) slot.lastError = input.error ?? input.kind;
    }
  }

  /** Remove the desired extension. Dependents become PENDING instead of silently running partial state. */
  async remove(idInput: string, reason = "remove"): Promise<ExtensionStatus> {
    const id = assertExtensionId(idInput);
    const slot = this.slot(id);
    slot.pending = undefined;
    if (slot.active) {
      const active = slot.active;
      slot.active = undefined;
      await this.retire(active, reason);
    }
    slot.lastError = undefined;
    this.audit({ kind: "remove", extensionId: id, reason });

    for (const [dependentId, dependent] of this.slots) {
      const active = dependent.active;
      if (!active || !(active.manifest.requires?.extensions ?? []).includes(id)) continue;
      dependent.active = undefined;
      dependent.pending = {
        module: active.module,
        manifest: active.manifest,
        missing: [id],
      };
      await this.retire(active, `dependency removed: ${id}`);
      this.audit({
        kind: "pending",
        extensionId: dependentId,
        version: active.manifest.version,
        reason: `dependency removed: ${id}`,
        missingDependencies: [id],
      });
    }
    return this.status(id);
  }

  /** Acquire one immutable generation set for a new Agent run. */
  acquireLease(): ExtensionLease {
    if (this.closed) throw new Error("ExtensionRuntime 已关闭");
    const generations = [...this.slots.values()]
      .map((slot) => slot.active)
      .filter((row): row is Generation => !!row)
      .sort((a, b) => a.id.localeCompare(b.id));
    return this.retainGenerations(generations);
  }

  /** @internal used by ExtensionLease.retain() for child Agent inheritance. */
  retainGenerations(generations: readonly Generation[]): ExtensionLease {
    if (this.closed) throw new Error("ExtensionRuntime 已关闭");
    for (const generation of generations) {
      if (generation.disposed) throw new Error(`extension generation 已释放：${generation.id}#${generation.generation}`);
      generation.leases += 1;
    }
    const id = `lease-${(++this.leaseSeq).toString(36)}`;
    const lease = new ExtensionLease(this, id, [...generations]);
    this.audit({ kind: "lease", leaseId: id, generations: lease.generationsSummary() });
    return lease;
  }

  /** @internal release and dispose only retired generations whose final lease is gone. */
  async releaseLease(lease: ExtensionLease): Promise<void> {
    const generations = lease._generationRefs();
    for (const generation of generations) generation.leases = Math.max(0, generation.leases - 1);
    this.audit({ kind: "release", leaseId: lease.id, generations: lease.generationsSummary() });
    for (const generation of generations) {
      if (generation.retired && generation.leases === 0) await this.disposeGeneration(generation);
    }
  }

  /** Current observable state for one extension id. */
  status(idInput: string): ExtensionStatus {
    const id = assertExtensionId(idInput);
    const slot = this.slots.get(id);
    if (!slot) return { id, state: "absent", retiredGenerations: [] };
    const missing = slot.pending?.missing ?? [];
    const state = slot.active ? "active" : slot.pending ? "pending" : slot.lastError ? "error" : "absent";
    return {
      id,
      state,
      ...(slot.active ? {
        activeVersion: slot.active.manifest.version,
        activeGeneration: slot.active.generation,
        activeLeases: slot.active.leases,
      } : {}),
      ...(slot.pending ? { pendingVersion: slot.pending.manifest.version } : {}),
      ...(missing.length ? { missingDependencies: [...missing] } : {}),
      retiredGenerations: slot.retired.map((row) => row.generation),
      ...(slot.lastError ? { lastError: slot.lastError } : {}),
      ...(slot.active?.execution ? { sandbox: slot.active.execution.status() } : {}),
    };
  }

  /** Sorted runtime state snapshot for diagnostics/management hosts. */
  list(): ExtensionStatus[] {
    return [...this.slots.keys()].sort().map((id) => this.status(id));
  }

  /** Explicit operator reconcile of dependency-PENDING slots; does not rediscover filesystem packages. */
  async reconcile(): Promise<ExtensionStatus[]> {
    if (this.closed) throw new Error("ExtensionRuntime 已关闭");
    await this.reconcilePending();
    return this.list();
  }

  /** Diagnostic generation snapshot; intended for tests and management surfaces. */
  generations(): ExtensionGenerationSummary[] {
    const rows: ExtensionGenerationSummary[] = [];
    for (const slot of this.slots.values()) {
      for (const generation of [slot.active, ...slot.retired].filter((row): row is Generation => !!row)) {
        rows.push({
          id: generation.id,
          generation: generation.generation,
          version: generation.manifest.version,
          toolDefinitions: generation.registrations.map((row) => row.definition),
          skillNames: generation.skills.map((row) => row.name),
          policyNames: generation.policies.map((row) => row.name),
          hookNames: generation.hooks.map((row) => row.name),
          leases: generation.leases,
          retired: generation.retired,
          trust: generation.manifest.trust,
          executionMode: generation.execution?.mode ?? "trusted-in-process",
        });
      }
    }
    return rows.sort((a, b) => a.generation - b.generation);
  }

  /** Stop accepting new generations/leases and retire everything already active. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots.values()) {
      slot.pending = undefined;
      if (!slot.active) continue;
      const active = slot.active;
      slot.active = undefined;
      await this.retire(active, "runtime-dispose");
    }
  }
}
