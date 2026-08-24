/** ACP session/update kinds currently projected by the Desktop presentation layer. */
export type DesktopPresentationKind = "user" | "assistant" | "reasoning" | "tool" | "mode" | "unknown";

/** Coarse ACP tool kinds rendered with specialized Desktop cards. */
export type DesktopPresentationToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

/** Normalized renderer-safe presentation event. It contains no direct Kernel/EventLog handles. */
export type DesktopPresentationUpdate =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; phase: "start"; toolCallId: string; title: string; toolKind: DesktopPresentationToolKind; status: string; rawInput?: unknown }
  | { kind: "tool"; phase: "update"; toolCallId: string; status: string; rawOutput?: unknown; content?: unknown; locations?: unknown; meta?: unknown }
  | { kind: "mode"; modeId: string }
  | { kind: "unknown"; sessionUpdate: string; raw: Record<string, unknown> };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textContent(value: unknown): string {
  const content = record(value);
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
}

function toolKind(value: unknown): DesktopPresentationToolKind {
  return value === "read" || value === "edit" || value === "delete" || value === "move" || value === "search"
    || value === "execute" || value === "think" || value === "fetch" || value === "other" ? value : "other";
}

/**
 * Project one ACP session/update notification into the Desktop presentation contract.
 * The renderer must consume this projection instead of reaching into EventLog/ToolRuntime/workspace state.
 */
export function projectDesktopSessionUpdate(payload: unknown): DesktopPresentationUpdate | undefined {
  const envelope = record(payload);
  const update = record(envelope?.update) ?? envelope;
  if (!update) return undefined;
  const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

  if (sessionUpdate === "user_message_chunk" || sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") {
    const kind = sessionUpdate === "user_message_chunk" ? "user" : sessionUpdate === "agent_message_chunk" ? "assistant" : "reasoning";
    return { kind, text: textContent(update.content) };
  }
  if (sessionUpdate === "tool_call") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : "unknown-tool-call";
    return {
      kind: "tool",
      phase: "start",
      toolCallId,
      title: typeof update.title === "string" && update.title ? update.title : "tool",
      toolKind: toolKind(update.kind),
      status: typeof update.status === "string" && update.status ? update.status : "in_progress",
      ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
    };
  }
  if (sessionUpdate === "tool_call_update") {
    return {
      kind: "tool",
      phase: "update",
      toolCallId: typeof update.toolCallId === "string" ? update.toolCallId : "",
      status: typeof update.status === "string" && update.status ? update.status : "completed",
      ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
      ...(update.content === undefined ? {} : { content: update.content }),
      ...(update.locations === undefined ? {} : { locations: update.locations }),
      ...(update._meta === undefined ? {} : { meta: update._meta }),
    };
  }
  if (sessionUpdate === "current_mode_update") {
    return { kind: "mode", modeId: typeof update.currentModeId === "string" ? update.currentModeId : "" };
  }
  return { kind: "unknown", sessionUpdate: sessionUpdate || "unknown", raw: update };
}

/** Stable human-facing label for a coarse ACP tool kind. */
export function toolKindLabel(kind: DesktopPresentationToolKind): string {
  const labels: Record<DesktopPresentationToolKind, string> = {
    read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search",
    execute: "Execute", think: "Reason", fetch: "Fetch", other: "Tool",
  };
  return labels[kind];
}
