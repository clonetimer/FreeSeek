import type { ToolDefinition } from "../../provider";
import { ToolRegistry, type ToolExecutorOverrides, type ToolRegistration } from "../../tool-registry";
import type { ToolContext } from "../../tools";
import type { ExtensionLease } from "./runtime";

/** Immutable HMR snapshot owned by one Agent run. */
export interface ExtensionRunBoundary {
  readonly lease?: ExtensionLease;
  readonly registrations: readonly ToolRegistration[];
  readonly definitions: readonly ToolDefinition[];
  readonly names: ReadonlySet<string>;
  merge(base: readonly ToolDefinition[]): ToolDefinition[];
  baseDefinitions(registered: readonly ToolDefinition[]): ToolDefinition[];
  createRegistry(definitions: readonly ToolDefinition[], overrides: ToolExecutorOverrides): Promise<ToolRegistry>;
  mountSkills(availableTools: readonly string[]): void;
  eventData(): { leaseId: string; generations: ReturnType<ExtensionLease["generationsSummary"]> } | undefined;
  release(): Promise<void>;
}

/**
 * Acquire exactly one Extension generation snapshot at an Agent run boundary.
 * A retained lease supplied by a parent/subagent is reused; otherwise the active
 * runtime generation set is captured once and remains immutable for this run.
 */
export function acquireExtensionRunBoundary(toolCtx: ToolContext): ExtensionRunBoundary {
  const lease = toolCtx.extensionLease ?? toolCtx.extensionRuntime?.acquireLease();
  if (lease) toolCtx.extensionLease = lease;
  const registrations = lease?.toolRegistrations() ?? [];
  const definitions = lease?.toolDefinitions() ?? [];
  const names = new Set(registrations.map((row) => row.name));
  const originalSkillManager = toolCtx.skillManager;
  let skillsMounted = false;
  let released = false;
  const release = async () => {
    if (!lease || released) return;
    released = true;
    if (skillsMounted && toolCtx.skillManager !== originalSkillManager) toolCtx.skillManager = originalSkillManager;
    if (toolCtx.extensionLease === lease) toolCtx.extensionLease = undefined;
    await lease.release();
  };

  return {
    lease,
    registrations,
    definitions,
    names,
    merge: (base) => [...base, ...definitions],
    baseDefinitions: (registered) => registered.filter((definition) => !names.has(definition.function.name)),
    createRegistry: async (toolDefinitions, overrides) => {
      try {
        return ToolRegistry.fromDefinitions(toolDefinitions, overrides, registrations);
      } catch (error) {
        await release();
        throw error;
      }
    },
    mountSkills: (availableTools) => {
      if (!lease || !toolCtx.skillManager) return;
      const assets = lease.skillContributions();
      if (!assets.length) return;
      toolCtx.skillManager = toolCtx.skillManager.withExtensionAssets(assets, availableTools);
      skillsMounted = true;
    },
    eventData: () => lease ? { leaseId: lease.id, generations: lease.generationsSummary() } : undefined,
    release,
  };
}
