import { defineHostCapabilities } from "../../kernel/host-capabilities";

/** Desktop Host capability profile for the 0.20 standalone application line. */
export const DESKTOP_HOST_CAPABILITIES = defineHostCapabilities({
  kind: "desktop",
  interactiveInput: true,
  permissionPrompt: true,
  diffReview: false,
  lsp: false,
  imageInput: false,
  mcp: true,
  skills: true,
  multiAgent: false,
  scheduling: false,
  persistentSessions: true,
  richPresentation: true,
});
