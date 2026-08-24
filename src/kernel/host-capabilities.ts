/**
 * FreeSeek host capability contract.
 *
 * Host capabilities describe interaction/presentation services supplied by a host.
 * They do not grant tool permissions: ToolRuntime policy remains authoritative.
 */
export type HostKind = "vscode" | "cli" | "acp" | "desktop" | "eval" | "web";

/** Capability flags a host may expose to the shared Agent Kernel. */
export interface HostCapabilities {
  readonly kind: HostKind;
  readonly interactiveInput: boolean;
  readonly permissionPrompt: boolean;
  readonly diffReview: boolean;
  readonly lsp: boolean;
  readonly imageInput: boolean;
  readonly mcp: boolean;
  readonly skills: boolean;
  readonly multiAgent: boolean;
  readonly scheduling: boolean;
  readonly persistentSessions: boolean;
  readonly richPresentation: boolean;
}

/** Define and freeze a host capability profile at the host boundary. */
export function defineHostCapabilities(profile: HostCapabilities): HostCapabilities {
  return Object.freeze({ ...profile });
}

/** Return whether a host explicitly exposes a capability. */
export function supportsHostCapability(
  host: HostCapabilities,
  capability: Exclude<keyof HostCapabilities, "kind">
): boolean {
  return host[capability];
}

/** Fail explicitly when a caller requires a capability the current host does not provide. */
export function requireHostCapability(
  host: HostCapabilities,
  capability: Exclude<keyof HostCapabilities, "kind">,
  operation: string = capability
): void {
  if (!host[capability]) {
    throw new Error(`FreeSeek host '${host.kind}' does not support ${operation} (${capability})`);
  }
}
