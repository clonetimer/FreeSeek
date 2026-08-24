/** Host capability contract regression tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requireHostCapability, supportsHostCapability } from "../src/kernel/host-capabilities";
import { ACP_HOST_CAPABILITIES, createAcpHostCapabilities } from "../src/hosts/acp/capabilities";
import { CLI_HOST_CAPABILITIES } from "../src/hosts/cli/capabilities";
import { VSCODE_HOST_CAPABILITIES } from "../src/hosts/vscode/capabilities";

test("stable hosts declare capabilities explicitly", () => {
  assert.equal(VSCODE_HOST_CAPABILITIES.interactiveInput, true);
  assert.equal(VSCODE_HOST_CAPABILITIES.multiAgent, true);
  assert.equal(CLI_HOST_CAPABILITIES.persistentSessions, true);
  assert.equal(CLI_HOST_CAPABILITIES.interactiveInput, false);
  assert.equal(CLI_HOST_CAPABILITIES.multiAgent, false);
});

test("unsupported host interaction fails explicitly instead of silently degrading", () => {
  assert.equal(supportsHostCapability(CLI_HOST_CAPABILITIES, "interactiveInput"), false);
  assert.throws(
    () => requireHostCapability(CLI_HOST_CAPABILITIES, "interactiveInput", "interactive ask_user"),
    /does not support interactive ask_user/
  );
});

test("ACP profile is capability-negotiated and policy-gated", () => {
  assert.equal(ACP_HOST_CAPABILITIES.interactiveInput, false, "elicitation stays off until the client negotiates form input");
  assert.equal(ACP_HOST_CAPABILITIES.permissionPrompt, true);
  assert.equal(ACP_HOST_CAPABILITIES.persistentSessions, true);
  assert.equal(ACP_HOST_CAPABILITIES.mcp, true);
  assert.equal(ACP_HOST_CAPABILITIES.skills, true);
  assert.equal(ACP_HOST_CAPABILITIES.multiAgent, false, "multi-agent remains explicit opt-in");
  const negotiated = createAcpHostCapabilities({ interactive: true, skills: false, multiAgent: true });
  assert.equal(negotiated.interactiveInput, true);
  assert.equal(negotiated.skills, false);
  assert.equal(negotiated.multiAgent, true);
});
