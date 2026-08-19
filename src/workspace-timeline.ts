/**
 * Workspace timeline：把 shadow Git checkpoint 与 durable Session Event seq 绑定。
 * 这是“代码时间线 ↔ 对话时间线”的唯一写入入口；失败由调用方决定是否 best-effort。
 */
import type { SessionEventSink } from "./eventlog";
import { createCheckpoint, linkCheckpointToEvent } from "./checkpoints";

export interface WorkspaceTimelineContext {
  workspaceRoot: string;
  checkpointDir?: string;
  eventLog?: SessionEventSink;
  eventActor?: string;
  runtime?: { autoCheckpoint?: boolean };
}

export interface CapturedWorkspaceCheckpoint {
  hash: string;
  eventSeq?: number;
}

/** 创建 shadow checkpoint，并在 EventLog/metadata 中记录其 durable seq。 */
export function captureWorkspaceCheckpoint(
  ctx: WorkspaceTimelineContext,
  label: string,
  kind: "auto" | "manual" = "auto",
  respectAutoSetting = true
): CapturedWorkspaceCheckpoint | null {
  if (respectAutoSetting && ctx.runtime?.autoCheckpoint === false) return null;
  const hash = createCheckpoint(ctx.workspaceRoot, label, ctx.checkpointDir);
  const actor = ctx.eventActor ?? "main";
  const event = ctx.eventLog?.append(
    "checkpoint",
    { hash, label, workspaceRoot: ctx.workspaceRoot, kind },
    actor
  );
  if (event && ctx.eventLog) {
    linkCheckpointToEvent(ctx.workspaceRoot, {
      hash,
      sessionId: ctx.eventLog.sessionId,
      eventSeq: event.seq,
      actor,
      kind,
    }, ctx.checkpointDir);
  }
  return { hash, ...(event ? { eventSeq: event.seq } : {}) };
}
