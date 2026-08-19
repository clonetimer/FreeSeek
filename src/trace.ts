/** Trace projection for evals, diagnostics and regression comparison. */
import type { SessionEvent } from "./eventlog";
import { querySessionEvents } from "./eventlog";

export interface ToolTraceMetric {
  calls: number;
  blocked: number;
  timedOut: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface SessionTraceSummary {
  sessionId: string;
  actor: string;
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  turns: number;
  steps: number;
  modelRequests: number;
  modelErrors: number;
  modelLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  blockedToolCalls: number;
  timedOutToolCalls: number;
  approvalsRequested: number;
  approvalsAllowed: number;
  approvalsDenied: number;
  contextPlans: number;
  contextPlanErrors: number;
  contextFilesSelected: number;
  contextPlanTokens: number;
  contextPlanDurationMs: number;
  /** Search/list calls after a context plan. Neutral diagnostic: lower can mean better use of prefetched evidence. */
  contextExploratorySearchCalls: number;
  contextPlannedReadCalls: number;
  contextUnplannedReadCalls: number;
  contextPlannedMutationCalls: number;
  contextUnplannedMutationCalls: number;
  contextTopCandidateTouches: number;
  checkpoints: number;
  compactions: number;
  forks: number;
  finalReason?: string;
  finalError?: string;
  toolUsage: Record<string, ToolTraceMetric>;
}

const TRACE_TYPES = [
  "turn/start", "turn/end", "step/end", "model/result", "tool/call", "tool/result",
  "approval/request", "approval/result", "context/plan", "tool_timeout", "checkpoint", "compact", "session/fork",
] as const;

function isoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizedToolPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function matchesPlannedPath(candidate: string, planned: ReadonlySet<string>): boolean {
  if (!candidate) return false;
  if (planned.has(candidate)) return true;
  const absoluteLike = candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate);
  if (!absoluteLike) return false;
  for (const target of planned) if (candidate.endsWith(`/${target}`)) return true;
  return false;
}

const CONTEXT_SEARCH_TOOLS = new Set(["grep", "search_files", "list_directory"]);
const CONTEXT_MUTATION_TOOLS = new Set(["edit_file", "write_file", "delete_file"]);

/** Project selected durable events into stable eval/diagnostic metrics. */
export function summarizeSessionTrace(events: readonly SessionEvent[], actor = "main"): SessionTraceSummary {
  const selected = events.filter((event) => (event.actor ?? "main") === actor);
  const sessionId = selected[0]?.sessionId ?? events[0]?.sessionId ?? "";
  const summary: SessionTraceSummary = {
    sessionId,
    actor,
    durationMs: 0,
    turns: 0,
    steps: 0,
    modelRequests: 0,
    modelErrors: 0,
    modelLatencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    blockedToolCalls: 0,
    timedOutToolCalls: 0,
    approvalsRequested: 0,
    approvalsAllowed: 0,
    approvalsDenied: 0,
    contextPlans: 0,
    contextPlanErrors: 0,
    contextFilesSelected: 0,
    contextPlanTokens: 0,
    contextPlanDurationMs: 0,
    contextExploratorySearchCalls: 0,
    contextPlannedReadCalls: 0,
    contextUnplannedReadCalls: 0,
    contextPlannedMutationCalls: 0,
    contextUnplannedMutationCalls: 0,
    contextTopCandidateTouches: 0,
    checkpoints: 0,
    compactions: 0,
    forks: 0,
    toolUsage: {},
  };
  const toolNameByCall = new Map<string, string>();
  let plannedPaths = new Set<string>();
  let topCandidate = "";
  let planActive = false;
  let firstTurnStart: number | undefined;
  let lastTurnEnd: number | undefined;
  for (const event of selected) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "turn/start") {
      summary.turns++;
      firstTurnStart ??= numberField(data.startedAt) || isoMs(event.ts);
      summary.startedAt ??= event.ts;
    } else if (event.type === "turn/end") {
      lastTurnEnd = numberField(data.endedAt) || isoMs(event.ts);
      summary.endedAt = event.ts;
      summary.finalReason = typeof data.reason === "string" ? data.reason : summary.finalReason;
      if (typeof data.error === "string" && data.error) summary.finalError = data.error;
    } else if (event.type === "step/end") {
      summary.steps++;
    } else if (event.type === "model/result") {
      summary.modelRequests++;
      summary.modelLatencyMs += numberField(data.durationMs);
      summary.promptTokens += numberField(data.promptTokens);
      summary.completionTokens += numberField(data.completionTokens);
      summary.totalTokens += numberField(data.totalTokens);
      if (typeof data.error === "string" && data.error) summary.modelErrors++;
    } else if (event.type === "tool/call") {
      summary.toolCalls++;
      const name = typeof data.name === "string" ? data.name : "unknown";
      const id = typeof data.callId === "string" ? data.callId : `seq:${event.seq}`;
      toolNameByCall.set(id, name);
      summary.toolUsage[name] ??= { calls: 0, blocked: 0, timedOut: 0, totalDurationMs: 0, maxDurationMs: 0 };
      summary.toolUsage[name].calls++;
      if (planActive) {
        const args = data.args && typeof data.args === "object" ? data.args as Record<string, unknown> : {};
        const toolPath = normalizedToolPath(args.path);
        const planned = matchesPlannedPath(toolPath, plannedPaths);
        const topTouched = matchesPlannedPath(toolPath, new Set(topCandidate ? [topCandidate] : []));
        if (CONTEXT_SEARCH_TOOLS.has(name)) summary.contextExploratorySearchCalls++;
        if (name === "read_file") planned ? summary.contextPlannedReadCalls++ : summary.contextUnplannedReadCalls++;
        if (CONTEXT_MUTATION_TOOLS.has(name)) planned ? summary.contextPlannedMutationCalls++ : summary.contextUnplannedMutationCalls++;
        if (topTouched) summary.contextTopCandidateTouches++;
      }
    } else if (event.type === "tool/result") {
      const id = typeof data.callId === "string" ? data.callId : "";
      const name = typeof data.name === "string" ? data.name : toolNameByCall.get(id) ?? "unknown";
      const metric = summary.toolUsage[name] ??= { calls: 0, blocked: 0, timedOut: 0, totalDurationMs: 0, maxDurationMs: 0 };
      if (typeof data.blocked === "string" && data.blocked) { summary.blockedToolCalls++; metric.blocked++; }
      if (data.timedOut === true) { summary.timedOutToolCalls++; metric.timedOut++; }
      const duration = numberField(data.durationMs);
      metric.totalDurationMs += duration;
      metric.maxDurationMs = Math.max(metric.maxDurationMs, duration);
    } else if (event.type === "approval/request") {
      summary.approvalsRequested++;
    } else if (event.type === "approval/result") {
      if (data.allow === true) summary.approvalsAllowed++;
      else summary.approvalsDenied++;
    } else if (event.type === "context/plan") {
      summary.contextPlans++;
      const hasError = typeof data.error === "string" && Boolean(data.error);
      if (hasError) summary.contextPlanErrors++;
      const selectedRows = Array.isArray(data.selectedFiles) ? data.selectedFiles : [];
      summary.contextFilesSelected += selectedRows.length;
      summary.contextPlanTokens += numberField(data.estimatedTokens);
      summary.contextPlanDurationMs += numberField(data.durationMs);
      plannedPaths = new Set(selectedRows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const value = normalizedToolPath((row as Record<string, unknown>).path);
        return value ? [value] : [];
      }));
      topCandidate = [...plannedPaths][0] ?? "";
      planActive = !hasError && plannedPaths.size > 0;
    } else if (event.type === "checkpoint") {
      summary.checkpoints++;
    } else if (event.type === "compact") {
      summary.compactions++;
    } else if (event.type === "session/fork") {
      summary.forks++;
    }
  }
  if (firstTurnStart !== undefined && lastTurnEnd !== undefined) summary.durationMs = Math.max(0, lastTurnEnd - firstTurnStart);
  return summary;
}

/** Indexed trace query: reads only trace-relevant event types from the byte-offset sidecar. */
export function loadSessionTrace(dir: string, sessionId: string, actor = "main"): SessionTraceSummary {
  return summarizeSessionTrace(querySessionEvents(dir, sessionId, { actor, types: TRACE_TYPES }), actor);
}

export interface TraceDelta {
  durationMs: number;
  steps: number;
  modelRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  blockedToolCalls: number;
  timedOutToolCalls: number;
  approvalsRequested: number;
  contextPlans: number;
  contextPlanErrors: number;
  contextFilesSelected: number;
  contextPlanTokens: number;
  contextPlanDurationMs: number;
  contextExploratorySearchCalls: number;
  contextPlannedReadCalls: number;
  contextUnplannedReadCalls: number;
  contextPlannedMutationCalls: number;
  contextUnplannedMutationCalls: number;
  contextTopCandidateTouches: number;
}

/** Numeric B-A delta for experiment reports; negative is usually better for cost/latency/steps. */
export function diffSessionTrace(a: SessionTraceSummary, b: SessionTraceSummary): TraceDelta {
  return {
    durationMs: b.durationMs - a.durationMs,
    steps: b.steps - a.steps,
    modelRequests: b.modelRequests - a.modelRequests,
    promptTokens: b.promptTokens - a.promptTokens,
    completionTokens: b.completionTokens - a.completionTokens,
    totalTokens: b.totalTokens - a.totalTokens,
    toolCalls: b.toolCalls - a.toolCalls,
    blockedToolCalls: b.blockedToolCalls - a.blockedToolCalls,
    timedOutToolCalls: b.timedOutToolCalls - a.timedOutToolCalls,
    approvalsRequested: b.approvalsRequested - a.approvalsRequested,
    contextPlans: b.contextPlans - a.contextPlans,
    contextPlanErrors: b.contextPlanErrors - a.contextPlanErrors,
    contextFilesSelected: b.contextFilesSelected - a.contextFilesSelected,
    contextPlanTokens: b.contextPlanTokens - a.contextPlanTokens,
    contextPlanDurationMs: b.contextPlanDurationMs - a.contextPlanDurationMs,
    contextExploratorySearchCalls: b.contextExploratorySearchCalls - a.contextExploratorySearchCalls,
    contextPlannedReadCalls: b.contextPlannedReadCalls - a.contextPlannedReadCalls,
    contextUnplannedReadCalls: b.contextUnplannedReadCalls - a.contextUnplannedReadCalls,
    contextPlannedMutationCalls: b.contextPlannedMutationCalls - a.contextPlannedMutationCalls,
    contextUnplannedMutationCalls: b.contextUnplannedMutationCalls - a.contextUnplannedMutationCalls,
    contextTopCandidateTouches: b.contextTopCandidateTouches - a.contextTopCandidateTouches,
  };
}
