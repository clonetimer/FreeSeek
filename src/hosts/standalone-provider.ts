import {
  configureProviderSettingsHost,
  type ActiveSelection,
  type AuthType,
  type ProviderConfig,
  type ProviderFormat,
} from "../providers";

/** Provider settings shared by non-VS-Code hosts (CLI, ACP, eval-style embeddings). */
export interface StandaloneProviderOptions {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ProviderFormat;
  toolMode: "native" | "react";
  authType: AuthType;
}

/** Install one process-local provider without importing VS Code configuration APIs. */
export function configureStandaloneProvider(options: StandaloneProviderOptions): void {
  const provider: ProviderConfig = {
    id: options.id,
    name: options.name,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    toolMode: options.toolMode,
    format: options.format,
    authType: options.authType,
    models: [{ id: options.model }],
  };
  const active: ActiveSelection = { providerId: provider.id, modelId: options.model };
  const values = new Map<string, unknown>([["providers", [provider]], ["activeModel", active]]);
  configureProviderSettingsHost({
    get: <T>(key: string, fallback: T) => (values.has(key) ? values.get(key) as T : fallback),
    getAbsolute: <T>(_key: string, fallback: T) => fallback,
    update: (key: string, value: unknown) => { values.set(key, value); },
  });
}
