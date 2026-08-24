import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  DesktopArtifactPreview,
  DesktopEvent,
  DesktopProviderInput,
  DesktopSettingsResult,
  DesktopStartRequest,
} from "./contracts";
import { DesktopRuntimeController, type DesktopRuntimeStartOptions } from "../../../src/hosts/desktop/runtime";
import { readDesktopElectronE2EConfig, runDesktopElectronE2E, writeDesktopElectronE2EFailure } from "./e2e";
import { DesktopSettingsStore } from "./settings-store";
import { DesktopProviderSecretStore } from "./secure-store";
import { DesktopRecoveryStore } from "./recovery-store";
import { previewDesktopArtifact, resolveDesktopArtifactPath } from "./artifact-access";
import { resolveDesktopSidecarLaunch } from "./sidecar-launch";

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron") as any;
const electronE2E = readDesktopElectronE2EConfig();
if (electronE2E?.userData) app.setPath("userData", path.resolve(electronE2E.userData));

interface PendingHostRequest {
  resolve(value: unknown): void;
  timer: NodeJS.Timeout;
}

let windowRef: any = null;
let activeScope: { workspace: string; roots: string[] } | null = null;
const pendingHostRequests = new Map<string, PendingHostRequest>();
const settingsStore = new DesktopSettingsStore(path.join(app.getPath("userData"), "desktop-settings.json"));
const secretStore = new DesktopProviderSecretStore(path.join(app.getPath("userData"), "provider-secret.json"), safeStorage);
const recoveryStore = new DesktopRecoveryStore(path.join(app.getPath("userData"), "recovery.json"));
const desktopEntry = path.join(__dirname, "index.html");
const desktopEntryUrl = pathToFileURL(desktopEntry).href;

function emit(event: DesktopEvent): void {
  windowRef?.webContents?.send("desktop:event", event);
}

function repoRoot(): string {
  const override = process.env.FREESEEK_REPO_ROOT?.trim();
  if (override) return path.resolve(override);
  let current = path.resolve(__dirname);
  for (;;) {
    const pkg = path.join(current, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "freeseek-copilot") return current;
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`无法从 Desktop 构建目录定位 FreeSeek 仓库根目录：${__dirname}`);
}

function providerWithoutSecret(provider: DesktopProviderInput): Omit<DesktopProviderInput, "apiKey"> {
  const { apiKey: _ignored, ...identity } = provider;
  return identity;
}

function requestRenderer(kind: "permission" | "elicitation", payload: unknown): Promise<unknown> {
  if (!windowRef || windowRef.isDestroyed?.()) return Promise.resolve(null);
  const requestId = crypto.randomUUID();
  emit({ type: "host-request", requestId, requestKind: kind, payload });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingHostRequests.delete(requestId);
      resolve(null);
    }, 5 * 60_000);
    pendingHostRequests.set(requestId, { resolve, timer });
  });
}

const runtime = new DesktopRuntimeController({
  onDiagnostic: (message) => emit({ type: "status", text: message.trim() }),
  onSessionUpdate: (payload) => emit({ type: "session-update", payload }),
  onSessionChanged: (sessionId) => emit({ type: "session", sessionId }),
  onChildExit: (code, signal) => emit({ type: "status", text: `ACP exited (${code ?? signal ?? "unknown"})` }),
  requestPermission: async (payload) => {
    const selected = await requestRenderer("permission", payload);
    return typeof selected === "string" ? selected : null;
  },
  requestElicitation: (payload) => requestRenderer("elicitation", payload),
});

function validateAbsoluteFile(value: string | undefined, label: string): string | undefined {
  const input = value?.trim(); if (!input) return undefined;
  if (!path.isAbsolute(input)) throw new Error(`${label} 必须使用绝对路径：${input}`);
  const resolved = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(resolved).isFile()) throw new Error(`${label} 不是文件：${input}`);
  return resolved;
}

function validateAbsoluteDirectories(values: readonly string[], label: string): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!path.isAbsolute(value)) throw new Error(`${label} 必须使用绝对目录：${value}`);
    const resolved = fs.realpathSync(path.resolve(value));
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} 不是目录：${value}`);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function runtimeStartOptions(request: DesktopStartRequest): DesktopRuntimeStartOptions {
  if (!path.isAbsolute(request.workspace) || !fs.existsSync(request.workspace)) throw new Error("请选择存在的绝对工作区目录");
  const workspace = fs.realpathSync(path.resolve(request.workspace));
  if (!fs.statSync(workspace).isDirectory()) throw new Error("Workspace 必须是目录");
  const additionalDirectories = validateAbsoluteDirectories(request.additionalDirectories ?? [], "Additional workspace").filter((root) => root !== workspace);
  const skillDirs = validateAbsoluteDirectories(request.skillDirs ?? [], "Skill root");
  const extensionDirs = validateAbsoluteDirectories(request.extensionDirs ?? [], "Extension trust root");
  const extensionSandboxPolicyFile = validateAbsoluteFile(request.extensionSandboxPolicyFile, "Extension sandbox policy");
  const sidecar = resolveDesktopSidecarLaunch({
    isPackaged: !!app.isPackaged,
    resourcesPath: (process as any).resourcesPath,
    processExecPath: process.execPath,
    repoRoot: app.isPackaged ? process.cwd() : repoRoot(),
    overrideEntry: process.env.FREESEEK_ACP_ENTRY,
    overrideNode: process.env.FREESEEK_NODE_BIN,
  });
  if (!fs.existsSync(sidecar.agentEntry)) throw new Error(`未找到 FreeSeek ACP sidecar：${sidecar.agentEntry}`);
  const providerIdentity = providerWithoutSecret(request.provider);
  const apiKey = request.provider.apiKey || secretStore.load(providerIdentity);
  if (request.provider.authType !== "none" && !apiKey) throw new Error("当前 Provider 需要凭据；请输入一次性 API Key 或先保存到 OS-protected secret storage");
  return {
    clientVersion: app.getVersion(),
    workspace,
    session: {
      additionalDirectories,
      mcpServers: request.mcpServers ?? [],
    },
    acp: {
      nodeCommand: sidecar.nodeCommand,
      agentEntry: sidecar.agentEntry,
      baseUrl: request.provider.baseUrl,
      apiKey,
      model: request.provider.model,
      format: request.provider.format,
      toolMode: request.provider.toolMode,
      authType: request.provider.authType,
      sessionDir: path.join(app.getPath("userData"), "acp-sessions"),
      cwd: workspace,
      allowShell: request.allowShell,
      allowNetwork: request.allowNetwork,
      enableMultiAgent: request.enableMultiAgent,
      enableSkills: request.enableSkills,
      skillDirs,
      extensionDirs,
      ...(extensionSandboxPolicyFile ? { extensionSandboxPolicyFile } : {}),
      env: sidecar.env,
    },
  };
}

function rememberActiveScope(options: DesktopRuntimeStartOptions): void {
  activeScope = {
    workspace: options.workspace,
    roots: [options.workspace, ...(options.session?.additionalDirectories ?? [])],
  };
}

async function startDesktopSession(request: DesktopStartRequest): Promise<{ sessionId: string }> {
  const options = runtimeStartOptions(request);
  const result = await runtime.start(options);
  rememberActiveScope(options);
  return result;
}

async function loadDesktopHistory(request: DesktopStartRequest): Promise<unknown> {
  await runtime.connect(runtimeStartOptions(request));
  return runtime.listSessions(path.resolve(request.workspace));
}

async function resumeDesktopSession(request: DesktopStartRequest, sessionId: string): Promise<{ sessionId: string }> {
  if (!sessionId?.trim()) throw new Error("缺少要恢复的 sessionId");
  const options = runtimeStartOptions(request);
  const result = await runtime.resume(options, sessionId);
  rememberActiveScope(options);
  return result;
}

async function loadDesktopSession(request: DesktopStartRequest, sessionId: string): Promise<{ sessionId: string }> {
  if (!sessionId?.trim()) throw new Error("缺少要加载的 sessionId");
  const options = runtimeStartOptions(request);
  const result = await runtime.load(options, sessionId);
  rememberActiveScope(options);
  return result;
}

function settingsResult(): DesktopSettingsResult {
  const settings = settingsStore.read();
  const provider = settings.provider;
  const status = secretStore.status();
  return {
    settings,
    secret: {
      stored: secretStore.has(provider),
      secureStorage: status.secure,
      ...(status.backend ? { backend: status.backend } : {}),
    },
  };
}

function saveDesktopSettings(request: DesktopStartRequest): DesktopSettingsResult {
  const persisted = settingsStore.write(request);
  if (request.provider.apiKey) secretStore.save(persisted.provider, request.provider.apiKey);
  const status = secretStore.status();
  return {
    settings: persisted,
    secret: {
      stored: secretStore.has(persisted.provider),
      secureStorage: status.secure,
      ...(status.backend ? { backend: status.backend } : {}),
    },
  };
}

function assertTrustedRenderer(event: any): void {
  const contents = windowRef?.webContents;
  if (!contents || event?.sender !== contents || contents.getURL?.() !== desktopEntryUrl) {
    throw new Error("Rejected IPC from an untrusted Desktop renderer");
  }
}

function handleRendererIpc(channel: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event: any, ...args: any[]) => {
    assertTrustedRenderer(event);
    return handler(...args);
  });
}

function onRendererIpc(channel: string, handler: (...args: any[]) => void): void {
  ipcMain.on(channel, (event: any, ...args: any[]) => {
    assertTrustedRenderer(event);
    handler(...args);
  });
}

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 660,
    title: "FreeSeek Desktop",
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", (event: any, url: string) => {
    if (url !== desktopEntryUrl) event.preventDefault();
  });
  void windowRef.loadFile(desktopEntry);
  windowRef.webContents.once("did-finish-load", () => {
    const recovery = recoveryStore.read();
    if (recovery) emit({ type: "recovery", state: recovery });
  });
  windowRef.on("closed", () => {
    windowRef = null;
    for (const [id, pending] of pendingHostRequests) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      pendingHostRequests.delete(id);
    }
    activeScope = null;
    void runtime.stop("desktop-window-closed");
  });
}

handleRendererIpc("desktop:choose-workspace", async () => {
  const selected = await dialog.showOpenDialog(windowRef, { properties: ["openDirectory", "createDirectory"] });
  return selected.canceled ? null : selected.filePaths[0] ?? null;
});
handleRendererIpc("desktop:start", (request: DesktopStartRequest) => startDesktopSession(request));
handleRendererIpc("desktop:load-history", (request: DesktopStartRequest) => loadDesktopHistory(request));
handleRendererIpc("desktop:load", (payload: { request: DesktopStartRequest; sessionId: string }) => loadDesktopSession(payload.request, payload.sessionId));
handleRendererIpc("desktop:resume", (payload: { request: DesktopStartRequest; sessionId: string }) => resumeDesktopSession(payload.request, payload.sessionId));
handleRendererIpc("desktop:prompt", async (payload: { sessionId: string; text: string }) => {
  if (!runtime.connected || payload.sessionId !== runtime.sessionId || !activeScope) throw new Error("Desktop session 已变化，请重新连接");
  recoveryStore.begin(payload.sessionId, activeScope.workspace);
  try { return await runtime.prompt(payload.text); }
  finally { recoveryStore.clear(); }
});
handleRendererIpc("desktop:set-mode", async (payload: { sessionId: string; mode: "coder" | "craft" | "plan" | "ask" }) => {
  if (payload.sessionId !== runtime.sessionId) throw new Error("Desktop session 已变化，请重新连接");
  await runtime.setMode(payload.mode);
});
handleRendererIpc("desktop:cancel", (payload: { sessionId: string }) => {
  if (payload.sessionId === runtime.sessionId) runtime.cancel();
});
handleRendererIpc("desktop:list-sessions", () => runtime.listSessions());
handleRendererIpc("desktop:list-extensions", () => runtime.extensionsList());
handleRendererIpc("desktop:reload-extension", (payload: { id: string }) => runtime.extensionReload(String(payload?.id ?? "")));
handleRendererIpc("desktop:configure-extension", (payload: { id: string; enabled: boolean }) => runtime.extensionConfigure(String(payload?.id ?? ""), !!payload?.enabled));
handleRendererIpc("desktop:reconcile-extensions", () => runtime.extensionsReconcile());
handleRendererIpc("desktop:extension-audit", (payload: { id?: string }) => runtime.extensionAudit(payload?.id, 100));
handleRendererIpc("desktop:close-session", async (payload: { sessionId: string }) => {
  if (payload.sessionId === runtime.sessionId) await runtime.closeSession();
  recoveryStore.clear();
  activeScope = null;
});
handleRendererIpc("desktop:get-settings", () => settingsResult());
handleRendererIpc("desktop:save-settings", (request: DesktopStartRequest) => saveDesktopSettings(request));
handleRendererIpc("desktop:forget-provider-secret", (provider: Omit<DesktopProviderInput, "apiKey">) => {
  secretStore.forget(provider);
});
handleRendererIpc("desktop:preview-artifact", (input: string): DesktopArtifactPreview => {
  if (!activeScope) throw new Error("Artifact preview requires an active Desktop session");
  return previewDesktopArtifact(input, activeScope.roots);
});
handleRendererIpc("desktop:open-artifact", async (input: string) => {
  if (!activeScope) throw new Error("Artifact open requires an active Desktop session");
  const file = resolveDesktopArtifactPath(input, activeScope.roots);
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
});
handleRendererIpc("desktop:recover-interrupted", async (payload: { action: "recover" | "dismiss"; request?: DesktopStartRequest }) => {
  const state = recoveryStore.read();
  if (!state) return {};
  if (payload.action === "dismiss") { recoveryStore.clear(); return {}; }
  if (!payload.request) throw new Error("Recovery requires current Desktop settings");
  if (path.resolve(payload.request.workspace) !== path.resolve(state.workspace)) throw new Error(`Recovery workspace must remain ${state.workspace}`);
  const loaded = await loadDesktopSession(payload.request, state.sessionId);
  recoveryStore.clear();
  return loaded;
});
onRendererIpc("desktop:host-response", (payload: { requestId: string; value: unknown }) => {
  const pending = pendingHostRequests.get(payload.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingHostRequests.delete(payload.requestId);
  pending.resolve(payload.value);
});

app.whenReady().then(async () => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  if (electronE2E) {
    try {
      await runDesktopElectronE2E(windowRef, electronE2E);
      await runtime.stop("desktop-electron-e2e-complete");
      app.exit(0);
    } catch (error) {
      writeDesktopElectronE2EFailure(electronE2E, error);
      await runtime.stop("desktop-electron-e2e-failed");
      app.exit(1);
    }
  }
});
app.on("window-all-closed", () => {
  void runtime.stop("desktop-app-quit");
  if (process.platform !== "darwin") app.quit();
});
