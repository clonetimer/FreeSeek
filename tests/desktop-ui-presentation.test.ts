import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { projectDesktopSessionUpdate, toolKindLabel } from "../apps/desktop/src/presentation";
import { groupDesktopArtifactEvidence, projectDesktopArtifactEvidence } from "../apps/desktop/src/artifact-evidence";
import { presentDesktopMessage, presentDesktopToolEvent } from "../apps/desktop/src/presentation-registry";
import { completeDesktopHostRequest, desktopTrajectorySearchText, matchesDesktopTrajectoryFilter, projectDesktopHostRequest } from "../apps/desktop/src/trajectory";

const ROOT = process.cwd();

test("Desktop presentation projects ACP text chunks without reaching into runtime state", () => {
  assert.deepEqual(projectDesktopSessionUpdate({ update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } } }), { kind: "user", text: "hello" });
  assert.deepEqual(projectDesktopSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }), { kind: "assistant", text: "answer" });
  assert.deepEqual(projectDesktopSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "inspect first" } }), { kind: "reasoning", text: "inspect first" });
});

test("Desktop presentation preserves typed ACP tool lifecycle for cards and trajectory", () => {
  assert.deepEqual(projectDesktopSessionUpdate({ update: {
    sessionUpdate: "tool_call", toolCallId: "call-1", title: "read_file", kind: "read", status: "in_progress", rawInput: { path: "src/main.ts" },
  } }), {
    kind: "tool", phase: "start", toolCallId: "call-1", title: "read_file", toolKind: "read", status: "in_progress", rawInput: { path: "src/main.ts" },
  });
  assert.deepEqual(projectDesktopSessionUpdate({ update: {
    sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "done",
  } }), { kind: "tool", phase: "update", toolCallId: "call-1", status: "completed", rawOutput: "done" });
  assert.equal(toolKindLabel("execute"), "Execute");
});

test("Desktop presentation fails soft for unknown ACP presentation updates", () => {
  assert.deepEqual(projectDesktopSessionUpdate({ sessionUpdate: "future_update", opaque: 7 }), {
    kind: "unknown", sessionUpdate: "future_update", raw: { sessionUpdate: "future_update", opaque: 7 },
  });
  assert.equal(projectDesktopSessionUpdate(null), undefined);
});


test("Desktop U2 registry derives specialized tool cards from ACP projection only", () => {
  const terminalStart = projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "term", title: "run_command", kind: "execute", status: "in_progress", rawInput: { command: "npm test", cwd: "pkg" } }) as any;
  const terminal = presentDesktopToolEvent(terminalStart);
  assert.equal(terminal.cardKind, "terminal");
  assert.equal(terminal.summary, "npm test");
  assert.equal(terminal.input?.kind, "terminal");
  const terminalDone = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "term", status: "completed", rawOutput: "all green" }) as any, terminal);
  assert.equal(terminalDone.output?.kind, "terminal");
  assert.equal(terminalDone.output?.text, "all green");

  const read = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "read", title: "read_file", kind: "read", status: "in_progress", rawInput: { path: "src/main.ts", offset: 20, limit: 40 } }) as any);
  assert.equal(read.cardKind, "read");
  assert.match(read.summary, /src\/main\.ts/);

  const search = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "search", title: "grep", kind: "search", status: "in_progress", rawInput: { pattern: "ToolRuntime", path: "src" } }) as any);
  assert.equal(search.cardKind, "search");
  assert.equal(search.summary, "ToolRuntime");

  const mutation = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "edit", title: "edit_file", kind: "edit", status: "in_progress", rawInput: { path: "src/main.ts", old_string: "a", new_string: "b" } }) as any);
  assert.equal(mutation.cardKind, "mutation");
  assert.equal(mutation.summary, "src/main.ts");
  assert.equal(mutation.output, undefined, "U2 must not invent diff evidence before ACP projects it");

  const web = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "web", title: "web_fetch", kind: "fetch", status: "in_progress", rawInput: { url: "https://example.test/doc" } }) as any);
  assert.equal(web.cardKind, "web");
  assert.equal(web.summary, "https://example.test/doc");

  const code = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "code", title: "run_python", kind: "execute", status: "in_progress", rawInput: { code: "print(1)", cwd: "analysis" } }) as any);
  assert.equal(code.cardKind, "code");
  assert.equal(code.input?.kind, "code");
  assert.equal(code.input?.language, "python");
});

test("Desktop U2 registry keeps JSON and generic fallbacks renderer-safe", () => {
  const start = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "generic", title: "future_tool", kind: "future-kind", status: "in_progress", rawInput: { alpha: 1 } }) as any);
  assert.equal(start.cardKind, "generic");
  assert.equal(start.input?.kind, "json");
  const done = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "generic", status: "completed", rawOutput: '{"ok":true}' }) as any, start);
  assert.equal(done.output?.kind, "json");
  assert.match(done.output?.text ?? "", /"ok": true/);

  const orphan = presentDesktopToolEvent(projectDesktopSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "orphan", status: "failed", rawOutput: "missing call head" }) as any);
  assert.equal(orphan.cardKind, "generic");
  assert.equal(orphan.status, "failed");
});

test("Desktop message registry exposes Markdown/reasoning intents consumed by the U5 incremental renderer", () => {
  const assistant = projectDesktopSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**answer**" } });
  const reasoning = projectDesktopSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "inspect" } });
  assert.deepEqual(presentDesktopMessage(assistant as any), { kind: "markdown", label: "Assistant", text: "**answer**" });
  assert.deepEqual(presentDesktopMessage(reasoning as any), { kind: "reasoning", label: "Reasoning", text: "inspect" });
});

test("Desktop U4 preserves ACP standard file evidence and attaches it to the shared tool presentation", () => {
  const start = presentDesktopToolEvent(projectDesktopSessionUpdate({
    sessionUpdate: "tool_call", toolCallId: "edit-u4", title: "edit_file", kind: "edit", status: "in_progress",
    rawInput: { path: "src/main.ts", old_string: "a", new_string: "b" },
  }) as any);
  const update = projectDesktopSessionUpdate({
    sessionUpdate: "tool_call_update", toolCallId: "edit-u4", status: "completed", rawOutput: "edited",
    locations: [{ path: "/workspace/src/main.ts" }],
    content: [
      { type: "content", content: { type: "text", text: "edited" } },
      { type: "diff", path: "/workspace/src/main.ts", oldText: "a\n", newText: "b\n" },
    ],
    _meta: { freesek: { fileEvidenceVersion: 1, fileEvidence: [{ id: "ed-u4", kind: "edit", file: "src/main.ts", path: "/workspace/src/main.ts", deliverable: false, diffAvailable: true, added: 1, removed: 1 }] } },
  }) as any;
  assert.deepEqual(update.locations, [{ path: "/workspace/src/main.ts" }]);
  const done = presentDesktopToolEvent(update, start);
  assert.equal(done.artifacts?.length, 1);
  assert.equal(done.artifacts?.[0].kind, "edit");
  assert.equal(done.artifacts?.[0].diff?.oldText, "a\n");
  assert.equal(done.artifacts?.[0].diff?.newText, "b\n");
  assert.equal(done.artifacts?.[0].deliverable, false);
});

test("Desktop U4 deliverables are proven creates; unproven ACP diffs remain generic changes", () => {
  const created = projectDesktopArtifactEvidence({
    toolCallId: "create-u4",
    content: [{ type: "diff", path: "/workspace/report.md", oldText: null, newText: "# report\n" }],
    locations: [{ path: "/workspace/report.md" }],
    meta: { freesek: { fileEvidenceVersion: 1, fileEvidence: [{ id: "ed-create", kind: "create", file: "report.md", path: "/workspace/report.md", deliverable: true, diffAvailable: true, added: 1, removed: 0 }] } },
  }, "edit");
  const generic = projectDesktopArtifactEvidence({
    toolCallId: "external-diff",
    content: [{ type: "diff", path: "/workspace/unknown.txt", oldText: "x", newText: "y" }],
  }, "other");
  assert.equal(created[0].kind, "create");
  assert.equal(created[0].deliverable, true);
  assert.equal(generic[0].kind, "change");
  assert.equal(generic[0].deliverable, false);
  const groups = groupDesktopArtifactEvidence([...created, ...generic]);
  assert.equal(groups.find((row) => row.path.endsWith("report.md"))?.deliverable, true);
  assert.equal(groups.find((row) => row.path.endsWith("unknown.txt"))?.deliverable, false);
});

test("Desktop U4 delete evidence remains explicit when no complete structured diff exists", () => {
  const rows = projectDesktopArtifactEvidence({
    toolCallId: "delete-u4",
    locations: [{ path: "/workspace/old.txt" }],
    meta: { freesek: { fileEvidenceVersion: 1, fileEvidence: [{ id: "ed-delete", kind: "delete", file: "old.txt", path: "/workspace/old.txt", deliverable: false, diffAvailable: false, removed: 0 }] } },
  }, "delete");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "delete");
  assert.equal(rows[0].diffAvailable, false);
  assert.equal(rows[0].diff, undefined);
});

test("Desktop U3 projects permission and elicitation lifecycle without retaining elicitation answers", () => {
  const permission = projectDesktopHostRequest({
    type: "host-request", requestId: "permission-1", requestKind: "permission",
    payload: {
      toolCall: { toolCallId: "call-7", title: "Approve write_file?", kind: "edit", rawInput: { path: "src/main.ts" } },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    },
  });
  assert.equal(permission.kind, "permission");
  assert.equal(permission.toolCallId, "call-7");
  assert.equal(permission.status, "pending");
  const allowed = completeDesktopHostRequest(permission, "allow-once");
  assert.equal(allowed.status, "completed");
  assert.match(allowed.summary, /Allow once/);

  const elicitation = projectDesktopHostRequest({
    type: "host-request", requestId: "ask-1", requestKind: "elicitation",
    payload: { message: "Choose deployment mode", requestedSchema: { properties: { value: { type: "string" } } } },
  });
  const answered = completeDesktopHostRequest(elicitation, "sensitive-answer");
  assert.equal(answered.status, "completed");
  assert.match(answered.summary, /response submitted/);
  assert.doesNotMatch(JSON.stringify(answered), /sensitive-answer/);
  assert.equal(completeDesktopHostRequest(elicitation, null).status, "cancelled");
});

test("Desktop U3 trajectory filter/search is semantic, tokenized and bounded for long sessions", () => {
  const row = { kind: "tool" as const, title: "read_file", subtitle: "src/main.ts", status: "completed", turn: 12, detail: { output: "needle result" } };
  assert.equal(matchesDesktopTrajectoryFilter(row, "tool", "main needle"), true);
  assert.equal(matchesDesktopTrajectoryFilter(row, "turn", "main"), false);
  assert.equal(matchesDesktopTrajectoryFilter({ ...row, kind: "permission" as const }, "interaction", "turn 12"), true);
  assert.match(desktopTrajectorySearchText(row), /turn 12/);
  assert.match(desktopTrajectorySearchText({ kind: "event", title: "Future event", subtitle: "", status: "" }), /future event/);

  const longSession = Array.from({ length: 5000 }, (_, index) => ({
    kind: index % 7 === 0 ? "permission" as const : "tool" as const,
    title: index === 4321 ? "target_tool" : `tool_${index}`,
    subtitle: `turn ${Math.floor(index / 5) + 1}`,
    status: index % 3 === 0 ? "completed" : "in_progress",
    detail: { output: "x".repeat(8000) },
  }));
  const indexed = longSession.map((item) => ({ ...item, searchText: desktopTrajectorySearchText(item) }));
  const matched = indexed.filter((item) => matchesDesktopTrajectoryFilter(item, "all", "target_tool"));
  assert.equal(matched.length, 1);
  assert.ok(indexed[0].searchText.length < 4200, "search indexing must not copy arbitrarily large tool output");
});

test("Desktop UI shell exposes conversation, trajectory and artifact panes without privileged renderer imports", () => {
  const html = readFileSync(resolve(ROOT, "apps/desktop/src/index.html"), "utf8");
  const renderer = readFileSync(resolve(ROOT, "apps/desktop/src/renderer.ts"), "utf8");
  const presentation = readFileSync(resolve(ROOT, "apps/desktop/src/presentation.ts"), "utf8");
  const registry = readFileSync(resolve(ROOT, "apps/desktop/src/presentation-registry.ts"), "utf8");
  const artifactEvidence = readFileSync(resolve(ROOT, "apps/desktop/src/artifact-evidence.ts"), "utf8");
  const styles = readFileSync(resolve(ROOT, "apps/desktop/src/styles.css"), "utf8");
  const trajectory = readFileSync(resolve(ROOT, "apps/desktop/src/trajectory.ts"), "utf8");
  const desktopBuild = readFileSync(resolve(ROOT, "scripts/desktop-build.mjs"), "utf8");
  for (const id of ["workarea", "messages", "conversationWindowControls", "detailsPane", "trajectoryPanel", "trajectorySearch", "trajectoryFilter", "trajectoryWindowInfo", "trajectoryList", "artifactPanel", "artifactDeliverables", "artifactEvidenceList", "artifactEvidenceDetail"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(renderer, /projectDesktopSessionUpdate/);
  assert.match(renderer, /presentDesktopToolEvent/);
  assert.match(renderer, /renderToolPresentationBlocks/);
  assert.match(renderer, /beginTurn/);
  assert.match(renderer, /handleHostRequest/);
  assert.match(renderer, /Inspect in trajectory/);
  assert.match(renderer, /registerToolArtifactEvidence/);
  assert.match(renderer, /Produced deliverables|artifactDeliverables/);
  assert.match(renderer, /IncrementalMarkdownRenderer/);
  assert.match(renderer, /boundedWindow/);
  assert.doesNotMatch(renderer, /textContent\s*\+=/);
  assert.match(renderer, /details-collapsed/);
  assert.match(styles, /data-card-kind="terminal"/);
  assert.match(styles, /data-card-kind="mutation"/);
  assert.match(styles, /content-visibility:auto/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(html, /role="log"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /role="dialog" aria-modal="true"[^>]*aria-describedby="hostDialogMessage"/);
  assert.match(renderer, /keyEvent\.key !== "Tab"/);
  assert.match(renderer, /detailsPane\.contains\(document\.activeElement\)/);
  assert.match(renderer, /focusTrajectoryAt\(matchingTrajectoryViews\(\), 0\)/);
  assert.match(desktopBuild, /renderer\.ts/);
  assert.match(desktopBuild, /--platform=browser/);
  assert.match(desktopBuild, /--format=iife/);
  assert.doesNotMatch(`${renderer}\n${presentation}\n${registry}\n${trajectory}\n${artifactEvidence}`, /from ["'][^"']*(eventlog|tool-runtime|runtime\/tool|node:fs|node:child_process)/i);
});
