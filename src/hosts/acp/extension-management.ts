import type { ExtensionManagementService } from "../../kernel/extensions/management";
import { AcpRpcError } from "./protocol";

export interface AcpExtensionManagementResult {
  handled: boolean;
  value?: unknown;
}

const METHODS = new Set([
  "freesek/extensions/list",
  "freesek/extensions/status",
  "freesek/extensions/reload",
  "freesek/extensions/remove",
  "freesek/extensions/reconcile",
  "freesek/extensions/config",
  "freesek/extensions/audit",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw AcpRpcError.invalidParams(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw AcpRpcError.invalidParams(`${label}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function managerOrThrow(manager: ExtensionManagementService | undefined): ExtensionManagementService {
  if (!manager) throw new AcpRpcError(-32030, "General HMR is not configured for this ACP process");
  return manager;
}

/** FreeSeek vendor JSON-RPC adapter for H3 Extension management. It is not part of ACP v1. */
export async function handleAcpExtensionManagement(
  method: string,
  params: unknown,
  management: ExtensionManagementService | undefined
): Promise<AcpExtensionManagementResult> {
  if (!METHODS.has(method)) return { handled: false };
  const manager = managerOrThrow(management);
  switch (method) {
    case "freesek/extensions/list":
      return { handled: true, value: manager.snapshot() };
    case "freesek/extensions/status": {
      const row = record(params ?? {}, "extensions/status params");
      return { handled: true, value: manager.status(stringField(row, "id", "extensions/status params")) };
    }
    case "freesek/extensions/reload": {
      const row = record(params ?? {}, "extensions/reload params");
      return { handled: true, value: await manager.reload(stringField(row, "id", "extensions/reload params")) };
    }
    case "freesek/extensions/remove": {
      const row = record(params ?? {}, "extensions/remove params");
      return { handled: true, value: await manager.remove(stringField(row, "id", "extensions/remove params")) };
    }
    case "freesek/extensions/reconcile":
      return { handled: true, value: await manager.reconcile() };
    case "freesek/extensions/config": {
      const row = record(params ?? {}, "extensions/config params");
      if (typeof row.enabled !== "boolean") {
        throw AcpRpcError.invalidParams("extensions/config params.enabled must be boolean");
      }
      return {
        handled: true,
        value: await manager.configure(stringField(row, "id", "extensions/config params"), { enabled: row.enabled }),
      };
    }
    case "freesek/extensions/audit": {
      const row = record(params ?? {}, "extensions/audit params");
      const extensionId = typeof row.id === "string" && row.id.trim() ? row.id.trim() : undefined;
      const limit = row.limit === undefined ? undefined : Number(row.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
        throw AcpRpcError.invalidParams("extensions/audit params.limit must be an integer in 1..500");
      }
      return {
        handled: true,
        value: { events: manager.audit({ ...(extensionId ? { extensionId } : {}), ...(limit ? { limit } : {}) }) },
      };
    }
    default:
      return { handled: false };
  }
}
