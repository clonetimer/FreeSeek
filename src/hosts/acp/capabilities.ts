import { defineHostCapabilities } from "../../kernel/host-capabilities";

export interface AcpHostCapabilityOptions {
  mcp?: boolean;
  skills?: boolean;
  multiAgent?: boolean;
  interactive?: boolean;
}

/** Runtime capability profile for the ACP v1 stdio host. */
export function createAcpHostCapabilities(options: AcpHostCapabilityOptions = {}) {
  return defineHostCapabilities({
    kind: "acp",
    interactiveInput: options.interactive === true,
    permissionPrompt: true,
    diffReview: false,
    lsp: false,
    imageInput: false,
    mcp: options.mcp !== false,
    skills: options.skills !== false,
    multiAgent: options.multiAgent === true,
    scheduling: false,
    persistentSessions: true,
    richPresentation: true,
  });
}

/** Default capability profile for the ACP v1 stdio host. */
export const ACP_HOST_CAPABILITIES = createAcpHostCapabilities();

/** @deprecated Use ACP_HOST_CAPABILITIES. Retained for 0.19-alpha source compatibility. */
export const ACP_TARGET_CAPABILITIES = ACP_HOST_CAPABILITIES;
