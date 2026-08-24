import type { DesktopPresentationToolKind } from "./presentation";

export type DesktopArtifactEvidenceKind = "read" | "create" | "write" | "edit" | "delete" | "change";

export interface DesktopArtifactDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/** Renderer-safe file evidence derived only from ACP tool_call_update fields. */
export interface DesktopArtifactEvidence {
  id: string;
  toolCallId: string;
  kind: DesktopArtifactEvidenceKind;
  file: string;
  path: string;
  deliverable: boolean;
  diffAvailable: boolean;
  added?: number;
  removed?: number;
  diff?: DesktopArtifactDiff;
}

export interface DesktopArtifactGroup {
  path: string;
  file: string;
  evidence: DesktopArtifactEvidence[];
  mutationCount: number;
  referenceCount: number;
  deliverable: boolean;
}

export interface DesktopArtifactEvidenceSource {
  toolCallId: string;
  content?: unknown;
  locations?: unknown;
  meta?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function evidenceKind(value: unknown): DesktopArtifactEvidenceKind | undefined {
  return value === "read" || value === "create" || value === "write" || value === "edit" || value === "delete" || value === "change"
    ? value
    : undefined;
}

function displayFile(file: unknown, path: string): string {
  if (typeof file === "string" && file.trim()) return file.trim();
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function structuredDiffs(content: unknown): DesktopArtifactDiff[] {
  if (!Array.isArray(content)) return [];
  const out: DesktopArtifactDiff[] = [];
  for (const value of content) {
    const row = record(value);
    if (row?.type !== "diff" || typeof row.path !== "string" || typeof row.newText !== "string") continue;
    if (row.oldText !== null && typeof row.oldText !== "string") continue;
    out.push({ path: row.path, oldText: row.oldText as string | null, newText: row.newText });
  }
  return out;
}

function standardLocations(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  const out: string[] = [];
  for (const value of locations) {
    const row = record(value);
    if (typeof row?.path === "string" && row.path && !out.includes(row.path)) out.push(row.path);
  }
  return out;
}

/**
 * Parse standard ACP locations/diffs plus FreeSeek namespaced provenance metadata.
 * No filesystem lookup or raw tool-result text parsing is permitted here.
 */
export function projectDesktopArtifactEvidence(
  source: DesktopArtifactEvidenceSource,
  toolKind: DesktopPresentationToolKind = "other"
): DesktopArtifactEvidence[] {
  const diffs = structuredDiffs(source.content);
  const diffByPath = new Map<string, DesktopArtifactDiff[]>();
  for (const diff of diffs) {
    const rows = diffByPath.get(diff.path) ?? [];
    rows.push(diff);
    diffByPath.set(diff.path, rows);
  }

  const meta = record(source.meta);
  const freesek = record(meta?.freesek);
  const metaRows = freesek?.fileEvidenceVersion === 1 && Array.isArray(freesek.fileEvidence)
    ? freesek.fileEvidence
    : [];
  const out: DesktopArtifactEvidence[] = [];

  for (let index = 0; index < metaRows.length; index++) {
    const row = record(metaRows[index]);
    if (!row || typeof row.path !== "string" || !row.path) continue;
    const kind = evidenceKind(row.kind);
    if (!kind || kind === "change") continue;
    const candidates = diffByPath.get(row.path) ?? [];
    const diff = row.diffAvailable === true ? candidates.shift() : undefined;
    const id = typeof row.id === "string" && row.id ? row.id : `${kind}:${source.toolCallId}:${index}`;
    out.push({
      id,
      toolCallId: source.toolCallId,
      kind,
      file: displayFile(row.file, row.path),
      path: row.path,
      deliverable: row.deliverable === true,
      diffAvailable: !!diff,
      ...(typeof row.added === "number" ? { added: row.added } : {}),
      ...(typeof row.removed === "number" ? { removed: row.removed } : {}),
      ...(diff ? { diff } : {}),
    });
  }

  // Standard ACP diff content remains useful even without FreeSeek metadata. Preserve it as a
  // generic change rather than guessing create/write/edit semantics or deliverable status.
  let genericIndex = 0;
  for (const [path, rows] of diffByPath) {
    for (const diff of rows) {
      out.push({
        id: `diff:${source.toolCallId}:${genericIndex++}`,
        toolCallId: source.toolCallId,
        kind: "change",
        file: displayFile(undefined, path),
        path,
        deliverable: false,
        diffAvailable: true,
        diff,
      });
    }
  }

  // A standard ACP location on a read tool is evidence of an accessed file even if the sender
  // does not provide FreeSeek metadata. Do not reinterpret locations from mutation/other tools.
  if (toolKind === "read") {
    const represented = new Set(out.map((row) => row.path));
    for (const path of standardLocations(source.locations)) {
      if (represented.has(path)) continue;
      out.push({
        id: `read:${source.toolCallId}:${out.length}`,
        toolCallId: source.toolCallId,
        kind: "read",
        file: displayFile(undefined, path),
        path,
        deliverable: false,
        diffAvailable: false,
      });
    }
  }

  return out;
}

/** Merge repeated ACP tool updates without duplicating the same evidence row. */
export function mergeDesktopArtifactEvidence(
  previous: readonly DesktopArtifactEvidence[] = [],
  incoming: readonly DesktopArtifactEvidence[] = []
): DesktopArtifactEvidence[] {
  const out = new Map<string, DesktopArtifactEvidence>();
  for (const row of [...previous, ...incoming]) out.set(`${row.toolCallId}\u0000${row.id}`, row);
  return [...out.values()];
}

/** Group references/mutations by canonical projected path for the Artifact pane. */
export function groupDesktopArtifactEvidence(rows: readonly DesktopArtifactEvidence[]): DesktopArtifactGroup[] {
  const groups = new Map<string, DesktopArtifactGroup>();
  for (const row of rows) {
    const current = groups.get(row.path) ?? {
      path: row.path,
      file: row.file,
      evidence: [],
      mutationCount: 0,
      referenceCount: 0,
      deliverable: false,
    };
    current.evidence.push(row);
    if (row.kind === "read") current.referenceCount++;
    else current.mutationCount++;
    if (row.deliverable) current.deliverable = true;
    current.file = row.file || current.file;
    groups.set(row.path, current);
  }
  return [...groups.values()];
}
