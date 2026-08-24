import type { ChatMessage, ToolCall } from "../../provider";
import { projectAcpFileEvidence, type AcpFileEvidence } from "./file-evidence";

/** Map FreeSeek tool names onto ACP's coarse presentation kinds. */
export function acpToolKind(name: string): "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other" {
  if (/^(read_file|list_directory)$/.test(name)) return "read";
  if (/^(write_file|edit_file)$/.test(name)) return "edit";
  if (name === "delete_file") return "delete";
  if (/^(grep|glob|search_files|mcp_kb_search)/.test(name)) return "search";
  if (/^(run_command|run_code|run_python|verify)$/.test(name)) return "execute";
  if (/^(web_search|web_fetch|browser|mcp__|mcp_read_resource)/.test(name)) return "fetch";
  if (/^(goal|goal_view|todo_|spawn_|send_message)/.test(name)) return "think";
  return "other";
}

/** Parse a persisted tool-call argument payload for ACP presentation without executing it. */
export function acpToolArgs(call: ToolCall): unknown {
  try { return call.function.arguments ? JSON.parse(call.function.arguments) : {}; }
  catch { return { raw: call.function.arguments }; }
}

/** Classify the stable text result format used by the Kernel as failed/completed for ACP cards. */
export function acpToolResultFailed(result: string): boolean {
  return /^\s*(⛔|工具执行出错|⚠️ MCP 工具 .*调用失败)/.test(result);
}

/** Build one final ACP v1 tool_call_update payload with standard file evidence fields when available. */
export function acpToolResultFields(result: string, evidence: readonly AcpFileEvidence[] = []): Record<string, unknown> {
  const projected = projectAcpFileEvidence(evidence);
  return {
    rawOutput: result,
    content: [
      { type: "content", content: { type: "text", text: result } },
      ...(projected?.content ?? []),
    ],
    ...(projected?.locations.length ? { locations: projected.locations } : {}),
    ...(projected ? { _meta: projected._meta } : {}),
  };
}

/** Project recovered Kernel messages back into ACP session/update notifications. */
export function replayAcpHistory(
  sessionId: string,
  messages: readonly ChatMessage[],
  currentModeId: string,
  update: (sessionId: string, payload: Record<string, unknown>) => void,
  fileEvidenceByToolCall: ReadonlyMap<string, readonly AcpFileEvidence[]> = new Map()
): void {
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      if (message.content) update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: message.content } });
      continue;
    }
    if (message.role === "assistant") {
      if (message.reasoning_content) {
        update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: message.reasoning_content } });
      }
      if (message.content) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.content } });
      for (const call of message.tool_calls ?? []) {
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: call.id,
          title: call.function.name,
          kind: acpToolKind(call.function.name),
          status: "in_progress",
          rawInput: acpToolArgs(call),
        });
      }
      continue;
    }
    if (message.role === "tool" && message.tool_call_id) {
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: message.tool_call_id,
        status: acpToolResultFailed(message.content) ? "failed" : "completed",
        ...acpToolResultFields(message.content, fileEvidenceByToolCall.get(message.tool_call_id) ?? []),
      });
    }
  }
  update(sessionId, { sessionUpdate: "current_mode_update", currentModeId });
}
