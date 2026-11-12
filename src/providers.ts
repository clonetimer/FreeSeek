// check:max-lines 680 (略超 600，纳入后续拆分)
import { cachedProviderSecret } from "./provider-secrets";
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_OFFICIAL_BASE_URL } from "./deepseek";
import { getModelCapabilities, modelCapabilitySummary } from "./model-capabilities";
import type { ModelCapabilities } from "./model-capabilities";
import { inferTaskProfile } from "./provider-task-profile";
import type { TaskProfile } from "./provider-task-profile";
export { getModelCapabilities, modelCapabilitySummary, inferTaskProfile };
export type { ModelCapabilities, ModelModality, TaskProfile };

export interface ProviderSettingsHost {
  get<T>(key: string, fallback: T): T;
  getAbsolute<T>(key: string, fallback: T): T;
  update?(key: string, value: unknown): void | PromiseLike<void>;
}

let explicitSettingsHost: ProviderSettingsHost | null = null;

/** Headless/测试注入 Provider 配置宿主；传 null 恢复 VS Code 默认宿主。 */
export function configureProviderSettingsHost(host: ProviderSettingsHost | null): void {
  explicitSettingsHost = host;
}

function settingsHost(): ProviderSettingsHost {
  if (explicitSettingsHost) return explicitSettingsHost;
  const vscode = require("vscode") as typeof import("vscode");
  const scoped = vscode.workspace.getConfiguration("freesek");
  return {
    get: <T>(key: string, fallback: T) => scoped.get<T>(key, fallback),
    getAbsolute: <T>(key: string, fallback: T) => vscode.workspace.getConfiguration().get<T>(key, fallback),
    update: (key: string, value: unknown) => scoped.update(key, value, vscode.ConfigurationTarget.Global),
  };
}

/**
 * 多提供商 / 多模型管理（参照 cc-switch 思路）。
 *
 * 设计：
 * - 所有提供商集中在 `freesek.providers` 设置（数组），每项含多个模型；
 * - 当前选中的 {providerId, modelId} 存于 `freesek.activeModel`（settings，全局持久）；
 * - apiKey 支持 `${env:VAR}` 与 `${setting:freesek.xxx}` 插值，避免明文写入；
 * - toolMode：native = 走原生 function calling（官方/兼容服务），react = 走 ReAct 文本协议
 *   （免费逆向服务等不支持 tools 的服务，由 agent.ts 解析 <tool_call> 块）。
 */


export interface ModelEntry {
  id: string;
  name?: string;
  /** Model-specific capability overrides; these take precedence over provider defaults. */
  capabilities?: ModelCapabilities;
  /**
   * Auto 路由档次（可选）。未设置时按 name/id 启发式识别。
   *  - flagship：顶级旗舰（GPT-5/Opus/Sonnet 5 等），贵且强
   *  - pro    ：次旗舰（GPT-5.5/Pro 等）
   *  - flash  ：速度优先小模型（Flash/MiniMax/Haiku）
   *  - lite   ：最低成本（mini/nano/flash-lite）
   *  - default：无法归类时的兜底
   */
  tier?: "flagship" | "pro" | "flash" | "lite" | "default";
  /**
   * Auto 路由弱化分数（可选）：0~10，越大越不优选。用于把昂贵的旗舰模型在 Auto 模式下
   * 尽量降权。CodeBuddy 截图里 0.05x / 0.13x 即这种"积分倍速"暗示。
   */
  costScore?: number;
  /** 模型擅长的任务标签（Auto 路由匹配权重），未设置则按 name 启发式。 */
  strengths?: Array<"code" | "reason" | "vision" | "tools" | "chat" | "long">;
}

export type ProviderFormat = "openai" | "responses" | "claude" | "gemini";
export type AuthType = "none" | "bearer" | "x-api-key" | "x-goog-api-key";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  toolMode?: "native" | "react";
  models: ModelEntry[];
  /** Provider-level capability defaults; model.capabilities overrides individual fields. */
  capabilities?: ModelCapabilities;
  /** Responses API only: explicitly allow server-side response storage. Defaults to false. */
  storeResponses?: boolean;
  /** 标记是否为默认提供（仅用于 UI 提示，不影响逻辑） */
  builtin?: boolean;
  /**
   * API 协议格式（决定请求体/流解析），默认 openai：
   *  - openai：/chat/completions（OpenAI-compatible 网关）
   *  - responses：/responses（OpenAI Responses API，独立于 Chat Completions）
   *  - claude：/v1/messages + x-api-key + anthropic-version
   *  - gemini：v1beta generateContent + x-goog-api-key
   */
  format?: ProviderFormat;
  /**
   * 认证头方式，默认 bearer。无认证本地服务使用 none；claude 建议 x-api-key，gemini 建议 x-goog-api-key。
   * 自定义：用 headers 自行覆盖则优先。
   */
  authType?: AuthType;
  /** 自定义附加请求头（支持 ${env:VAR} / ${setting:...} 插值）。会覆盖默认认证头。 */
  headers?: Record<string, string>;
  /** 额外请求体参数透传（如 temperature 之外的供应商专属字段），在构造 body 时合并。 */
  extraBody?: Record<string, unknown>;
  /**
   * 自动发现模型：为 true 时（适合 LM Studio / Ollama 等本地服务），启动/刷新时调用其
   * OpenAI 兼容的 `/v1/models` 端点拉取当前所有已加载模型，动态填充 models 列表，
   * 无需手动把每个模型 id 写进配置。
   */
  autoDiscoverModels?: boolean;
  /**
   * 模型实际上下文窗口（token 数）。本地小模型（如 LM Studio 8K/16K 窗口）常远小于
   * 默认的 32K 压缩预算，导致请求已超出窗口才压缩、直接被服务端拒绝。
   * 设置后：① 上下文压缩按 min(contextBudget, contextWindow) 触发；
   * ② 收到 exceed_context_size 类错误时按此窗口做截断重试。
   */
  contextWindow?: number;
  /**
   * Prompt Caching（提示词缓存）：多轮对话时对固定的 system/工具前缀打缓存断点，
   * 命中后输入 token 按折扣计费，降低多轮成本。默认开启。
   *  - claude：对 system 块加 cache_control（Anthropic 原生支持）
   *  - openai：对首条 user 消息加 "cache" 标记（DeepSeek/OpenAI 等兼容）
   *  - gemini：不支持，自动忽略
   * 设 false 可关闭（某些中转/本地服务不支持缓存字段，可能会拒绝或忽略）。
   */
  promptCache?: boolean;
}

export interface ActiveSelection {
  providerId: string;
  modelId: string;
}

/** Auto（智能选择）模式标记：对齐 CodeBuddy 模型面板默认选项，由 FreeSeek 自动路由模型。 */
export const AUTO_PROVIDER_ID = "__auto__";
export const AUTO_MODEL_ID = "__auto__";

/** Auto 路由的任务画像：调用方根据本次请求推断，传给 getActiveProvider/profile，
 *  路由模块据此挑选最合适的「已配置 key + 任务匹配 + 性价比优」的 provider/model。 */
export type TaskProfile = "chat" | "code" | "reason" | "vision" | "tools" | "long";

/** 从对话历史推断任务画像（用于 Auto 模式路由）。优先看最近一条 user 消息；
 *  - 看到图片 → vision；看到工具调用链 → tools；包含 "<think>" / "推理" / 数学 → reason；
 *  - 提到代码关键词或 read_file / grep 类上下文 → code；长上下文（>8K）→ long；
 *  - 其它 → chat（默认）。 */
export function inferTaskProfile(messages: "native" | "react";
  format: ProviderFormat;
  authType: AuthType;
  /** 合并后的最终请求头 */
  headers: Record<string, string>;
  /** 额外请求体参数（透传） */
  extraBody: Record<string, unknown>;
  /** 模型实际上下文窗口（token 数），未配置则为 undefined */
  contextWindow?: number;
  /** 是否启用 Prompt Caching（默认 true） */
  promptCache: boolean;
  /** Responses API server-side response storage; defaults to false (local-first). */
  storeResponses: boolean;
  /** Provider defaults merged with model-specific capability overrides. Undefined fields remain unknown. */
  capabilities: ModelCapabilities;
}

/**
 * 模型覆盖（多模型分工）：子智能体 / 局部调用可用指定的 provider/model，
 * 而不触碰全局活动模型（freesek.activeModel）。providerId 支持 id 或名称；
 * modelId 支持 id 或名称（解析见 pickModelId）。两者均可省略：省略 providerId
 * 时在活动 provider 上应用 modelId；省略 modelId 时用该 provider 的默认模型。
 */
export interface ModelOverride {
  providerId?: string;
  modelId?: string;
}

/** 读取设置中的提供商列表；为空则回退到旧的 free/official 单开关配置。 */
export function getProviders(): ProviderConfig[] {
  const cfg = settingsHost();
  const list = cfg.get<ProviderConfig[]>("providers", []);
  const result = Array.isArray(list) && list.length > 0 ? list : buildLegacyProviders();
  // 自动发现模型（LM Studio / Ollama 等本地服务）：对标记 autoDiscoverModels 的 provider 后台拉取 /v1/models
  for (const p of result) {
    if (p.autoDiscoverModels) void refreshDiscoveredModels(p);
  }
  return result;
}

/** 已发现模型的内存缓存（providerId → 模型列表），避免每次重复 fetch。 */
const discoveredCache = new Map<string, { at: number; models: { id: string; name?: string }[] }>();

export interface ModelProbeResult {
  models?: string[];
  error?: string;
}

/**
 * 探测 OpenAI 兼容 /models 接口（fetch_models / test_connection / autoDiscover 三处共用的单一实现）。
 *
 * 各家 base 前缀不统一（DeepSeek/智谱 已指向版本根 → `${base}/models`；
 * 硅基流动/OpenRouter/Moonshot/通义/混元/OpenAI 等 base 含 /v1 → 列表仍为 `${base}/models`），
 * 故 base 不含任何版本段时才补试 `${base}/v1/models`，避免生成 /v1/v1/models 这类必 404 的请求。
 * 每个候选 timeoutMs 超时（默认 8s），任一候选成功即返回模型列表。
 *
 * mode="list"：所有失败都换路径重试，最后统一报错；
 * mode="test"：401 视为「路径正确但 Key 无效」立即定论；其余非 2xx 一律尝试下一个候选路径
 * （不再仅限 404），避免首个候选返回其它非 2xx 时被提前截断而漏掉正确路径。
 */
export async function probeModelList(
  base: string,
  apiKey: string,
  opts: { mode?: "list" | "test"; timeoutMs?: number } = {}
): Promise<ModelProbeResult> {
  const mode = opts.mode ?? "list";
  const timeoutMs = opts.timeoutMs ?? 8000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const hasVersion = /(^|\/)(v\d+)(\/|$)/.test(base);
  const candidates = hasVersion ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
  let lastErr = "";
  for (const url of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 401) {
        if (mode === "test") {
          return { error: `接口路径正确，但 API Key 无效或缺失（HTTP 401）。请检查 Key。` };
        }
        lastErr = `HTTP 401（${res.statusText || ""}）@ ${url}`;
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}（${res.statusText || ""}）@ ${url}`;
        // 401 是强信号：路径可达但 Key 无效，无需再试候选路径，直接明确提示
        if (res.status === 401) {
          return { error: `接口路径正确，但 API Key 无效或缺失（HTTP 401）。请检查 Key。` };
        }
        // test 模式：非 2xx 一律尝试下一个候选路径（不再仅限 404），
        // 避免首个候选返回其它非 2xx 时被提前截断而漏掉正确路径
        if (mode === "test") continue;
        continue;
      }
      const data: any = await res.json();
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      const models = arr
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((s: any): s is string => typeof s === "string" && !!s.trim())
        .map((s: string) => s.trim());
      if (!models.length) {
        lastErr = `接口未返回模型列表 @ ${url}`;
        continue;
      }
      return { models };
    } catch (e: any) {
      clearTimeout(timer);
      lastErr = `${e?.message ?? String(e)} @ ${url}`;
    }
  }
  return { error: lastErr };
}

/**
 * 自动发现模型：调用 OpenAI 兼容的 {baseUrl}/models 拉取服务端当前所有已加载模型，
 * 合并进 freesek.providers 配置（best-effort，失败静默）。用于 LM Studio 等本地服务，
 * 让 FreeSeek 能选择所有已加载模型，而非只能手动写死的一个。
 * 探测核心复用 probeModelList（与 fetch_models / test_connection 同一套逻辑）。
 */
export async function refreshDiscoveredModels(provider: ProviderConfig): Promise<void> {
  // 防抖：60s 内不重复发现
  const cached = discoveredCache.get(provider.id);
  if (cached && Date.now() - cached.at < 60000) return;
  try {
    const apiKey = interpolateSecret(provider.apiKey);
    const r = await probeModelList(provider.baseUrl, apiKey, { mode: "list" });
    if (!r.models || !r.models.length) return;
    const models = r.models.map((id) => ({ id }));
    discoveredCache.set(provider.id, { at: Date.now(), models });

    // 合并进配置：把发现的模型与已配置的 models 去重合并，写回 freesek.providers
    const cfg = settingsHost();
    const list = cfg.get<ProviderConfig[]>("providers", []);
    const idx = list.findIndex((p) => p.id === provider.id);
    if (idx >= 0) {
      const existing = list[idx].models || [];
      const merged = mergeModels(existing, models);
      // 仅在模型集有变化时写回，避免无谓的配置更新
      if (merged.length !== existing.length) {
        const next = list.slice();
        next[idx] = { ...list[idx], models: merged };
        await cfg.update?.("providers", next);
      }
    }
  } catch {
    /* 发现失败静默（本地服务未启动等） */
  }
}

/** 合并已有模型与发现模型（按 id 去重，保留已配置顺序，追加新发现的）。 */
function mergeModels(existing: Array<{ id: string; name?: string }>, discovered: Array<{ id: string; name?: string }>): Array<{ id: string; name?: string }> {
  const seen = new Set(existing.map((m) => m.id));
  const out = existing.slice();
  for (const d of discovered) {
    if (!seen.has(d.id)) {
      out.push(d);
      seen.add(d.id);
    }
  }
  return out;
}

/** 旧版 freesek.provider=free|official 的兼容映射。 */
function buildLegacyProviders(): ProviderConfig[] {
  const cfg = settingsHost();
  const official: ProviderConfig = {
    id: "deepseek-official",
    name: "DeepSeek 官方",
    baseUrl: cfg.get<string>("officialBaseUrl", DEEPSEEK_OFFICIAL_BASE_URL),
    apiKey: "${secret:freesek.legacy.officialApiKey}",
    toolMode: "native",
    models: [{ id: cfg.get<string>("officialModel", DEEPSEEK_DEFAULT_MODEL) }],
    builtin: true,
  };
  const free: ProviderConfig = {
    id: "deepseek-free",
    name: "FreeSeek 本地（逆向）",
    baseUrl: cfg.get<string>("freeBaseUrl", "http://127.0.0.1:8000/v1"),
    apiKey: "${secret:freesek.legacy.freeUserToken}",
    toolMode: "react",
    models: [{ id: cfg.get<string>("freeModel", "deepseek-chat") }],
    builtin: true,
  };
  return [official, free];
}

/** 把 ${env:VAR} / ${setting:freesek.xxx} / ${secret:key} 替换为真实值。 */
export function interpolateSecret(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/\$\{(setting|env|secret):([^}]+)\}/g, (_m, kind: string, key: string) => {
    const k = key.trim();
    if (kind === "env") return process.env[k] ?? "";
    if (kind === "secret") return cachedProviderSecret(k);
    return settingsHost().getAbsolute<string>(k, "") ?? "";
  });
}

export function getActiveSelection(): ActiveSelection | null {
  return settingsHost().get<ActiveSelection | null>("activeModel", null);
}

export function setActiveSelection(sel: ActiveSelection): void {
  void settingsHost().update?.("activeModel", sel);
}

/**
 * 计算当前生效的 {provider, modelId}。
 * Auto（智能选择）模式：按 taskProfile（chat/code/reason/vision/tools/long）智能路由——
 *  1. 已配置 API Key 的 provider 优先；
 *  2. 模型 strengths 与 profile 强匹配加分；
 *  3. costScore 越大越降权（便宜的优先）；
 *  4. tier 越强越优选（兜底）。
 * 失败回退：按"已配置 key 且 models 非空"的第一个 provider 兜底。
 */
export function getActiveProvider(profile?: TaskProfile): { provider: ProviderConfig; modelId: string } | null {
  const providers = getProviders();
  if (!providers.length) return null;
  const sel = getActiveSelection();
  // 显式选择 → 不走 Auto 路由，直接按用户选择返回
  if (sel && !isAutoSelection(sel)) {
    const p = providers.find((x) => x.id === sel.providerId);
    if (p) {
      const m = p.models.find((x) => x.id === sel.modelId);
      return { provider: p, modelId: m ? sel.modelId : p.models[0]?.id ?? "" };
    }
    return { provider: providers[0], modelId: providers[0].models[0]?.id ?? "" };
  }
  // Auto / 未显式选择 → 智能路由
  const picked = pickAutoProvider(providers, profile);
  if (picked) return picked;
  return { provider: providers[0], modelId: providers[0].models[0]?.id ?? "" };
}

/** Auto 路由：评分 = 任务匹配分 - 成本分。返回最高分或 null（无可用 provider）。 */
function pickAutoProvider(providers: ProviderConfig[], profile?: TaskProfile): { provider: ProviderConfig; modelId: string } | null {
  // 仅考虑已配置 API Key 的 provider
  const configured = providers.filter((p) => interpolateSecret(p.apiKey).trim().length > 0);
  if (!configured.length) return null;
  let best: { provider: ProviderConfig; modelId: string; score: number } | null = null;
  for (const p of configured) {
    for (const m of p.models) {
      if (!m.id) continue;
      const score = scoreAutoCandidate(p, m, profile);
      if (!best || score > best.score) {
        best = { provider: p, modelId: m.id, score };
      }
    }
  }
  return best ? { provider: best.provider, modelId: best.modelId } : null;
}

/** 单个 provider × model 的 Auto 评分（越大越优选）。 */
function scoreAutoCandidate(provider: ProviderConfig, model: ModelEntry, profile?: TaskProfile): number {
  const tier = model.tier ?? guessTierFromName(model.id || model.name || "");
  const strengths = model.strengths && model.strengths.length > 0
    ? model.strengths
    : guessStrengthsFromName(model.id || model.name || "", provider);
  const cost = typeof model.costScore === "number" ? model.costScore : guessCostScoreFromTier(tier);
  // 任务匹配：strengths 含 profile 加 50 分；否则 0
  let taskFit = 0;
  if (profile && strengths && strengths.includes(profile)) taskFit += 50;
  // 任务 × 档位偏好：reason/code 类高难度任务优先中高档；chat/long 类宽容 flash/lite
  const tierPref = tierPreferenceForProfile(profile, tier);
  // 基础分
  const base = tierBase(tier);
  return taskFit + tierPref + base - cost;
}

function tierPreferenceForProfile(profile: TaskProfile | undefined, tier: ModelEntry["tier"]): number {
  if (!profile) return 0;
  const t: Record<TaskProfile, Record<string, number>> = {
    chat:      { lite: 20, flash: 15, default: 10, pro: -10, flagship: -10 },
    long:      { flagship: 20, pro: 15, default: 10, flash: -5, lite: -5 },
    code:      { flagship: 25, pro: 20, default: 5, flash: -15, lite: -15 },
    reason:    { flagship: 25, pro: 20, default: 5, flash: -15, lite: -15 },
    vision:    { flagship: 15, pro: 12, default: 8, flash: 0, lite: 0 },
    tools:     { flagship: 15, pro: 12, default: 8, flash: 0, lite: 0 },
  };
  const key = tier || "default";
  return t[profile][key] ?? 0;
}

function tierBase(tier: ModelEntry["tier"]): number {
  const map: Record<string, number> = {
    flagship: 10,
    pro: 5,
    default: 0,
    flash: -5,
    lite: -10,
  };
  return map[tier || "default"] ?? 0;
}

function guessCostScoreFromTier(tier: ModelEntry["tier"]): number {
  const map: Record<string, number> = {
    flagship: 9,
    pro: 6,
    default: 3,
    flash: 1,
    lite: 0,
  };
  return map[tier || "default"] ?? 3;
}

/** 从 name/id 启发式识别 tier（用户没显式标注 ModelEntry.tier 时用）。 */
function guessTierFromName(name: string): ModelEntry["tier"] {
  const n = name.toLowerCase();
  if (/gpt-6-astra|opus|sonnet\s*5|gpt-5(\.5)?\b|gpt-4\b|qwen-max|deepseek-v4-pro|deepseek-r1|reasoner|thinking|pro$|hi$|high$/.test(n)) return "flagship";
  if (/gpt-6\.1-sol|pro\b|plus\b|3-5\b|deepseek-v4\b(?!-flash|-pro)/.test(n)) return "pro";
  if (/gpt-6\.1-terra|flash\b|mini\b|haiku\b|turbo\b|fast\b|small\b|deepseek-v3\b/.test(n)) return "flash";
  if (/gpt-6-luna|nano\b|lite\b|mini-mini\b|air\b|qwen-turbo\b/.test(n)) return "lite";
  return "default";
}

/** 从 name/id 启发式识别 strengths（未显式标注时）。 */
function guessStrengthsFromName(name: string, provider: ProviderConfig): Array<"code" | "reason" | "vision" | "tools" | "chat" | "long"> {
  const n = name.toLowerCase();
  const s = new Set<"code" | "reason" | "vision" | "tools" | "chat" | "long">();
  if (/code|coder|codex|kimi-k2|qwen-coder|deepseek-coder|devstral/.test(n)) s.add("code");
  if (/reason|thinking|pro|opus|deepseek-r1|qwen-qwq|o1|o3|math|qwq|gpt-6/.test(n)) s.add("reason");
  if (/vision|vl|gpt-4o|gpt-6|sonnet|gemini|qwen-vl|see|look|image|flash-lite|grounding/.test(n)) s.add("vision");
  if (/tools|tool|function|agent|claude|codex|gpt-5\b|qwen-max|deepseek-v4/.test(n)) s.add("tools");
  if (/long|200k|1m|1mo|claude|gemini|opus|qwen-long|gpt-6/.test(n)) s.add("long");

  // Explicit capability declarations refine (and can negate) name-based hints.
  const model = provider.models.find((entry) => entry.id === name);
  const capabilities = { ...(provider.capabilities ?? {}), ...(model?.capabilities ?? {}) };
  const applyCapability = (field: "reasoning" | "vision" | "tools", strength: "reason" | "vision" | "tools") => {
    if (capabilities[field] === true) s.add(strength);
    else if (capabilities[field] === false) s.delete(strength);
  };
  applyCapability("reasoning", "reason");
  applyCapability("vision", "vision");
  applyCapability("tools", "tools");
  if (capabilities.vision !== false && capabilities.inputModalities?.includes("image")) s.add("vision");
  if ((capabilities.contextWindow ?? provider.contextWindow ?? 0) >= 200_000) s.add("long");
  if (s.size === 0) s.add("chat");
  s.add("chat");
  return Array.from(s);
}

/** 按 provider 的协议格式拼接完整请求端点。 */
function buildEndpoint(base: string, format: ProviderFormat, model: string): string {
  switch (format) {
    case "responses":
      return `${base}/responses`;
    case "claude":
      return `${base}/v1/messages`;
    case "gemini":
      return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    default:
      return `${base}/chat/completions`;
  }
}

/** 构造请求头：默认认证头（按 authType）+ claude 必要头 + 自定义 headers（覆盖优先级最高）。 */
function buildHeaders(provider: ProviderConfig, apiKey: string, format: ProviderFormat, authType: AuthType): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey && authType !== "none") {
    if (authType === "x-api-key") headers["x-api-key"] = apiKey;
    else if (authType === "x-goog-api-key") headers["x-goog-api-key"] = apiKey;
    else headers["authorization"] = `Bearer ${apiKey}`;
  }
  if (format === "claude" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  // 自定义头覆盖/追加（支持插值）
  if (provider.headers) {
    for (const [k, v] of Object.entries(provider.headers)) {
      headers[k.toLowerCase()] = interpolateSecret(v);
    }
  }
  return headers;
}

/** 由「provider + modelId」构造完整接入配置（含 endpoint / 认证头 / 透传参数）。 */
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

export function buildResolvedConfig(provider: ProviderConfig, modelId: string): ResolvedConfig {
  const base = (provider.baseUrl || "").replace(/\/+$/, "");
  const format = provider.format ?? "openai";
  const authType = provider.authType ?? "bearer";
  const apiKey = interpolateSecret(provider.apiKey);
  const capabilities = getModelCapabilities(provider, modelId);
  return {
    providerId: provider.id,
    providerName: provider.name || provider.id,
    endpoint: buildEndpoint(base, format, modelId),
    apiKey,
    model: modelId,
    toolMode: provider.toolMode === "react" || capabilities.tools === false ? "react" : "native",
    format,
    authType,
    headers: buildHeaders(provider, apiKey, format, authType),
    extraBody: provider.extraBody ?? {},
    contextWindow: capabilities.contextWindow,
    promptCache: provider.promptCache !== false && capabilities.promptCaching !== false,
    storeResponses: provider.storeResponses === true,
    capabilities,
  };
}

/** 解析出当前要调用的接入配置（含完整 endpoint / 认证头 / 透传参数）。
 *  可选传入 taskProfile（Auto 路由用），省略则从 activeSource 推断。 */
export function resolveActiveConfig(
  profile?: TaskProfile,
  /** 带 image 字段的对话历史（用于 vision 自动识别），可省略 */
  messages?: ReadonlyArray<{ role: string; content?: string; images?: unknown[] }>
): ResolvedConfig {
  const active = getActiveProvider(profile const byName = provider.models.find((m) => m.name === want);
  if (byName) return byName.id;
  return want;
}

/**
 * 按覆盖指定解析配置（多模型分工的核心入口）：
 *  - 未传 override（或 providerId/modelId 均空）→ 等价 resolveActiveConfig(profile, messages)；
 *  - 指定 providerId（支持 id 或名称）→ 用该 provider + 默认/指定模型；
 *  - 仅指定 modelId → 在活动 provider 上应用（支持 id 或名称）；
 *  - 指定的 provider 不存在 → 回退活动 provider；仍无 → 首个 provider；全空 → 抛错（与 resolveActiveConfig 一致）。
 * 额外传 profile / messages：仅在 Auto 模式下生效，用于把不同任务路由到不同模型。
 */
export function resolveConfigFor(
  override?: ModelOverride,
  profile?: TaskProfile,
  messages?: ReadonlyArray<{ role: string; content?: string; images?: unknown[] }>
): ResolvedConfig {
  if (!override || (!override.providerId && !override.modelId)) return resolveActiveConfig(profile, messages);
  const providers = getProviders();
  const target = override.providerId
    ? providers.find((p) => p.id === override.providerId || p.name === override.providerId)
    : undefined;
  if (target) return buildResolvedConfig(target, pickModelId(target, override.modelId));
  const active = getActiveProvider();
  if (active) return buildResolvedConfig(active.provider, pickModelId(active.provider, override.modelId));
  if (providers.length) return buildResolvedConfig(providers[0], pickModelId(providers[0], override.modelId));
  throw new Error(
    "尚未配置任何提供商。请运行「FreeSeek: 添加提供商」向导，或在设置 freesek.providers 中填写。"
  );
}

/** 当前模型的展示标签，如「DeepSeek 官方 / DeepSeek Chat」；Auto 模式下显示「Auto（智能选择）」。 */
export function getActiveLabel(): string {
  const sel = getActiveSelection();
  if (isAutoSelection(sel)) return "Auto（智能选择）";
  const active = getActiveProvider();
  if (!active) return "未配置提供商";
  const { provider, modelId } = active;
  const m = provider.models.find((x) => x.id === modelId);
  const modelName = m?.name || m?.id || modelId;
  return `${provider.name || provider.id} / ${modelName}`;
}

/** 当前 provider 的工具调用模式（决定系统提示词是否追加 ReAct 协议）。 */
export function getActiveToolMode(): "native" | "react" {
  const active = getActiveProvider();
  if (!active) return "native";
  if (active.provider.toolMode === "react") return "react";
  return getModelCapabilities(active.provider, active.modelId).tools === false ? "react" : "native";
}

/** Human-readable capability summary; omitted fields are deliberately not guessed. */
function modelCapabilitySummary(provider: ProviderConfig, modelId: string): string {
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

/** 生成切换模型的 QuickPick 项（跨所有 provider 的所有模型）。 */
export function buildSwitchItems(): Array<{
  label: string;
  description: string;
  detail: string;
  providerId: string;
  modelId: string;
}> {
  const providers = getProviders();
  const sel = getActiveSelection();
  const items: Array<{
    label: string;
    description: string;
    detail: string;
    providerId: string;
    modelId: string;
  }> = [];
  // Auto（智能选择）：置顶，对齐 CodeBuddy 默认选项
  items.push({
    label: `${isAutoSelection(sel) ? "$(check) " : ""}Auto（智能选择）`,
    description: "__auto__",
    detail: "由 FreeSeek 自动挑选已配置密钥的可用服务",
    providerId: AUTO_PROVIDER_ID,
    modelId: AUTO_MODEL_ID,
  });
  for (const p of providers) {
    for (const m of p.models) {
      const isActive = sel && sel.providerId === p.id && sel.modelId === m.id;
      items.push({
        label: `${isActive ? "$(check) " : ""}${m.name || m.id}`,
        description: m.id,
        detail: modelCapabilitySummary(p, m.id),
        providerId: p.id,
        modelId: m.id,
      });
    }
  }
  return items;
}
