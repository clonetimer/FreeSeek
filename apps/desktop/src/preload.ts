import type {
  DesktopEvent,
  DesktopProviderInput,
  DesktopSessionListResult,
  DesktopStartRequest,
  FreeSeekDesktopApi,
} from "./contracts";

const { contextBridge, ipcRenderer } = require("electron") as any;

const api: FreeSeekDesktopApi = {
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  start: (request: DesktopStartRequest) => ipcRenderer.invoke("desktop:start", request),
  loadHistory: (request: DesktopStartRequest): Promise<DesktopSessionListResult> => ipcRenderer.invoke("desktop:load-history", request),
  load: (request: DesktopStartRequest, sessionId: string) => ipcRenderer.invoke("desktop:load", { request, sessionId }),
  resume: (request: DesktopStartRequest, sessionId: string) => ipcRenderer.invoke("desktop:resume", { request, sessionId }),
  prompt: (sessionId: string, text: string) => ipcRenderer.invoke("desktop:prompt", { sessionId, text }),
  setMode: (sessionId, mode) => ipcRenderer.invoke("desktop:set-mode", { sessionId, mode }),
  cancel: async (sessionId: string) => { await ipcRenderer.invoke("desktop:cancel", { sessionId }); },
  listSessions: (): Promise<DesktopSessionListResult> => ipcRenderer.invoke("desktop:list-sessions"),
  closeSession: async (sessionId: string) => { await ipcRenderer.invoke("desktop:close-session", { sessionId }); },
  listExtensions: () => ipcRenderer.invoke("desktop:list-extensions"),
  reloadExtension: (id: string) => ipcRenderer.invoke("desktop:reload-extension", { id }),
  configureExtension: (id: string, enabled: boolean) => ipcRenderer.invoke("desktop:configure-extension", { id, enabled }),
  reconcileExtensions: () => ipcRenderer.invoke("desktop:reconcile-extensions"),
  extensionAudit: (id?: string) => ipcRenderer.invoke("desktop:extension-audit", { ...(id ? { id } : {}) }),
  getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
  saveSettings: (request: DesktopStartRequest) => ipcRenderer.invoke("desktop:save-settings", request),
  forgetProviderSecret: async (provider: Omit<DesktopProviderInput, "apiKey">) => { await ipcRenderer.invoke("desktop:forget-provider-secret", provider); },
  previewArtifact: (path: string) => ipcRenderer.invoke("desktop:preview-artifact", path),
  openArtifact: async (path: string) => { await ipcRenderer.invoke("desktop:open-artifact", path); },
  recoverInterruptedTurn: (action: "recover" | "dismiss", request?: DesktopStartRequest) => ipcRenderer.invoke("desktop:recover-interrupted", { action, request }),
  respondHostRequest: (requestId: string, value: unknown) => ipcRenderer.send("desktop:host-response", { requestId, value }),
  onEvent: (listener: (event: DesktopEvent) => void) => {
    const wrapped = (_event: unknown, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on("desktop:event", wrapped);
    return () => ipcRenderer.removeListener("desktop:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("freesekDesktop", api);
