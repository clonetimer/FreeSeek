/** Agent integration wrapper for deterministic Context Planner variants. */
import type { ChatMessage } from "./provider";
import type { ToolContext } from "./tools";
import type { AgentCallbacks } from "./agent-types";
import { isContextPlannerMessage, planRepositoryContext } from "./context-planner";

type EventAppender = (type: string, data?: unknown) => unknown;
type MessagePersister = (message: ChatMessage) => { message: unknown };

/** Apply one bounded planner fragment before the first model request; failures fall back to legacy tool search. */
export function applyContextPlanner(
  messages: ChatMessage[],
  registeredToolCount: number,
  toolCtx: ToolContext,
  cb: AgentCallbacks,
  event: EventAppender,
  persistMessage: MessagePersister
): ChatMessage[] {
  const plannerMode = toolCtx.runtime?.contextPlanner ?? "off";
  if (plannerMode === "off" || registeredToolCount === 0) return messages;
  const query = [...messages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
  if (!query) return messages;
  try {
    const plan = planRepositoryContext(toolCtx.workspaceRoot, query, {
      mode: plannerMode,
      budgetTokens: toolCtx.runtime?.contextPlannerBudget ?? 3500,
    });
    const next = messages.filter((message) => !(message.role === "system" && isContextPlannerMessage(message.content)));
    const plannerMessage: ChatMessage = { role: "system", content: plan.rendered };
    next.push(plannerMessage);
    event("context/plan", {
      version: plan.version,
      variant: plan.variant,
      indexedFiles: plan.indexedFiles,
      presentation: plan.variant === "v1.2" ? "structured-evidence-v1" : "legacy",
      selectedFiles: plan.selected.map((file) => ({
        path: file.path,
        score: file.score,
        relation: file.relation,
        excerptLines: file.excerpt ? file.excerpt.split(/\r?\n/).length : 0,
      })),
      estimatedTokens: plan.estimatedTokens,
      budgetTokens: plan.budgetTokens,
      durationMs: plan.durationMs,
      repoTruncated: plan.repoTruncated,
    });
    event("system/message", { message: persistMessage(plannerMessage).message, source: `context-planner-${plan.variant}` });
    cb.onContextStatus?.(`🧭 Context Planner ${plan.variant}：从 ${plan.indexedFiles} 个文件中预取 ${plan.selected.length} 个候选（约 ${plan.estimatedTokens} tokens）`);
    return next;
  } catch (error: any) {
    event("context/plan", { version: 1, variant: plannerMode, error: String(error?.message ?? error).slice(0, 1000) });
    cb.onContextStatus?.(`⚠️ Context Planner ${plannerMode} 失败，已回退到工具检索：${String(error?.message ?? error).slice(0, 140)}`);
    return messages;
  }
}
