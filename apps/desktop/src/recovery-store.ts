import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopRecoveryState } from "./contracts";

/** Minimal crash-recovery journal for one interrupted Desktop prompt. */
export class DesktopRecoveryStore {
  constructor(readonly file: string) {}

  /** Mark an Agent turn as in-flight before IPC enters ACP. */
  begin(sessionId: string, workspace: string): DesktopRecoveryState {
    const state: DesktopRecoveryState = { sessionId, workspace, updatedAt: new Date().toISOString(), inFlight: true };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.file);
    return state;
  }

  /** Return a valid interrupted-turn marker; stale/corrupt records are ignored. */
  read(maxAgeMs = 7 * 24 * 60 * 60_000): DesktopRecoveryState | null {
    try {
      const row = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<DesktopRecoveryState>;
      const updated = Date.parse(String(row.updatedAt ?? ""));
      if (row.inFlight !== true || typeof row.sessionId !== "string" || !row.sessionId || typeof row.workspace !== "string" || !path.isAbsolute(row.workspace)) return null;
      if (!Number.isFinite(updated) || Date.now() - updated > maxAgeMs) return null;
      return { sessionId: row.sessionId, workspace: row.workspace, updatedAt: new Date(updated).toISOString(), inFlight: true };
    } catch { return null; }
  }

  /** Clear after a turn settles, session closes, or the user dismisses recovery. */
  clear(): void { fs.rmSync(this.file, { force: true }); }
}
