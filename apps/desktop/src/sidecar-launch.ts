import * as path from "node:path";

export interface DesktopSidecarLaunchResolution {
  agentEntry: string;
  nodeCommand: string;
  env: NodeJS.ProcessEnv;
}

/** Resolve dev vs packaged ACP sidecar without introducing a second Agent implementation. */
export function resolveDesktopSidecarLaunch(input: {
  isPackaged: boolean;
  resourcesPath?: string;
  processExecPath: string;
  repoRoot: string;
  overrideEntry?: string;
  overrideNode?: string;
}): DesktopSidecarLaunchResolution {
  const agentEntry = input.overrideEntry?.trim()
    ? path.resolve(input.overrideEntry)
    : input.isPackaged
      ? path.join(path.resolve(input.resourcesPath || path.dirname(input.processExecPath)), "freeseek", "sidecar", "freeseek-acp.js")
      : path.join(path.resolve(input.repoRoot), "dist", "freeseek-acp.js");
  return {
    agentEntry,
    nodeCommand: input.isPackaged ? input.processExecPath : (input.overrideNode?.trim() || "node"),
    env: input.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}
