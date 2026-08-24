import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopPersistedSettings, DesktopStartRequest } from "./contracts";

const DEFAULT_SETTINGS: DesktopPersistedSettings = {
  workspace: "",
  provider: {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    format: "openai",
    toolMode: "native",
    authType: "none",
  },
  allowShell: false,
  allowNetwork: true,
  enableSkills: true,
  skillDirs: [],
  extensionDirs: [],
  extensionSandboxPolicyFile: "",
  enableMultiAgent: false,
  additionalDirectories: [],
  mcpServers: [],
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean) : [];
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs are owned by the OS profile. */ }
}

/** JSON settings store that deliberately excludes provider and MCP environment secrets. */
export class DesktopSettingsStore {
  constructor(readonly file: string) {}

  /** Read renderer-safe preferences, falling back to conservative defaults. */
  read(): DesktopPersistedSettings {
    if (!fs.existsSync(this.file)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<DesktopPersistedSettings>;
      const provider = raw.provider ?? DEFAULT_SETTINGS.provider;
      return {
        workspace: typeof raw.workspace === "string" ? raw.workspace : "",
        provider: {
          baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : DEFAULT_SETTINGS.provider.baseUrl,
          model: typeof provider.model === "string" ? provider.model : DEFAULT_SETTINGS.provider.model,
          format: ["openai", "claude", "gemini"].includes(String(provider.format)) ? provider.format! : "openai",
          toolMode: ["native", "react"].includes(String(provider.toolMode)) ? provider.toolMode! : "native",
          authType: ["none", "bearer", "x-api-key", "x-goog-api-key"].includes(String(provider.authType)) ? provider.authType! : "none",
        },
        allowShell: raw.allowShell === true,
        allowNetwork: raw.allowNetwork !== false,
        enableSkills: raw.enableSkills !== false,
        skillDirs: strings(raw.skillDirs),
        extensionDirs: strings(raw.extensionDirs),
        extensionSandboxPolicyFile: typeof raw.extensionSandboxPolicyFile === "string" ? raw.extensionSandboxPolicyFile.trim() : "",
        enableMultiAgent: raw.enableMultiAgent === true,
        additionalDirectories: strings(raw.additionalDirectories),
        mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const row = entry as Record<string, unknown>;
          const name = typeof row.name === "string" ? row.name.trim() : "";
          const command = typeof row.command === "string" ? row.command.trim() : "";
          if (!name || !command) return [];
          return [{ name, command, args: strings(row.args) }];
        }) : [],
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  /** Persist a start request after stripping all secret-bearing fields. */
  write(request: DesktopStartRequest): DesktopPersistedSettings {
    const persisted: DesktopPersistedSettings = {
      workspace: request.workspace.trim(),
      provider: {
        baseUrl: request.provider.baseUrl.trim(),
        model: request.provider.model.trim(),
        format: request.provider.format,
        toolMode: request.provider.toolMode,
        authType: request.provider.authType,
      },
      allowShell: !!request.allowShell,
      allowNetwork: !!request.allowNetwork,
      enableSkills: !!request.enableSkills,
      skillDirs: strings(request.skillDirs),
      extensionDirs: strings(request.extensionDirs),
      extensionSandboxPolicyFile: request.extensionSandboxPolicyFile?.trim() ?? "",
      enableMultiAgent: !!request.enableMultiAgent,
      additionalDirectories: strings(request.additionalDirectories),
      mcpServers: request.mcpServers.flatMap((server) => {
        const name = server.name?.trim();
        const command = server.command?.trim();
        if (!name || !command) return [];
        return [{ name, command, args: strings(server.args) }];
      }),
    };
    atomicWriteJson(this.file, persisted);
    return persisted;
  }
}
