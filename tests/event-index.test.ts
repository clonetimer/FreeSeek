import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionEventLog, deleteSessionEventLog, querySessionEvents } from "../src/eventlog";
import { ensureSessionEventIndex } from "../src/event-index";

test("Event index 按 type/actor/seq seek，索引损坏或 source 变更时自动重建", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-event-index-"));
  try {
    const log = new SessionEventLog("idx", dir);
    log.append("turn/start", { turnId: "t", messageCount: 1, startedAt: 10 }, "main");
    const call = log.append("tool/call", { callId: "c1", name: "read_file", args: { path: "a" } }, "main")!;
    log.append("tool/result", { callId: "c1", name: "read_file", result: "ok", durationMs: 7 }, "main");
    log.append("assistant/message", { message: { role: "assistant", content: "sub" } }, "main/sub:x");

    const selected = querySessionEvents(dir, "idx", { actor: "main", types: ["tool/call", "tool/result"], minSeq: call.seq });
    assert.deepEqual(selected.map((e) => e.type), ["tool/call", "tool/result"]);
    assert.equal(fs.existsSync(path.join(dir, "event-index", "events-idx.idx.jsonl")), true);

    // Corrupt disposable index: indexed query must rebuild from authoritative JSONL.
    fs.writeFileSync(path.join(dir, "event-index", "events-idx.idx.jsonl"), "{broken\n", "utf8");
    const rebuilt = querySessionEvents(dir, "idx", { types: ["tool/result"] });
    assert.equal(rebuilt.length, 1);
    assert.equal((rebuilt[0].data as any).durationMs, 7);
    assert.ok(ensureSessionEventIndex(dir, "idx").length >= 4);

    // Source tail changed without index update: meta byte mismatch triggers deterministic rebuild.
    const source = path.join(dir, "events-idx.jsonl");
    const seq = log.lastSeq + 1;
    fs.appendFileSync(source, JSON.stringify({ seq, ts: new Date().toISOString(), type: "compact", sessionId: "idx", actor: "main", data: { x: 1 } }) + "\n");
    assert.equal(querySessionEvents(dir, "idx", { types: ["compact"] }).length, 1);

    deleteSessionEventLog(dir, "idx");
    assert.equal(fs.existsSync(path.join(dir, "event-index", "events-idx.idx.jsonl")), false);
    assert.equal(fs.existsSync(path.join(dir, "event-index", "events-idx.meta.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
