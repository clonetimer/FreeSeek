/**
 * 用量成本估算（对标 Claude Code 的 /cost）。
 *
 * 不同 provider / 模型价格差异大，这里用「按 id 子串匹配」的价目表做近似估算
 * （单位：美元 / 每百万 token）。匹配不到时回退到 default。费用为 best-effort
 * 参考值，仅供状态栏展示，不作为精确账单。
 */

export interface Pricing {
  /** 输入（prompt）价格：美元 / 1M tokens */
  input: number;
  /** 输出（completion）价格：美元 / 1M tokens */
  output: number;
}

export const PRICING: Record<string, Pricing> = {
  // DeepSeek V4（input 使用 cache-miss 价格作保守估算）
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },
  // 旧别名仅为历史 report 兼容；上游已停止推荐使用。
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.14, output: 0.28 },
  // OpenAI（如经兼容端点接入）
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o3-mini": { input: 1.1, output: 4.4 },
  // Anthropic（经 Bedrock/兼容网关）
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-opus-4": { input: 15, output: 75 },
  // 通义 / 硅基流动等常见（近似）
  "qwen2.5-coder": { input: 0.3, output: 0.3 },
  "qwen-max": { input: 1.2, output: 1.2 },
  // 本地模型（无 API 费用）
  "local": { input: 0, output: 0 },
  "lm-studio": { input: 0, output: 0 },
  default: { input: 1, output: 2 },
};

/**
 * 按模型 id 估算成本（美元）。
 * 匹配策略：子串匹配但选「最长命中 key」——避免 `gpt-4o-mini` 被 `gpt-4o` 抢先
 * （原实现遇首匹配即 break，导致 mini 模型按旗舰价计费）。best-effort 近似。
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  let bestKey = "default";
  let bestLen = -1;
  for (const key of Object.keys(PRICING)) {
    if (key === "default") continue;
    if (key.length > bestLen && model.includes(key)) {
      bestKey = key;
      bestLen = key.length;
    }
  }
  const p = PRICING[bestKey];
  return (promptTokens / 1e6) * p.input + (completionTokens / 1e6) * p.output;
}
