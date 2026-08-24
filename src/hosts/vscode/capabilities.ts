import { defineHostCapabilities } from "../../kernel/host-capabilities";

/** Current stable VS Code host capability profile. */
export const VSCODE_HOST_CAPABILITIES = defineHostCapabilities({
  kind: "vscode",
  interactiveInput: true,
  permissionPrompt: true,
  diffReview: true,
  lsp: true,
  imageInput: true,
  mcp: true,
  skills: true,
  multiAgent: true,
  scheduling: true,
  persistentSessions: true,
  richPresentation: true,
});
