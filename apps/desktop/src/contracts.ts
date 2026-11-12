/** Provider settings passed from the unprivileged renderer to the desktop main process. */
export interface DesktopProviderInput {
  baseUrl: string;
  apiKey?: string;
  model: string;
  format: "openai" | "responses" | "claude" | "gemini";
  toolMode: "native" | "react";
  authType: "none" | "bearer" | "x-api-key" | "x-goog-api-key";
}

/** Stdio MCP descriptor. Environment secrets are runtime-only and never persisted by Desktop settings. */
export interface DesktopMcpServerInput {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

/** Desktop session bootstrap request. The API key may be one-time input; persistence is main-process-only. */
export interface DesktopStartRequest {
  workspace: string;
  provider: DesktopProviderInput;
  allowShell: boolean;
  allowNetwork: boolean;
  enableSkills: boolean;
  skillDirs: string[];
  extensionDirs: string[];
  extensionSandboxPolicyFile?: string;
  enableMultiAgent: boolean;
  additionalDirectories: string[];
  mcpServers: DesktopMcpServerInput[];
}

/** Non-secret Desktop preferences stored under Electron userData. */
export interface DesktopPersistedSettings {
  workspace: string;
  provider: Omit<DesktopProviderInput, "apiKey">;
  allowShell: boolean;
  allowNetwork: boolean;
  enableSkills: boolean;
  skillDirs: string[];
  extensionDirs: string[];
  extensionSandboxPolicyFile: string;
  enableMultiAgent: boolean;
  additionalDirectories: string[];
  mcpServers: Array<Omit<DesktopMcpServerInput, "env">>;
}

/** Renderer-safe settings envelope. Provider secrets are represented only by availability metadata. */
export interface DesktopSettingsResult {
  settings: DesktopPersistedSettings;
  secret: { stored: boolean; secureStorage: boolean; backend?: string };
}

/** Durable ACP session summary rendered by the Desktop history panel. */
export interface DesktopSessionSummary {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

/** Page returned by ACP session/list. */
export interface DesktopSessionListResult {
  sessions: DesktopSessionSummary[];
  nextCursor?: string;
}

/** Main-process constrained text preview for an authorized workspace artifact. */
export interface DesktopArtifactPreview {
  path: string;
  name: string;
  size: number;
  text: string;
  truncated: boolean;
  binary: boolean;
}

/** Minimal interrupted-turn state. It never contains prompts, provider secrets or tool payloads. */
export interface DesktopRecoveryState {
  sessionId: string;
  workspace: string;
  updatedAt: string;
  inFlight: true;
}

/** Events emitted by the desktop main process to the renderer. */
export type DesktopEvent =
  | { type: "status"; text: string }
  | { type: "session"; sessionId: string }
  | { type: "session-update"; payload: unknown }
  | { type: "host-request"; requestId: string; requestKind: "permission" | "elicitation"; payload: unknown }
  | { type: "recovery"; state: DesktopRecoveryState }
  | { type: "error"; text: string };


export interface DesktopExtensionManagedStatus {
  id: string; enabled: boolean; health: string; packageVersion?: string; packageDirs: string[]; conflict: boolean; lastKnownGood: boolean;
  runtime: { state: string; activeVersion?: string; activeGeneration?: number; activeLeases?: number; pendingVersion?: string; missingDependencies?: string[]; retiredGenerations: number[]; lastError?: string; sandbox?: { mode: string; state: string; platform: string; isolation: string; pid?: number; lastError?: string } };
}
export interface DesktopExtensionSnapshot { trustRoots: string[]; extensions: DesktopExtensionManagedStatus[]; }

/** Renderer-visible API exposed through Electron contextBridge. */
export interface FreeSeekDesktopApi {
  chooseWorkspace(): Promise<string | null>;
  start(request: DesktopStartRequest): Promise<{ sessionId: string }>;
  loadHistory(request: DesktopStartRequest): Promise<DesktopSessionListResult>;
  load(request: DesktopStartRequest, sessionId: string): Promise<{ sessionId: string }>;
  resume(request: DesktopStartRequest, sessionId: string): Promise<{ sessionId: string }>;
  prompt(sessionId: string, text: string): Promise<{ stopReason?: string }>;
  setMode(sessionId: string, mode: "coder" | "craft" | "plan" | "ask"): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  listSessions(): Promise<DesktopSessionListResult>;
  closeSession(sessionId: string): Promise<void>;
  listExtensions(): Promise<DesktopExtensionSnapshot>;
  reloadExtension(id: string): Promise<DesktopExtensionManagedStatus>;
  configureExtension(id: string, enabled: boolean): Promise<DesktopExtensionManagedStatus>;
  reconcileExtensions(): Promise<DesktopExtensionSnapshot>;
  extensionAudit(id?: string): Promise<{ events: unknown[] }>;
  getSettings(): Promise<DesktopSettingsResult>;
  saveSettings(request: DesktopStartRequest): Promise<DesktopSettingsResult>;
  forgetProviderSecret(provider: Omit<DesktopProviderInput, "apiKey">): Promise<void>;
  previewArtifact(path: string): Promise<DesktopArtifactPreview>;
  openArtifact(path: string): Promise<void>;
  recoverInterruptedTurn(action: "recover" | "dismiss", request?: DesktopStartRequest): Promise<{ sessionId?: string }>;
  respondHostRequest(requestId: string, value: unknown): void;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}
