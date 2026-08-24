import { defineHostCapabilities } from "../../kernel/host-capabilities";

/**
 * Runtime capability profile for the local Web Console host.
 *
 * Web Console is a control-plane host: it bridges a browser UI to the shared
 * Kernel through the stable ACP boundary (same pattern as the Desktop Host).
 * It claims interactive permission prompts and rich presentation, but never
 * editor-native capabilities (diffReview/lsp/imageInput stay false).
 */
export const WEB_HOST_CAPABILITIES = defineHostCapabilities({
  kind: "web",
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
