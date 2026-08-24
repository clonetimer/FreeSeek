import * as path from "path";
import { FileExtensionHost } from "../../kernel/extensions/package-host";
import type { ExtensionManagementService } from "../../kernel/extensions/management";
import type { ExtensionRuntime } from "../../kernel/extensions/runtime";
import type { ExtensionSandboxPolicy } from "../../kernel/extensions/sandbox-policy";

export interface AcpExtensionServices {
  readonly runtime?: ExtensionRuntime;
  readonly management?: ExtensionManagementService;
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

/** ACP process-level General HMR owner shared by every durable session in this server. */
export function createAcpExtensionServices(
  roots: readonly string[] | undefined,
  stateDir: string,
  log: (message: string) => void,
  sandboxPolicy?: ExtensionSandboxPolicy
): AcpExtensionServices {
  if (!roots?.length) return { ready: Promise.resolve(), dispose: async () => undefined };
  const host = new FileExtensionHost({
    roots,
    stateDir: path.join(stateDir, "extensions"),
    runtime: { onAudit: (event) => log(`[hmr:${event.kind}] ${event.extensionId ?? event.leaseId ?? "runtime"}`) },
    watcher: { onEvent: (event) => log(`[hmr:${event.kind}] ${event.extensionId ?? event.packageDir ?? "watcher"}${event.error ? `: ${event.error}` : ""}`) },
    sandboxPolicy,
  });
  return { runtime: host.runtime, management: host.management, ready: host.start(), dispose: () => host.dispose() };
}
