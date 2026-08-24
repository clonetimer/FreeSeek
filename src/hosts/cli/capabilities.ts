import { defineHostCapabilities, type HostCapabilities } from "../../kernel/host-capabilities";

/** Optional feature services explicitly mounted into one CLI/Headless run. */
export interface CliHostCapabilityOptions {
  interactive?: boolean;
  mcp?: boolean;
  skills?: boolean;
  multiAgent?: boolean;
}

/** Build the CLI capability profile for a concrete run. */
export function createCliHostCapabilities(options: boolean | CliHostCapabilityOptions = false): HostCapabilities {
  const resolved: CliHostCapabilityOptions = typeof options === "boolean" ? { interactive: options } : options;
  const interactive = resolved.interactive === true;
  return defineHostCapabilities({
    kind: "cli",
    interactiveInput: interactive,
    permissionPrompt: interactive,
    diffReview: false,
    lsp: false,
    imageInput: false,
    mcp: resolved.mcp === true,
    skills: resolved.skills === true,
    multiAgent: resolved.multiAgent === true,
    scheduling: false,
    persistentSessions: true,
    richPresentation: false,
  });
}

/** Default CLI/Headless profile is safe for CI: non-interactive with optional services disabled. */
export const CLI_HOST_CAPABILITIES = createCliHostCapabilities();
