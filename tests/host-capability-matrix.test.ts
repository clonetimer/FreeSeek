import assert from "node:assert/strict";
import test from "node:test";
import { VSCODE_HOST_CAPABILITIES } from "../src/hosts/vscode/capabilities";
import { CLI_HOST_CAPABILITIES, createCliHostCapabilities } from "../src/hosts/cli/capabilities";
import { ACP_HOST_CAPABILITIES, createAcpHostCapabilities } from "../src/hosts/acp/capabilities";
import { EVAL_HOST_CAPABILITIES } from "../src/hosts/eval/capabilities";
import { DESKTOP_HOST_CAPABILITIES } from "../src/hosts/desktop/capabilities";
import { WEB_HOST_CAPABILITIES } from "../src/hosts/web/capabilities";

test("Cross-host default capability profiles preserve product boundaries", () => {
  assert.deepEqual(VSCODE_HOST_CAPABILITIES, {
    kind: "vscode", interactiveInput: true, permissionPrompt: true, diffReview: true, lsp: true,
    imageInput: true, mcp: true, skills: true, multiAgent: true, scheduling: true,
    persistentSessions: true, richPresentation: true,
  });
  assert.deepEqual(CLI_HOST_CAPABILITIES, {
    kind: "cli", interactiveInput: false, permissionPrompt: false, diffReview: false, lsp: false,
    imageInput: false, mcp: false, skills: false, multiAgent: false, scheduling: false,
    persistentSessions: true, richPresentation: false,
  });
  assert.deepEqual(ACP_HOST_CAPABILITIES, {
    kind: "acp", interactiveInput: false, permissionPrompt: true, diffReview: false, lsp: false,
    imageInput: false, mcp: true, skills: true, multiAgent: false, scheduling: false,
    persistentSessions: true, richPresentation: true,
  });
  assert.deepEqual(DESKTOP_HOST_CAPABILITIES, {
    kind: "desktop", interactiveInput: true, permissionPrompt: true, diffReview: false, lsp: false,
    imageInput: false, mcp: true, skills: true, multiAgent: false, scheduling: false,
    persistentSessions: true, richPresentation: true,
  });
  assert.deepEqual(EVAL_HOST_CAPABILITIES, {
    kind: "eval", interactiveInput: false, permissionPrompt: false, diffReview: false, lsp: false,
    imageInput: false, mcp: false, skills: false, multiAgent: false, scheduling: false,
    persistentSessions: false, richPresentation: false,
  });
  assert.deepEqual(WEB_HOST_CAPABILITIES, {
    kind: "web", interactiveInput: true, permissionPrompt: true, diffReview: false, lsp: false,
    imageInput: false, mcp: true, skills: true, multiAgent: false, scheduling: false,
    persistentSessions: true, richPresentation: true,
  });
});

test("CLI and ACP optional services are explicit rather than silent degradations", () => {
  const cli = createCliHostCapabilities({ interactive: true, mcp: true, skills: true, multiAgent: true });
  assert.equal(cli.interactiveInput, true);
  assert.equal(cli.permissionPrompt, true);
  assert.equal(cli.mcp, true);
  assert.equal(cli.skills, true);
  assert.equal(cli.multiAgent, true);
  assert.equal(cli.lsp, false);

  const acp = createAcpHostCapabilities({ interactive: true, mcp: false, skills: false, multiAgent: true });
  assert.equal(acp.interactiveInput, true);
  assert.equal(acp.permissionPrompt, true);
  assert.equal(acp.mcp, false);
  assert.equal(acp.skills, false);
  assert.equal(acp.multiAgent, true);
  assert.equal(acp.diffReview, false);
});
