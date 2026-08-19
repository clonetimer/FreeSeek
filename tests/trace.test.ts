import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionEventLog } from "../src/eventlog";
import { diffSessionTrace, loadSessionTrace } from "../src/trace";

test("Trace 从 indexed events 汇总 latency/token/tool/approval 指标", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-trace-"));
  try {
    const log = new SessionEventLog("trace", dir);
    log.append("turn/start", { turnId: "t1", messageCount: 1, startedAt: 100 }, "main");
    log.append("model/result", { turnId: "t1", step: 1, attempt: 1, provider: "p", model: "m", durationMs: 40, promptTokens: 10, completionTokens: 3, totalTokens: 13, finishReason: "tool_calls" }, "main");
    log.append("tool/call", { callId: "c", name: "write_file", args: {} }, "main");
    log.append("approval/request", { callId: "c", name: "write_file", category: "tool" }, "main");
    log.append("approval/result", { callId: "c", name: "write_file", category: "tool", allow: true }, "main");
    log.append("context/plan", { selectedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }], estimatedTokens: 320, durationMs: 7 }, "main");
    log.append("tool/result", { callId: "c", name: "write_file", result: "ok", durationMs: 12 }, "main");
    log.append("step/end", { turnId: "t1", step: 1, toolCalls: 1 }, "main");
    log.append("checkpoint", { hash: "a".repeat(40), label: "cp", workspaceRoot: "/tmp", kind: "auto" }, "main");
    log.append("turn/end", { turnId: "t1", reason: "completed", steps: 1, endedAt: 180 }, "main");
    // subagent must not contaminate main metrics
    log.append("tool/call", { callId: "sub", name: "grep", args: {} }, "main/sub:x");

    const trace = loadSessionTrace(dir, "trace");
    assert.equal(trace.durationMs, 80);
    assert.equal(trace.steps, 1);
    assert.equal(trace.modelRequests, 1);
    assert.equal(trace.totalTokens, 13);
    assert.equal(trace.toolCalls, 1);
    assert.equal(trace.toolUsage.write_file.totalDurationMs, 12);
    assert.equal(trace.approvalsAllowed, 1);
    assert.equal(trace.contextPlans, 1);
    assert.equal(trace.contextFilesSelected, 2);
    assert.equal(trace.contextPlanTokens, 320);
    assert.equal(trace.contextPlanDurationMs, 7);
    assert.equal(trace.checkpoints, 1);
    assert.equal(trace.finalReason, "completed");

    const delta = diffSessionTrace(trace, { ...trace, durationMs: 60, steps: 0, totalTokens: 8, promptTokens: 6, completionTokens: 2, toolCalls: 0 });
    assert.equal(delta.durationMs, -20);
    assert.equal(delta.steps, -1);
    assert.equal(delta.totalTokens, -5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("Trace 关联 Context Plan 与后续搜索/read/mutation 使用方式", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-trace-context-use-"));
  try {
    const log = new SessionEventLog("ctx-use", dir);
    log.append("turn/start", { startedAt: 10 }, "main");
    log.append("context/plan", {
      variant: "v1.2",
      selectedFiles: [{ path: "src/target.ts" }, { path: "src/dep.ts" }],
      estimatedTokens: 500,
    }, "main");
    log.append("tool/call", { callId: "g", name: "grep", args: { pattern: "answer" } }, "main");
    log.append("tool/call", { callId: "r1", name: "read_file", args: { path: "src/target.ts" } }, "main");
    log.append("tool/call", { callId: "r2", name: "read_file", args: { path: "/tmp/work/src/other.ts" } }, "main");
    log.append("tool/call", { callId: "e1", name: "edit_file", args: { path: "/tmp/work/src/target.ts" } }, "main");
    log.append("tool/call", { callId: "w1", name: "write_file", args: { path: "src/new.ts" } }, "main");
    log.append("turn/end", { reason: "completed", endedAt: 20 }, "main");

    const trace = loadSessionTrace(dir, "ctx-use");
    assert.equal(trace.contextExploratorySearchCalls, 1);
    assert.equal(trace.contextPlannedReadCalls, 1);
    assert.equal(trace.contextUnplannedReadCalls, 1);
    assert.equal(trace.contextPlannedMutationCalls, 1);
    assert.equal(trace.contextUnplannedMutationCalls, 1);
    assert.equal(trace.contextTopCandidateTouches, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
