import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopProviderInput } from "./contracts";

export interface DesktopSafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

interface StoredSecretEnvelope {
  schemaVersion: 1;
  providerHash: string;
  ciphertext: string;
}

export interface DesktopSafeStorageStatus {
  secure: boolean;
  backend?: string;
}

/** Normalize Electron safeStorage semantics across supported desktop platforms. */
export function describeDesktopSafeStorage(
  safeStorage: DesktopSafeStorageAdapter,
  platform: NodeJS.Platform = process.platform,
): DesktopSafeStorageStatus {
  const available = safeStorage.isEncryptionAvailable();
  if (platform === "win32") return { secure: available, backend: "dpapi" };
  if (platform === "darwin") return { secure: available, backend: "keychain" };
  if (platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend?.();
    const secure = available && !!backend && backend !== "basic_text" && backend !== "unknown";
    return { secure, ...(backend ? { backend } : {}) };
  }
  return { secure: false };
}

/** Stable non-secret identity for matching a stored credential to provider configuration. */
export function desktopProviderIdentity(provider: Omit<DesktopProviderInput, "apiKey">): string {
  const canonical = JSON.stringify({
    baseUrl: provider.baseUrl.trim().replace(/\/+$/, ""),
    model: provider.model.trim(),
    format: provider.format,
    authType: provider.authType,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Main-process-only OS secret wrapper with fail-closed platform backend semantics. */
export class DesktopProviderSecretStore {
  constructor(readonly file: string, private readonly safeStorage: DesktopSafeStorageAdapter) {}

  /** Describe whether secrets may be persisted without exposing any secret material. */
  status(): DesktopSafeStorageStatus {
    return describeDesktopSafeStorage(this.safeStorage);
  }

  /** Whether a ciphertext exists for this exact provider identity. */
  has(provider: Omit<DesktopProviderInput, "apiKey">): boolean {
    const envelope = this.readEnvelope();
    return !!envelope && envelope.providerHash === desktopProviderIdentity(provider);
  }

  /** Encrypt and atomically persist one provider API key. */
  save(provider: Omit<DesktopProviderInput, "apiKey">, apiKey: string): void {
    if (!apiKey) return;
    const state = this.status();
    if (!state.secure) throw new Error(`OS-protected provider secret storage unavailable${state.backend ? ` (${state.backend})` : ""}`);
    const envelope: StoredSecretEnvelope = {
      schemaVersion: 1,
      providerHash: desktopProviderIdentity(provider),
      ciphertext: this.safeStorage.encryptString(apiKey).toString("base64"),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(envelope, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on Windows */ }
  }

  /** Decrypt the matching provider key only inside the main process. */
  load(provider: Omit<DesktopProviderInput, "apiKey">): string | undefined {
    const state = this.status();
    if (!state.secure) return undefined;
    const envelope = this.readEnvelope();
    if (!envelope || envelope.providerHash !== desktopProviderIdentity(provider)) return undefined;
    try { return this.safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64")); }
    catch { return undefined; }
  }

  /** Remove the stored ciphertext. */
  forget(provider: Omit<DesktopProviderInput, "apiKey">): void {
    const envelope = this.readEnvelope();
    if (!envelope || envelope.providerHash !== desktopProviderIdentity(provider)) return;
    fs.rmSync(this.file, { force: true });
  }

  private readEnvelope(): StoredSecretEnvelope | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredSecretEnvelope;
      if (raw?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(raw.providerHash) || typeof raw.ciphertext !== "string") return null;
      return raw;
    } catch { return null; }
  }
}
