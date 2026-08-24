import { querySessionEvents, type SessionEventSink } from "../../eventlog";
import {
  createAcpMutationEvidence,
  createAcpReadEvidence,
  groupAcpFileEvidenceByCall,
  type AcpFileEvidence,
  type AcpFileMutationInfo,
} from "./file-evidence";

/** Per-prompt collector that persists successful file facts and correlates them by provider toolCallId. */
export function createAcpFileEvidenceCollector(log: SessionEventSink) {
  const byToolCall = new Map<string, AcpFileEvidence[]>();
  const record = (evidence: AcpFileEvidence): void => {
    const rows = byToolCall.get(evidence.callId) ?? [];
    rows.push(evidence);
    byToolCall.set(evidence.callId, rows);
    log.append("presentation/file_evidence", evidence, "main");
  };
  return {
    onFileRead(file: string, filePath: string, callId?: string): void {
      if (!callId) return;
      record(createAcpReadEvidence(callId, file, filePath, byToolCall.get(callId)?.length ?? 0));
    },
    onFileDiff(info: AcpFileMutationInfo, callId?: string): void {
      if (callId) record(createAcpMutationEvidence(callId, info));
    },
    take(callId: string): AcpFileEvidence[] {
      const rows = byToolCall.get(callId) ?? [];
      byToolCall.delete(callId);
      return rows;
    },
  };
}

/** Recover only durable U4 evidence events; old sessions simply return an empty map. */
export function loadPersistedAcpFileEvidence(eventsDir: string, sessionId: string): Map<string, AcpFileEvidence[]> {
  const events = querySessionEvents(eventsDir, sessionId, { actor: "main", types: ["presentation/file_evidence"] });
  return groupAcpFileEvidenceByCall(events.map((event) => event.data));
}
