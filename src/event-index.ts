/**
 * Durable Session Event secondary index.
 *
 * JSONL remains the source of truth. This sidecar stores byte offsets + cheap metadata so
 * trace/eval/replay queries can skip unrelated events without reparsing the complete journal.
 * Any mismatch with the source file causes a deterministic rebuild from JSONL.
 */
import * as fs from "fs";
import * as path from "path";
import { assertSafeSessionId } from "./session-id";

export interface IndexedSessionEventShape {
  seq: number;
  ts: string;
  type: string;
  sessionId: string;
  actor?: string;
  data?: unknown;
  dataRef?: string;
}

export interface SessionEventIndexEntry {
  offset: number;
  bytes: number;
  valid: boolean;
  seq?: number;
  ts?: string;
  type?: string;
  actor?: string;
}

interface SessionEventIndexMeta {
  version: 1;
  sessionId: string;
  sourceBytes: number;
  entries: number;
  lastSeq: number;
  updatedAt: string;
}

export interface SessionEventIndexQuery {
  actor?: string;
  types?: readonly string[];
  minSeq?: number;
  maxSeq?: number;
  limit?: number;
  reverse?: boolean;
}

function indexDir(dir: string): string {
  return path.join(dir, "event-index");
}

function indexPath(dir: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(indexDir(dir), `events-${sessionId}.idx.jsonl`);
}

function metaPath(dir: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(indexDir(dir), `events-${sessionId}.meta.json`);
}

function sourcePath(dir: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(dir, `events-${sessionId}.jsonl`);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  fs.renameSync(tmp, filePath);
}

function parseIndexEntries(filePath: string): SessionEventIndexEntry[] | null {
  try {
    if (!fs.existsSync(filePath)) return [];
    const out: SessionEventIndexEntry[] = [];
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as SessionEventIndexEntry;
      if (!Number.isInteger(row.offset) || row.offset < 0 || !Number.isInteger(row.bytes) || row.bytes < 1) return null;
      if (typeof row.valid !== "boolean") return null;
      out.push(row);
    }
    return out;
  } catch {
    return null;
  }
}

function readMeta(dir: string, sessionId: string): SessionEventIndexMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(dir, sessionId), "utf8")) as SessionEventIndexMeta;
    if (parsed.version !== 1 || parsed.sessionId !== sessionId || !Number.isInteger(parsed.sourceBytes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeIndexFiles(
  dir: string,
  sessionId: string,
  entries: readonly SessionEventIndexEntry[],
  sourceBytes: number,
  lastSeq: number
): void {
  const root = indexDir(dir);
  fs.mkdirSync(root, { recursive: true });
  const target = indexPath(dir, sessionId);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, entries.map((row) => JSON.stringify(row)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, target);
  atomicWriteJson(metaPath(dir, sessionId), {
    version: 1,
    sessionId,
    sourceBytes,
    entries: entries.length,
    lastSeq,
    updatedAt: new Date().toISOString(),
  } satisfies SessionEventIndexMeta);
}

/** Rebuild the byte-offset index from the authoritative event JSONL. */
export function rebuildSessionEventIndex(dir: string, sessionId: string): SessionEventIndexEntry[] {
  assertSafeSessionId(sessionId);
  const source = sourcePath(dir, sessionId);
  const raw = fs.existsSync(source) ? fs.readFileSync(source) : Buffer.alloc(0);
  const entries: SessionEventIndexEntry[] = [];
  let offset = 0;
  let lastSeq = 0;
  while (offset < raw.length) {
    const nl = raw.indexOf(0x0a, offset);
    const end = nl >= 0 ? nl + 1 : raw.length;
    const bytes = end - offset;
    const text = raw.subarray(offset, nl >= 0 ? nl : end).toString("utf8").trim();
    let row: SessionEventIndexEntry = { offset, bytes, valid: false };
    if (text) {
      try {
        const event = JSON.parse(text) as IndexedSessionEventShape;
        if (event.sessionId === sessionId && Number.isInteger(event.seq) && event.seq > 0 && typeof event.type === "string") {
          row = {
            offset,
            bytes,
            valid: true,
            seq: event.seq,
            ts: typeof event.ts === "string" ? event.ts : undefined,
            type: event.type,
            actor: event.actor ?? "main",
          };
          lastSeq = Math.max(lastSeq, event.seq);
        }
      } catch {
        // Keep an invalid coverage entry so the meta can still describe the whole source file.
      }
    }
    entries.push(row);
    offset = end;
  }
  writeIndexFiles(dir, sessionId, entries, raw.length, lastSeq);
  return entries;
}

/** Ensure the sidecar exactly covers the current source JSONL; otherwise rebuild it. */
export function ensureSessionEventIndex(dir: string, sessionId: string): SessionEventIndexEntry[] {
  assertSafeSessionId(sessionId);
  const source = sourcePath(dir, sessionId);
  const sourceBytes = fs.existsSync(source) ? fs.statSync(source).size : 0;
  const meta = readMeta(dir, sessionId);
  const entries = parseIndexEntries(indexPath(dir, sessionId));
  if (!meta || entries === null || meta.sourceBytes !== sourceBytes || meta.entries !== entries.length) {
    return rebuildSessionEventIndex(dir, sessionId);
  }
  if (entries.length) {
    const last = entries[entries.length - 1];
    if (last.offset + last.bytes !== sourceBytes) return rebuildSessionEventIndex(dir, sessionId);
  } else if (sourceBytes !== 0) {
    return rebuildSessionEventIndex(dir, sessionId);
  }
  return entries;
}

/** Best-effort append after the authoritative event line has already been persisted. */
export function appendSessionEventIndex(
  dir: string,
  sessionId: string,
  event: IndexedSessionEventShape,
  offset: number,
  bytes: number,
  sourceBytes: number
): void {
  try {
    assertSafeSessionId(sessionId);
    const root = indexDir(dir);
    fs.mkdirSync(root, { recursive: true });
    const previous = readMeta(dir, sessionId);
    if ((previous?.sourceBytes ?? 0) !== offset) {
      rebuildSessionEventIndex(dir, sessionId);
      return;
    }
    fs.appendFileSync(indexPath(dir, sessionId), JSON.stringify({
      offset,
      bytes,
      valid: true,
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      actor: event.actor ?? "main",
    } satisfies SessionEventIndexEntry) + "\n", "utf8");
    atomicWriteJson(metaPath(dir, sessionId), {
      version: 1,
      sessionId,
      sourceBytes,
      entries: (previous?.entries ?? 0) + 1,
      lastSeq: Math.max(previous?.lastSeq ?? 0, event.seq),
      updatedAt: new Date().toISOString(),
    } satisfies SessionEventIndexMeta);
  } catch {
    // Index is disposable. The next query deterministically rebuilds from JSONL.
  }
}

/** Read selected raw events by byte offset. Source JSONL remains authoritative. */
export function queryIndexedSessionEvents(
  dir: string,
  sessionId: string,
  query: SessionEventIndexQuery = {}
): IndexedSessionEventShape[] {
  assertSafeSessionId(sessionId);
  const entries = ensureSessionEventIndex(dir, sessionId).filter((row) => row.valid);
  const typeSet = query.types?.length ? new Set(query.types) : null;
  const actor = query.actor;
  const ordered = query.reverse ? [...entries].reverse() : entries;
  const selected = ordered.filter((row) => {
    if (query.minSeq !== undefined && (row.seq ?? 0) < query.minSeq) return false;
    if (query.maxSeq !== undefined && (row.seq ?? Number.MAX_SAFE_INTEGER) > query.maxSeq) return false;
    if (actor !== undefined && (row.actor ?? "main") !== actor) return false;
    if (typeSet && (!row.type || !typeSet.has(row.type))) return false;
    return true;
  });
  const limited = query.limit && query.limit > 0 ? selected.slice(0, query.limit) : selected;
  const source = sourcePath(dir, sessionId);
  if (!limited.length || !fs.existsSync(source)) return [];
  const fd = fs.openSync(source, "r");
  try {
    const out: IndexedSessionEventShape[] = [];
    for (const row of limited) {
      const buffer = Buffer.alloc(row.bytes);
      const read = fs.readSync(fd, buffer, 0, row.bytes, row.offset);
      if (read !== row.bytes) continue;
      const text = buffer.toString("utf8").trim();
      try {
        const event = JSON.parse(text) as IndexedSessionEventShape;
        if (event.sessionId === sessionId && event.seq === row.seq) out.push(event);
      } catch {
        // A concurrently damaged source will cause a rebuild on the next query.
      }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Delete all index sidecars for one durable session. */
export function deleteSessionEventIndex(dir: string, sessionId: string): void {
  assertSafeSessionId(sessionId);
  try { fs.rmSync(indexPath(dir, sessionId), { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(metaPath(dir, sessionId), { force: true }); } catch { /* best-effort */ }
}
