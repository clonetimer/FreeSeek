/** Evidence emitted only after a FreeSeek file tool has actually completed its read/mutation body. */
export type AcpFileEvidenceKind = "read" | "create" | "write" | "edit" | "delete";

export interface AcpFileEvidence {
  callId: string;
  evidenceId: string;
  file: string;
  path: string;
  kind: AcpFileEvidenceKind;
  added?: number;
  removed?: number;
  original?: string;
  applied?: string;
  deliverable: boolean;
}

export interface AcpFileMutationInfo {
  id: string;
  file: string;
  path: string;
  kind: "create" | "write" | "edit" | "delete";
  added: number;
  removed: number;
  original: string;
  applied: string;
}

interface AcpToolEvidenceMetaRow {
  id: string;
  kind: AcpFileEvidenceKind;
  file: string;
  path: string;
  deliverable: boolean;
  diffAvailable: boolean;
  added?: number;
  removed?: number;
}

export interface AcpToolEvidenceProjection {
  content: Array<Record<string, unknown>>;
  locations: Array<{ path: string }>;
  _meta: {
    freesek: {
      fileEvidenceVersion: 1;
      fileEvidence: AcpToolEvidenceMetaRow[];
    };
  };
}

/** Create read evidence. The index only disambiguates repeated reads within one tool call. */
export function createAcpReadEvidence(callId: string, file: string, filePath: string, index = 0): AcpFileEvidence {
  return {
    callId,
    evidenceId: `read:${callId}:${index}`,
    file,
    path: filePath,
    kind: "read",
    deliverable: false,
  };
}

/** Preserve the mutation facts produced by write_file/edit_file/delete_file without parsing tool-result text. */
export function createAcpMutationEvidence(callId: string, info: AcpFileMutationInfo): AcpFileEvidence {
  return {
    callId,
    evidenceId: info.id,
    file: info.file,
    path: info.path,
    kind: info.kind,
    // delete_file cannot currently prove complete line-change counts for arbitrary targets.
    ...(info.kind === "delete" ? {} : { added: info.added, removed: info.removed }),
    original: info.original,
    applied: info.applied,
    // A newly created file is the only mutation the current tool contract can prove is a produced file.
    deliverable: info.kind === "create",
  };
}

function hasStructuredDiff(row: AcpFileEvidence): boolean {
  // delete_file currently does not retain a complete pre-delete snapshot, so it must not fabricate a diff.
  return row.kind === "create" || row.kind === "write" || row.kind === "edit";
}

/**
 * Project FreeSeek evidence onto ACP v1 standard tool-call fields:
 * - locations: files actually read or mutated;
 * - diff content: old/new text emitted by successful mutation tools;
 * - _meta: namespaced provenance/kind/stats needed by the Desktop evidence UI.
 */
export function projectAcpFileEvidence(rows: readonly AcpFileEvidence[]): AcpToolEvidenceProjection | undefined {
  if (!rows.length) return undefined;
  const locations: Array<{ path: string }> = [];
  const locationPaths = new Set<string>();
  const content: Array<Record<string, unknown>> = [];
  const fileEvidence: AcpToolEvidenceMetaRow[] = [];

  for (const row of rows) {
    if (!locationPaths.has(row.path)) {
      locationPaths.add(row.path);
      locations.push({ path: row.path });
    }
    const diffAvailable = hasStructuredDiff(row) && typeof row.original === "string" && typeof row.applied === "string";
    if (diffAvailable) {
      content.push({
        type: "diff",
        path: row.path,
        oldText: row.kind === "create" ? null : row.original,
        newText: row.applied,
      });
    }
    fileEvidence.push({
      id: row.evidenceId,
      kind: row.kind,
      file: row.file,
      path: row.path,
      deliverable: row.deliverable,
      diffAvailable,
      ...(row.added === undefined ? {} : { added: row.added }),
      ...(row.removed === undefined ? {} : { removed: row.removed }),
    });
  }

  return {
    content,
    locations,
    _meta: { freesek: { fileEvidenceVersion: 1, fileEvidence } },
  };
}

/** Group durable evidence events for ACP history replay. Invalid/legacy rows fail closed. */
export function groupAcpFileEvidenceByCall(rows: readonly unknown[]): Map<string, AcpFileEvidence[]> {
  const out = new Map<string, AcpFileEvidence[]>();
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Partial<AcpFileEvidence>;
    if (typeof row.callId !== "string" || !row.callId || typeof row.evidenceId !== "string" || !row.evidenceId) continue;
    if (typeof row.file !== "string" || typeof row.path !== "string") continue;
    if (!["read", "create", "write", "edit", "delete"].includes(String(row.kind))) continue;
    const evidence: AcpFileEvidence = {
      callId: row.callId,
      evidenceId: row.evidenceId,
      file: row.file,
      path: row.path,
      kind: row.kind as AcpFileEvidenceKind,
      deliverable: row.deliverable === true,
      ...(typeof row.added === "number" ? { added: row.added } : {}),
      ...(typeof row.removed === "number" ? { removed: row.removed } : {}),
      ...(typeof row.original === "string" ? { original: row.original } : {}),
      ...(typeof row.applied === "string" ? { applied: row.applied } : {}),
    };
    const group = out.get(evidence.callId) ?? [];
    group.push(evidence);
    out.set(evidence.callId, group);
  }
  return out;
}
