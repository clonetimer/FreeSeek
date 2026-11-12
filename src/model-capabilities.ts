import type { ProviderConfig } from "./providers";

export type ModelModality = "text" | "image" | "audio" | "file";

/** Explicit model-level capability declarations. Undefined means unknown, not unsupported. */
export interface ModelCapabilities {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  promptCaching?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
}


/** Resolve capability defaults plus model-level overrides. Unknown stays undefined. */
export function getModelCapabilities(provider: ProviderConfig, modelId: string): ModelCapabilities {
  const model = provider.models.find((entry) => entry.id === modelId);
  return {
    ...(provider.capabilities ?? {}),
    ...(model?.capabilities ?? {}),
    ...((model?.capabilities?.contextWindow ?? provider.contextWindow) !== undefined
      ? { contextWindow: model?.capabilities?.contextWindow ?? provider.contextWindow }
      : {}),
  };
}


/** Human-readable capability summary; omitted fields are deliberately not guessed. */
export function modelCapabilitySummary(provider: ProviderConfig, modelId: string): string {
  const caps = getModelCapabilities(provider, modelId);
  const parts = [provider.name];
  if (caps.tools !== undefined) parts.push(caps.tools ? "Tools" : "No tools");
  if (caps.vision !== undefined) parts.push(caps.vision ? "Vision" : "No vision");
  if (caps.reasoning !== undefined) parts.push(caps.reasoning ? "Reasoning" : "No reasoning");
  if (caps.structuredOutput !== undefined) parts.push(caps.structuredOutput ? "Structured output" : "No structured output");
  if (caps.inputModalities?.length) parts.push(`In: ${caps.inputModalities.join("/")}`);
  if (caps.outputModalities?.length) parts.push(`Out: ${caps.outputModalities.join("/")}`);
  if (caps.contextWindow !== undefined) parts.push(`${caps.contextWindow.toLocaleString()} context`);
  if (caps.maxOutputTokens !== undefined) parts.push(`${caps.maxOutputTokens.toLocaleString()} max output`);
  return parts.join(" · ");
}

