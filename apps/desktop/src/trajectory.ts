import type { DesktopEvent } from "./contracts";
import { boundedUnknownText, DESKTOP_UI_BUDGETS } from "./ui-performance";

/** Trajectory categories rendered by the Desktop inspector. */
export type DesktopTrajectoryKind = "turn" | "message" | "reasoning" | "tool" | "mode" | "permission" | "elicitation" | "event";

/** User-facing trajectory filter families. Permission and elicitation share the interaction filter. */
export type DesktopTrajectoryFilterKind = "all" | "turn" | "tool" | "message" | "reasoning" | "mode" | "interaction" | "event";

/** Minimal searchable shape kept independent from DOM and Kernel/EventLog state. */
export interface DesktopTrajectorySearchRecord {
  kind: DesktopTrajectoryKind;
  title: string;
  subtitle: string;
  status: string;
  turn?: number;
  detail?: unknown;
  /** Optional precomputed index for long-session filtering. */
  searchText?: string;
}

/** Renderer-safe lifecycle projection for one Desktop Host interaction request. */
export interface DesktopInteractionPresentation {
  requestId: string;
  kind: "permission" | "elicitation";
  title: string;
  summary: string;
  status: "pending" | "completed" | "cancelled";
  toolCallId?: string;
  detail: unknown;
}


function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function compact(value: unknown, cap = DESKTOP_UI_BUDGETS.trajectorySearchDetailChars): string {
  return boundedUnknownText(value, cap).text;
}

function firstLine(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  return (text.split(/\r?\n/, 1)[0]?.trim() || fallback).slice(0, 180);
}

function filterMatches(kind: DesktopTrajectoryKind, filter: DesktopTrajectoryFilterKind): boolean {
  if (filter === "all") return true;
  if (filter === "interaction") return kind === "permission" || kind === "elicitation";
  return kind === filter;
}

/** Build a bounded lower-case search index for one projected trajectory row. */
export function desktopTrajectorySearchText(row: DesktopTrajectorySearchRecord): string {
  return [row.kind, row.title, row.subtitle, row.status, row.turn ? `turn ${row.turn}` : "", compact(row.detail)]
    .join("\n")
    .toLowerCase();
}

/** Match a trajectory row by semantic family plus case-insensitive token search. */
export function matchesDesktopTrajectoryFilter(
  row: DesktopTrajectorySearchRecord,
  filter: DesktopTrajectoryFilterKind,
  query: string
): boolean {
  if (!filterMatches(row.kind, filter)) return false;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = row.searchText ?? desktopTrajectorySearchText(row);
  return tokens.every((token) => haystack.includes(token));
}

/** Normalize a Desktop Host permission/elicitation request for the trajectory inspector. */
export function projectDesktopHostRequest(event: Extract<DesktopEvent, { type: "host-request" }>): DesktopInteractionPresentation {
  const payload = record(event.payload);
  if (event.requestKind === "permission") {
    const toolCall = record(payload?.toolCall);
    const toolCallId = typeof toolCall?.toolCallId === "string" && toolCall.toolCallId ? toolCall.toolCallId : undefined;
    const title = typeof toolCall?.title === "string" && toolCall.title.trim() ? toolCall.title.trim() : "Permission request";
    const toolKind = typeof toolCall?.kind === "string" && toolCall.kind ? toolCall.kind : "tool";
    return {
      requestId: event.requestId,
      kind: "permission",
      title,
      summary: toolCallId ? `${toolKind} · ${toolCallId}` : toolKind,
      status: "pending",
      ...(toolCallId ? { toolCallId } : {}),
      detail: event.payload,
    };
  }

  const message = typeof payload?.message === "string" ? payload.message : "Input requested";
  return {
    requestId: event.requestId,
    kind: "elicitation",
    title: "Elicitation",
    summary: firstLine(message, "Input requested"),
    status: "pending",
    detail: event.payload,
  };
}

/** Close a Host interaction lifecycle without retaining elicitation answer content in the trajectory. */
export function completeDesktopHostRequest(
  current: DesktopInteractionPresentation,
  value: unknown
): DesktopInteractionPresentation {
  if (value === undefined || value === null || value === "") {
    return { ...current, status: "cancelled", summary: `${current.summary} · cancelled` };
  }
  if (current.kind === "permission") {
    const payload = record(current.detail);
    const selectedId = String(value);
    const options = Array.isArray(payload?.options) ? payload.options : [];
    const selected = options.map(record).find((option) => option?.optionId === selectedId);
    const label = typeof selected?.name === "string" && selected.name.trim() ? selected.name.trim() : selectedId;
    return { ...current, status: "completed", summary: `${current.summary} · ${label}` };
  }
  return { ...current, status: "completed", summary: `${current.summary} · response submitted` };
}
