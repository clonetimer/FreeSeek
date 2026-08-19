import type * as vscodeTypes from "vscode";

const secretCache = new Map<string, string>();

function providerSecretKey(providerId: string): string {
  return `freesek.provider.${providerId}.apiKey`;
}

/** 将 Provider 明文凭据迁入 VS Code SecretStorage，settings 只保留引用。 */
export async function storeProviderSecret(
  context: vscodeTypes.ExtensionContext,
  providerId: string,
  raw: string | undefined
): Promise<string> {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (/^\$\{(?:env|setting|secret):[^}]+\}$/.test(value)) return value;
  const key = providerSecretKey(providerId);
  await context.secrets.store(key, value);
  secretCache.set(key, value);
  return `\${secret:${key}}`;
}

/** 删除某 Provider 对应的 SecretStorage 凭据。 */
export async function deleteProviderSecret(context: vscodeTypes.ExtensionContext, providerId: string): Promise<void> {
  const key = providerSecretKey(providerId);
  secretCache.delete(key);
  await context.secrets.delete(key);
}

/** 只读获取已经在激活期加载进内存的 secret。 */
export function cachedProviderSecret(key: string): string {
  return secretCache.get(key) ?? "";
}

/** 激活时迁移旧明文 key，并加载 providers 中的 secret 引用。 */
export async function initializeProviderSecrets(context: vscodeTypes.ExtensionContext): Promise<void> {
  const vscode = require("vscode") as typeof import("vscode");
  const cfg = vscode.workspace.getConfiguration("freesek");
  const legacy: Array<[string, string]> = [
    ["freeUserToken", "freesek.legacy.freeUserToken"],
    ["officialApiKey", "freesek.legacy.officialApiKey"],
  ];
  for (const [setting, key] of legacy) {
    const current = cfg.get<string>(setting, "").trim();
    if (current) {
      await context.secrets.store(key, current);
      secretCache.set(key, current);
      await cfg.update(setting, "", vscode.ConfigurationTarget.Global);
    } else {
      const stored = await context.secrets.get(key);
      if (stored) secretCache.set(key, stored);
    }
  }

  const providers = (cfg.get<Array<Record<string, any>>>("providers", []) || []).map((p) => ({ ...p }));
  let changed = false;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const raw = String(p.apiKey ?? "").trim();
    const secretMatch = raw.match(/^\$\{secret:([^}]+)\}$/);
    if (secretMatch) {
      const key = secretMatch[1].trim();
      const stored = await context.secrets.get(key);
      if (stored) secretCache.set(key, stored);
      continue;
    }
    if (!raw || /^\$\{(?:env|setting):[^}]+\}$/.test(raw)) continue;
    p.apiKey = await storeProviderSecret(context, String(p.id || `provider-${i}`), raw);
    changed = true;
  }
  if (changed) await cfg.update("providers", providers, vscode.ConfigurationTarget.Global);
}
