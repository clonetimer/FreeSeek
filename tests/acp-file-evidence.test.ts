import assert from "node:assert/strict";
import test from "node:test";
import {
  createAcpMutationEvidence,
  createAcpReadEvidence,
  groupAcpFileEvidenceByCall,
  projectAcpFileEvidence,
} from "../src/hosts/acp/file-evidence";
import { acpToolResultFields, replayAcpHistory } from "../src/hosts/acp/presentation";

test("ACP U4 projects successful read/mutation facts onto standard locations and diff content", () => {
  const read = createAcpReadEvidence("call-1", "src/a.ts", "/workspace/src/a.ts");
  const edit = createAcpMutationEvidence("call-2", {
    id: "ed-1",
    file: "src/a.ts",
    path: "/workspace/src/a.ts",
    kind: "edit",
    added: 1,
    removed: 1,
    original: "const a = 1;\n",
    applied: "const a = 2;\n",
  });
  const projected = projectAcpFileEvidence([read, edit])!;
  assert.deepEqual(projected.locations, [{ path: "/workspace/src/a.ts" }]);
  assert.deepEqual(projected.content, [{
    type: "diff",
    path: "/workspace/src/a.ts",
    oldText: "const a = 1;\n",
    newText: "const a = 2;\n",
  }]);
  assert.equal(projected._meta.freesek.fileEvidence[0].kind, "read");
  assert.equal(projected._meta.freesek.fileEvidence[1].diffAvailable, true);
  assert.equal(projected._meta.freesek.fileEvidence[1].deliverable, false);
});

test("ACP U4 marks only proven creates as deliverables and never invents delete diffs", () => {
  const created = createAcpMutationEvidence("call-create", {
    id: "ed-create", file: "report.md", path: "/workspace/report.md", kind: "create",
    added: 2, removed: 0, original: "", applied: "# Report\nDone\n",
  });
  const deleted = createAcpMutationEvidence("call-delete", {
    id: "ed-delete", file: "old.txt", path: "/workspace/old.txt", kind: "delete",
    added: 0, removed: 0, original: "", applied: "",
  });
  const projected = projectAcpFileEvidence([created, deleted])!;
  assert.equal(projected.content.length, 1);
  assert.equal(projected.content[0].oldText, null);
  assert.equal(projected._meta.freesek.fileEvidence[0].deliverable, true);
  assert.equal(projected._meta.freesek.fileEvidence[1].diffAvailable, false);
  assert.equal(projected._meta.freesek.fileEvidence[1].deliverable, false);
  assert.equal(projected._meta.freesek.fileEvidence[1].removed, undefined, "delete stats must not claim an incomplete line count");
});

test("ACP U4 history replay restores evidence by toolCallId without parsing result text", () => {
  const evidence = createAcpReadEvidence("call-read", "src/main.ts", "/workspace/src/main.ts");
  const grouped = groupAcpFileEvidenceByCall([evidence, { bad: true }]);
  const updates: Array<Record<string, unknown>> = [];
  replayAcpHistory("session-1", [
    { role: "assistant", content: "", tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/main.ts\"}" } }] },
    { role: "tool", content: "file contents", tool_call_id: "call-read" },
  ], "coder", (_sessionId, update) => updates.push(update), grouped);
  const result = updates.find((update) => update.sessionUpdate === "tool_call_update")!;
  assert.deepEqual(result.locations, [{ path: "/workspace/src/main.ts" }]);
  assert.equal((result._meta as any).freesek.fileEvidence[0].kind, "read");
  assert.match(JSON.stringify(result.content), /file contents/);
});

test("ACP U4 tool result keeps normal text content while attaching structured evidence", () => {
  const evidence = createAcpMutationEvidence("call-3", {
    id: "ed-3", file: "a.txt", path: "/workspace/a.txt", kind: "write",
    added: 1, removed: 1, original: "a\n", applied: "b\n",
  });
  const fields = acpToolResultFields("written", [evidence]);
  const content = fields.content as Array<Record<string, unknown>>;
  assert.equal(content[0].type, "content");
  assert.equal(content[1].type, "diff");
  assert.deepEqual(fields.locations, [{ path: "/workspace/a.txt" }]);
});
