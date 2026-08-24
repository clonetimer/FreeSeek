import * as fs from "fs";
import * as path from "path";
import { assertSafeSessionId } from "../../session-id";

export interface AcpSessionMetadata {
  sessionId: string;
  cwd: string;
  title?: string;
  /** Names only: secrets/commands/env stay client-owned and are never persisted. */
  mcpServerNames?: string[];
  /** Canonical additional workspace roots authorized when the ACP session was created. */
  additionalDirectories?: string[];
  /** Persisted ACP agent mode for resume parity. */
  agentMode?: "coder" | "craft" | "plan" | "ask";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface AcpSessionListResult {
  sessions: AcpSessionMetadata[];
  nextCursor?: string;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (!Number.isInteger(value.offset) || Number(value.offset) < 0) throw new Error("invalid offset");
    return Number(value.offset);
  } catch {
    throw new Error("invalid ACP session cursor");
  }
}

/** Durable ACP session metadata; EventLog remains authoritative for conversation history. */
export class AcpSessionStore {
  private readonly metadataDir: string;

  constructor(private readonly rootDir: string) {
    this.metadataDir = path.join(rootDir, "acp-sessions");
    fs.mkdirSync(this.metadataDir, { recursive: true });
  }

  get eventsDir(): string {
    return this.rootDir;
  }

  read(sessionId: string): AcpSessionMetadata | null {
    assertSafeSessionId(sessionId);
    const file = this.fileFor(sessionId);
    if (!fs.existsSync(file)) return null;
    try {
      const row = JSON.parse(fs.readFileSync(file, "utf8")) as AcpSessionMetadata;
      if (row.sessionId !== sessionId || typeof row.cwd !== "string" || !row.createdAt || !row.updatedAt) return null;
      return row;
    } catch {
      return null;
    }
  }

  create(
    sessionId: string,
    cwd: string,
    mcpServerNames: string[] = [],
    additionalDirectories: string[] = [],
    agentMode: AcpSessionMetadata["agentMode"] = "coder"
  ): AcpSessionMetadata {
    if (this.read(sessionId)) throw new Error(`ACP session already exists: ${sessionId}`);
    const now = new Date().toISOString();
    const metadata: AcpSessionMetadata = {
      sessionId, cwd,
      ...(mcpServerNames.length ? { mcpServerNames: [...mcpServerNames].sort() } : {}),
      ...(additionalDirectories.length ? { additionalDirectories: [...additionalDirectories] } : {}),
      agentMode,
      createdAt: now, updatedAt: now,
    };
    this.write(metadata);
    return metadata;
  }

  update(sessionId: string, patch: Partial<Pick<AcpSessionMetadata, "title" | "closedAt" | "agentMode">>): AcpSessionMetadata {
    const current = this.read(sessionId);
    if (!current) throw new Error(`ACP session not found: ${sessionId}`);
    const next: AcpSessionMetadata = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    if (patch.closedAt === undefined && Object.prototype.hasOwnProperty.call(patch, "closedAt")) delete next.closedAt;
    this.write(next);
    return next;
  }

  touch(sessionId: string): AcpSessionMetadata {
    const current = this.read(sessionId);
    if (!current) throw new Error(`ACP session not found: ${sessionId}`);
    const next = { ...current, updatedAt: new Date().toISOString() };
    this.write(next);
    return next;
  }

  list(options: { cwd?: string; cursor?: string; limit?: number } = {}): AcpSessionListResult {
    const offset = decodeCursor(options.cursor);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    let rows: AcpSessionMetadata[] = [];
    try {
      for (const name of fs.readdirSync(this.metadataDir)) {
        const match = /^(.+)\.json$/.exec(name);
        if (!match) continue;
        let row: AcpSessionMetadata | null = null;
        try { row = this.read(match[1]); } catch { row = null; }
        if (row && (!options.cwd || row.cwd === options.cwd)) rows.push(row);
      }
    } catch {
      rows = [];
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      ...(nextOffset < rows.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  }

  private fileFor(sessionId: string): string {
    assertSafeSessionId(sessionId);
    return path.join(this.metadataDir, `${sessionId}.json`);
  }

  private write(metadata: AcpSessionMetadata): void {
    assertSafeSessionId(metadata.sessionId);
    fs.mkdirSync(this.metadataDir, { recursive: true });
    const file = this.fileFor(metadata.sessionId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }
}
