import * as fs from "node:fs";
import type { DesktopStartRequest } from "./contracts";

/** Configuration consumed only by the explicit Desktop Electron E2E mode. */
export interface DesktopElectronE2EConfig {
  readonly workspace: string;
  readonly resultFile: string;
  readonly userData?: string;
  readonly request: DesktopStartRequest;
  readonly verifySecretStore?: boolean;
  readonly mode?: "standard" | "recovery-interrupt" | "recovery-resume";
  readonly expectedSessionId?: string;
}

/** Read the opt-in Electron E2E config. Normal desktop launches return null. */
export function readDesktopElectronE2EConfig(): DesktopElectronE2EConfig | null {
  const file = process.env.FREESEEK_DESKTOP_E2E_CONFIG?.trim();
  if (!file) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DesktopElectronE2EConfig;
  if (!parsed?.workspace || !parsed?.resultFile || !parsed?.request) throw new Error("Invalid FREESEEK_DESKTOP_E2E_CONFIG");
  if (parsed.mode && !["standard", "recovery-interrupt", "recovery-resume"].includes(parsed.mode)) throw new Error("Invalid Desktop Electron E2E mode");
  if (parsed.mode === "recovery-resume" && !parsed.expectedSessionId) throw new Error("Recovery-resume E2E requires expectedSessionId");
  return parsed;
}

function writeE2EResult(config: DesktopElectronE2EConfig, result: unknown): void {
  const appIsPackaged = !!(require("electron") as any).app?.isPackaged;
  fs.mkdirSync(require("node:path").dirname(config.resultFile), { recursive: true });
  fs.writeFileSync(config.resultFile, JSON.stringify({ passed: true, result: { ...(result as object), appIsPackaged } }, null, 2));
}

/**
 * Drive the public contextBridge API from a real renderer WebContents.
 * This validates BrowserWindow + preload + IPC + DesktopRuntime + ACP child.
 */
export async function runDesktopElectronE2E(windowRef: any, config: DesktopElectronE2EConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!windowRef?.webContents) return reject(new Error("Desktop E2E window has no webContents"));
    if (!windowRef.webContents.isLoading?.()) return resolve();
    windowRef.webContents.once("did-finish-load", resolve);
    windowRef.webContents.once("did-fail-load", (_event: unknown, code: number, description: string) => reject(new Error(`did-fail-load ${code}: ${description}`)));
  });

  const requestJson = JSON.stringify(config.request);
  const mode = config.mode ?? "standard";
  if (mode === "recovery-interrupt") {
    const result = await windowRef.webContents.executeJavaScript(`(async () => {
      const api = window.freesekDesktop;
      if (!api) throw new Error('contextBridge API missing');
      const request = ${requestJson};
      const started = await api.start(request);
      void api.prompt(started.sessionId, 'Electron recovery interruption probe').catch(() => {});
      return {
        brand: document.querySelector('.brand strong')?.textContent || '',
        bridge: typeof api.start === 'function' && typeof api.recoverInterruptedTurn === 'function',
        sessionId: started.sessionId,
        interruptionArmed: true,
      };
    })()`);
    writeE2EResult(config, result);
    await new Promise<void>(() => {});
    return;
  }
  if (mode === "recovery-resume") {
    const expectedSessionId = JSON.stringify(config.expectedSessionId);
    const result = await windowRef.webContents.executeJavaScript(`(async () => {
      const api = window.freesekDesktop;
      if (!api) throw new Error('contextBridge API missing');
      const request = ${requestJson};
      const expectedSessionId = ${expectedSessionId};
      const recovered = await api.recoverInterruptedTurn('recover', request);
      if (!recovered?.sessionId) throw new Error('interrupted session was not recovered');
      const promptResult = await api.prompt(recovered.sessionId, 'Electron recovered ACP E2E');
      await api.closeSession(recovered.sessionId);
      return {
        brand: document.querySelector('.brand strong')?.textContent || '',
        bridge: typeof api.recoverInterruptedTurn === 'function',
        sessionId: recovered.sessionId,
        recoveredSameSession: recovered.sessionId === expectedSessionId,
        stopReason: promptResult?.stopReason || '',
      };
    })()`);
    writeE2EResult(config, result);
    return;
  }
  const verifySecretStore = config.verifySecretStore === true;
  const result = await windowRef.webContents.executeJavaScript(`(async () => {
    const api = window.freesekDesktop;
    if (!api) throw new Error('contextBridge API missing');
    const request = ${requestJson};
    const verifySecretStore = ${JSON.stringify(verifySecretStore)};
    const events = [];
    const off = api.onEvent((event) => events.push(event));
    try {
      const brand = document.querySelector('.brand strong')?.textContent || '';
      const saved = await api.saveSettings(request);
      const loadedSettings = await api.getSettings();
      let secretStoreVerified = !verifySecretStore;
      let secretBackend = saved?.secret?.backend || '';
      if (verifySecretStore) {
        secretStoreVerified = saved?.secret?.secureStorage === true && saved?.secret?.stored === true && loadedSettings?.secret?.stored === true;
      }
      const started = await api.start(request);
      const promptResult = await api.prompt(started.sessionId, 'Electron BrowserWindow ACP E2E');
      const listed = await api.listSessions();
      await api.setMode(started.sessionId, 'plan');
      await api.closeSession(started.sessionId);
      const history = await api.loadHistory(request);
      const replayStart = events.length;
      const resumed = await api.load(request, started.sessionId);
      const replayedHistory = events.slice(replayStart).some((event) => event?.type === 'session-update' && event?.payload?.update?.sessionUpdate === 'user_message_chunk');
      const resumedPrompt = await api.prompt(resumed.sessionId, 'Electron resumed ACP E2E');
      const artifact = await api.previewArtifact('artifact.txt');
      await api.closeSession(resumed.sessionId);
      if (verifySecretStore) {
        const providerIdentity = { ...request.provider };
        delete providerIdentity.apiKey;
        await api.forgetProviderSecret(providerIdentity);
        const afterForget = await api.getSettings();
        secretStoreVerified = secretStoreVerified && afterForget?.secret?.stored === false;
      }
      const text = events
        .filter((event) => event && event.type === 'session-update')
        .map((event) => event.payload?.update?.content?.text || '')
        .join('');
      return {
        brand,
        bridge: typeof api.start === 'function' && typeof api.prompt === 'function',
        sessionId: started.sessionId,
        stopReason: promptResult?.stopReason || '',
        listedSession: Array.isArray(listed?.sessions) && listed.sessions.some((row) => row.sessionId === started.sessionId),
        historySession: Array.isArray(history?.sessions) && history.sessions.some((row) => row.sessionId === started.sessionId),
        resumedSameSession: resumed.sessionId === started.sessionId && resumedPrompt?.stopReason === 'end_turn',
        replayedHistory,
        settingsRoundTrip: saved?.settings?.provider?.model === request.provider.model && loadedSettings?.settings?.allowNetwork === request.allowNetwork,
        artifactPreview: artifact?.text?.includes('DESKTOP_ARTIFACT_E2E') === true,
        secretStoreVerified,
        secretBackend,
        sessionUpdateText: text,
      };
    } finally { off(); }
  })()`);
  writeE2EResult(config, result);
}

/** Persist an Electron E2E failure so the parent smoke runner has deterministic evidence. */
export function writeDesktopElectronE2EFailure(config: DesktopElectronE2EConfig, error: unknown): void {
  fs.mkdirSync(require("node:path").dirname(config.resultFile), { recursive: true });
  fs.writeFileSync(config.resultFile, JSON.stringify({
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
}
