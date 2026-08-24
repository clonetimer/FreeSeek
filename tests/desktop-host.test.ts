import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DesktopAcpConnection, buildDesktopAcpArgs } from "../src/hosts/desktop/acp-client";
import { DESKTOP_HOST_CAPABILITIES } from "../src/hosts/desktop/capabilities";
import { NdJsonRpcPeer } from "../src/hosts/acp/protocol";

test("Desktop Host is interactive/rich but does not claim editor-native capabilities", () => {
  assert.deepEqual(DESKTOP_HOST_CAPABILITIES, {
    kind: "desktop", interactiveInput: true, permissionPrompt: true, diffReview: false, lsp: false,
    imageInput: false, mcp: true, skills: true, multiAgent: false, scheduling: false,
    persistentSessions: true, richPresentation: true,
  });
});

test("Desktop ACP launch arguments preserve provider and runtime policy", () => {
  const args = buildDesktopAcpArgs({
    agentEntry: "freesek-acp.js", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model",
    authType: "none", sessionDir: "/tmp/sessions", allowShell: true, allowNetwork: false,
    enableMultiAgent: true, enableSkills: false, extensionDirs: ["/opt/freeseek/extensions"], extensionSandboxPolicyFile: "/opt/freeseek/sandbox-policy.json", contextPlanner: "v1.2", contextPlanBudget: 4096,
  });
  assert.deepEqual(args, [
    "--base-url", "http://127.0.0.1:1234/v1", "--model", "local-model", "--format", "openai",
    "--tool-mode", "native", "--auth-type", "none", "--session-dir", "/tmp/sessions",
    "--context-planner", "v1.2", "--context-plan-budget", "4096", "--allow-shell", "--no-network",
    "--enable-multi-agent", "--no-skills", "--extension-dir", "/opt/freeseek/extensions", "--extension-sandbox-policy", "/opt/freeseek/sandbox-policy.json",
  ]);
});

test("Desktop ACP client handles session updates, permission and elicitation bidirectionally", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const updates: unknown[] = [];
  const diagnostics: string[] = [];
  const server = new NdJsonRpcPeer(clientToServer, serverToClient, (message) => diagnostics.push(message));
  server.start(async (method, params) => {
    if (method === "initialize") {
      assert.equal((params as any).protocolVersion, 1);
      assert.ok((params as any).clientCapabilities.elicitation.form);
      return { protocolVersion: 1, agentInfo: { name: "FreeSeek", version: "test" } };
    }
    if (method === "freesek/extensions/list") return { trustRoots: ["/extensions"], extensions: [{ id: "demo.tools", enabled: true, health: "ok" }] };
    if (method === "freesek/extensions/status") { assert.equal((params as any).id, "demo.tools"); return { id: "demo.tools", health: "ok" }; }
    if (method === "freesek/extensions/reload") { assert.equal((params as any).id, "demo.tools"); return { id: "demo.tools", runtime: { activeGeneration: 2 } }; }
    if (method === "freesek/extensions/remove") { assert.equal((params as any).id, "demo.tools"); return { id: "demo.tools", health: "disabled" }; }
    if (method === "freesek/extensions/reconcile") return { trustRoots: ["/extensions"], extensions: [] };
    if (method === "freesek/extensions/config") { assert.deepEqual(params, { id: "demo.tools", enabled: false }); return { id: "demo.tools", enabled: false }; }
    if (method === "freesek/extensions/audit") { assert.deepEqual(params, { id: "demo.tools", limit: 7 }); return { events: [{ source: "management" }] }; }
    if (method === "session/new") return { sessionId: "desktop-session-1" };
    if (method === "session/prompt") {
      server.notify("session/update", { sessionId: "desktop-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
      const permission = await server.request("session/request_permission", { toolCall: { title: "Approve write_file?" } }) as any;
      assert.equal(permission.outcome.optionId, "allow-once");
      const elicitation = await server.request("elicitation/create", { message: "Choose value" }) as any;
      assert.deepEqual(elicitation, { action: "accept", content: { value: "answer" } });
      return { stopReason: "end_turn" };
    }
    if (method === "session/set_mode" || method === "session/close") return {};
    if (method === "session/list") {
      assert.equal((params as any).cwd, "/workspace");
      return { sessions: [{ sessionId: "desktop-session-1", cwd: "/workspace" }] };
    }
    if (method === "session/resume") {
      assert.equal((params as any).sessionId, "desktop-session-1");
      return { modes: { currentModeId: "plan" } };
    }
    if (method === "session/load") {
      assert.equal((params as any).sessionId, "desktop-session-1");
      server.notify("session/update", { sessionId: "desktop-session-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "historic prompt" } } });
      return { modes: { currentModeId: "plan" } };
    }
    throw new Error(`unexpected method ${method}`);
  });

  const client = new DesktopAcpConnection(serverToClient, clientToServer, {
    onSessionUpdate: (params) => updates.push(params),
    requestPermission: () => "allow-once",
    requestElicitation: () => "answer",
  });
  await client.initialize("0.20.0-dev.1");
  const created = await client.newSession("/workspace");
  assert.equal(created.sessionId, "desktop-session-1");
  const result = await client.prompt(created.sessionId, "hello");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0]), /agent_message_chunk/);
  assert.equal((await client.listSessions({ cwd: "/workspace" }) as any).sessions.length, 1);
  await client.setMode(created.sessionId, "plan");
  await client.closeSession(created.sessionId);
  await client.resumeSession(created.sessionId, "/workspace");
  await client.closeSession(created.sessionId);
  await client.loadSession(created.sessionId, "/workspace");
  assert.match(JSON.stringify(updates), /historic prompt/);
  assert.equal((await client.extensionsList() as any).extensions[0].id, "demo.tools");
  assert.equal((await client.extensionStatus("demo.tools") as any).health, "ok");
  assert.equal((await client.extensionReload("demo.tools") as any).runtime.activeGeneration, 2);
  assert.equal((await client.extensionRemove("demo.tools") as any).health, "disabled");
  assert.equal((await client.extensionsReconcile() as any).extensions.length, 0);
  assert.equal((await client.extensionConfigure("demo.tools", false) as any).enabled, false);
  assert.equal((await client.extensionAudit("demo.tools", 7) as any).events.length, 1);
  client.close(); server.close();
  assert.deepEqual(diagnostics, []);
});
