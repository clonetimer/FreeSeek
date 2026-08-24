import { defineHostCapabilities } from "../../kernel/host-capabilities";

/** Internal non-interactive evaluation host profile. */
export const EVAL_HOST_CAPABILITIES = defineHostCapabilities({
  kind: "eval",
  interactiveInput: false,
  permissionPrompt: false,
  diffReview: false,
  lsp: false,
  imageInput: false,
  mcp: false,
  skills: false,
  multiAgent: false,
  scheduling: false,
  persistentSessions: false,
  richPresentation: false,
});
