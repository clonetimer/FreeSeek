import type { ToolDefinition } from "../../provider";
import type { ToolRuntimeSpec } from "../../tool-runtime-spec";
import type { ToolContext } from "../../tools";

/** H0-H3 trusted in-process modules plus H4 explicitly sandboxed untrusted modules. */
export type ExtensionTrust = "trusted" | "untrusted";

/** Capabilities are declarations inspected before a generation is staged. */
export interface ExtensionCapabilities {
  tools?: boolean;
  connectors?: boolean;
  skills?: boolean;
  hooks?: boolean;
  mcp?: boolean;
  network?: boolean;
  shell?: boolean;
  filesystem?: "none" | "read" | "write";
  persistence?: boolean;
  ui?: boolean;
}

/** Stable identity and dependency contract for one extension package. */
export interface ExtensionManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName?: string;
  trust: ExtensionTrust;
  capabilities?: ExtensionCapabilities;
  requires?: {
    extensions?: string[];
  };
}

export type ExtensionDisposer = () => void | Promise<void>;

/** A tool contribution uses a local name; the runtime owns canonical namespacing. */
export interface ExtensionToolContribution {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  runtime: Omit<ToolRuntimeSpec, "name">;
  execute: (args: any, ctx: ToolContext) => Promise<string>;
}

/** Connector contribution retained as one lifecycle unit but projected as ToolRegistry entries. */
export interface ExtensionConnectorContribution {
  id: string;
  name: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  execute: (name: string, args: any, ctx: ToolContext) => Promise<string>;
  dispose?: ExtensionDisposer;
}

/** Generation-owned skill asset. Markdown is snapshotted at activation, never reread from a mutable package path. */
export interface ExtensionSkillContribution {
  name: string;
  markdown: string;
  source?: string;
}

export interface ExtensionPolicyResult {
  blocked?: string;
  warnings?: string[];
}

/** Monotonic pre-tool policy: may block/warn, never grant or bypass built-in approval/policy. */
export interface ExtensionPolicyContribution {
  name: string;
  evaluate(toolName: string, input: any, ctx: ToolContext): ExtensionPolicyResult | void | Promise<ExtensionPolicyResult | void>;
}

export type ExtensionHookEvent = "pre-tool" | "post-tool";
export interface ExtensionHookResult extends ExtensionPolicyResult {
  /** post-tool hooks may append an informational note; they cannot replace the tool result. */
  note?: string;
}

/** Generation-owned lifecycle hook. Pre hooks may block/warn; post hooks may only append notes/warnings. */
export interface ExtensionHookContribution {
  name: string;
  event: ExtensionHookEvent;
  run(input: {
    toolName: string;
    args: any;
    result?: string;
    ctx: ToolContext;
  }): ExtensionHookResult | void | Promise<ExtensionHookResult | void>;
}

/** MCP adapter output retained as one generation-owned lifecycle unit. */
export interface ExtensionMcpContribution {
  id: string;
  name?: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  execute: (name: string, args: any, ctx: ToolContext) => Promise<string>;
  dispose?: ExtensionDisposer;
}

/** The only mutation surface exposed while a trusted generation is staged. */
export interface ExtensionActivationContext {
  readonly manifest: Readonly<ExtensionManifest>;
  readonly generation: number;
  effect(disposer: ExtensionDisposer, label?: string): void;
  registerTool(contribution: ExtensionToolContribution): string;
  registerConnector(contribution: ExtensionConnectorContribution): readonly string[];
  registerSkill(contribution: ExtensionSkillContribution): string;
  registerPolicy(contribution: ExtensionPolicyContribution): string;
  registerHook(contribution: ExtensionHookContribution): string;
  registerMcp(contribution: ExtensionMcpContribution): readonly string[];
}

/** In-memory module descriptor. File loading/watch is layered above this core. */
export interface ExtensionSandboxStatus {
  mode: "sandbox";
  state: "starting" | "running" | "crashed" | "stopped";
  platform: string;
  isolation: string;
  pid?: number;
  lastError?: string;
}

export interface ExtensionModuleExecution {
  mode: "sandbox";
  /** Internal attestation that package code is executed outside the Host process. */
  enforced: true;
  status(): ExtensionSandboxStatus;
}

export interface ExtensionModule {
  manifest: ExtensionManifest;
  execution?: ExtensionModuleExecution;
  activate(
    context: ExtensionActivationContext
  ): void | ExtensionDisposer | Promise<void | ExtensionDisposer>;
}

export type ExtensionRuntimeState = "active" | "pending" | "error" | "absent";

/** Observable runtime state; no host-specific UI types belong here. */
export interface ExtensionStatus {
  id: string;
  state: ExtensionRuntimeState;
  activeVersion?: string;
  activeGeneration?: number;
  activeLeases?: number;
  pendingVersion?: string;
  missingDependencies?: string[];
  retiredGenerations: number[];
  lastError?: string;
  sandbox?: ExtensionSandboxStatus;
}

export type ExtensionAuditKind =
  | "discover"
  | "pending"
  | "stage"
  | "activate"
  | "reload"
  | "rollback"
  | "retire"
  | "dispose"
  | "remove"
  | "lease"
  | "release"
  | "sandbox-spawn"
  | "sandbox-ready"
  | "sandbox-timeout"
  | "sandbox-crash"
  | "sandbox-protocol"
  | "sandbox-dispose";

/** Host-neutral audit record; hosts may project it into EventLog/trace/UI. */
export interface ExtensionAuditEvent {
  seq: number;
  ts: string;
  kind: ExtensionAuditKind;
  extensionId?: string;
  generation?: number;
  version?: string;
  leaseId?: string;
  reason?: string;
  missingDependencies?: string[];
  generations?: Array<{ id: string; generation: number; version: string }>;
  error?: string;
  workerPid?: number;
  sandboxState?: ExtensionSandboxStatus["state"];
  isolation?: string;
}

/** Small immutable view used by diagnostics and tests. */
export interface ExtensionGenerationSummary {
  id: string;
  generation: number;
  version: string;
  toolDefinitions: readonly ToolDefinition[];
  skillNames: readonly string[];
  policyNames: readonly string[];
  hookNames: readonly string[];
  leases: number;
  retired: boolean;
  trust: ExtensionTrust;
  executionMode: "trusted-in-process" | "sandbox";
}
