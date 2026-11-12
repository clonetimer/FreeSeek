// check:max-lines 640 (待拆分：streamChat/idle 看门狗/非流式辅助调用拆出后减小；v0.17.8 新增 streamChatWithIdleTimeout 后上升)
import { resolveActiveConfig, resolveConfigFor, ResolvedConfig, ModelOverride, TaskProfile } from "./providers";
import { debugLogRequest, debugLogAux, debugWarn } from "./debug";
import { streamResponses, completeResponsesText } from "./provider-responses";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** DeepSeek 等思考模型的 reasoning 内容；发生 tool call 时后续轮次必须原样回传。 */
  reasoning_content?: string;
  /** Responses API 原始输出项；用于无服务端状态存储时精确恢复 reasoning/tool-call 上下文。 */
  responses_output_items?: unknown[];
  /** Responses API assistant message phase，后续请求时原样保留。 */
  responses_phase?: "commentary" | "final_answer";
  /** 多模态图片（base64 data URL 数组）。仅对支持视觉的 provider 有意义；组装 body 时转成协议对应格式。 */
  images?: string[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamHandlers {
  onText: (delta: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
  onReasoning?: (delta: string) => void;
  /** 用量回调：开启 stream_options.include_usage 后，最终分片携带 usage，best-effort 上报真实 token。 */
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  signal?: AbortSignal;
}

/**
 * 调用 OpenAI 兼容的 /chat/completions（流式）。
 * 免费服务（deepseek-free-api）与官方 API 都兼容此协议，
 * 因此同一套代码两种 provider 通用。
 */
export async function streamChat(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  handlers: StreamHandlers,
  /** 多模型分工：指定本次调用使用的 provider/model（子智能体用），省略则用 Auto 路由 */
  override?: ModelOverride,
  /** Auto 路由专用：任务画像；省略则从 messages 推断。可显式覆盖。 */
  profile?: TaskProfile
): Promise<{ message: ChatMessage; finishReason: string }> {
  const cfg = override
    ? resolveConfigFor(override, profile, messages)
    : resolveActiveConfig(profile, messages);
  if (cfg.capabilities.vision === false && messages.some((message) => message.images?.length)) {
    throw new Error(`Model "${cfg.model}" is configured without vision capability but the conversation contains images.`);
  }
  if (!cfg.apiKey && cfg.authType !== "none") {
    const hint =
      cfg.toolMode === "react"
        ? "当前（实验性 Web 兼容）提供商尚未配置 userToken。请在 FreeSeek Provider 设置界面保存凭据（会写入 VS Code SecretStorage），或在 freesek.providers 中把 apiKey 设为 ${env:YOUR_TOKEN} 引用的环境变量。"
        : "当前提供商尚未配置 API Key。请在 FreeSeek Provider 设置界面保存凭据（会写入 VS Code SecretStorage），或使用 ${env:YOUR_KEY} 引用环境变量。";
    throw new Error(hint);
  }

  if (cfg.format === "responses") {
    return streamResponses(cfg, messages, tools, handlers);
  }

  const body = buildChatBody(cfg, messages, tools);
  // 调试日志：请求概要 + tool 配对预检（debugVerbose 开启时输出完整请求体）
  debugLogRequest({
    provider: cfg.providerName,
    model: cfg.model,
    endpoint: cfg.endpoint,
    messages,
    toolsCount: tools.length,
    tag: `format=${cfg.format} toolMode=${cfg.toolMode}`,
    fullBody: body,
  });

  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: cfg.headers,
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!res.ok || !res.body) {
    const text = res.body ? await readAll(res.body) : await res.text();
    debugWarn(`模型服务返回 ${res.status}：${text.slice(0, 4000)}`);
    debugWarn(`  ↑ 若为 400 "tool must be a response to preceding tool_calls"，请对照上方请求概要与配对预检。`);
    throw new Error(`模型服务返回 ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 流式累积器：openai/claude/gemini 三种格式共用。
  // 注意 claude/gemini 的解析函数按引用修改此对象——此前传「对象字面量」导致值拷贝、
  // 外部变量不更新（历史正文/用量丢失的 bug），这里必须传同一对象引用。
  const acc: {
    assistantText: string;
    reasoningText: string;
    finishReason: string;
    lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  } = {
    assistantText: "",
    reasoningText: "",
    finishReason: "stop",
    lastUsage: null,
  };
  // 累积工具调用（流式分片，需要按 index 拼接）
  const toolAcc = new Map<number, ToolCall>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      // 按协议格式解析 SSE 事件
      if (cfg.format === "claude") {
        parseClaudeLine(trimmed, acc, handlers);
        continue;
      }
      if (cfg.format === "gemini") {
        parseGeminiLine(trimmed, acc, handlers);
        continue;
      }
      // openai 格式
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage && typeof json.usage === "object") {
        acc.lastUsage = {
          prompt_tokens: json.usage.prompt_tokens ?? 0,
          completion_tokens: json.usage.completion_tokens ?? 0,
          total_tokens: json.usage.total_tokens ?? 0,
        };
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) acc.finishReason = choice.finish_reason;

      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string") {
        acc.reasoningText += delta.reasoning_content;
        handlers.onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === "string") {
        acc.assistantText += delta.content;
        handlers.onText(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolAcc.has(idx)) {
            toolAcc.set(idx, {
              id: tc.id ?? `call_${idx}`,
              type: "function",
              // 首分片也统一走下方 append；这里必须从空串开始，否则 function.name 会重复一次。
              function: { name: "", arguments: "" },
            });
          }
          const cur = toolAcc.get(idx)!;
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = Array.from(toolAcc.values());
  if (toolCalls.length > 0) handlers.onToolCalls?.(toolCalls);
  if (acc.lastUsage) handlers.onUsage?.(acc.lastUsage);

  const message: ChatMessage = {
    role: "assistant",
    content: acc.assistantText,
  };
  if (acc.reasoningText) message.reasoning_content = acc.reasoningText;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return { message, finishReason: acc.finishReason };
}

/** 按协议格式构造请求体。openai/claude/gemini 结构不同。 */
/**
 * 按 provider format 组装 /chat/completions 请求体（openai / claude / gemini）。
 * 纯函数：便于单测（SSE 解析与 body 组装是错误高发区）。
 */
export function buildChatBody(cfg: ResolvedConfig, messages: ChatMessage[], tools: ToolDefinition[]): Record<string, unknown> {
  if (cfg.format === "responses") {
    throw new Error("Responses API requests must use the dedicated streamResponses adapter.");
  }
  const base: Record<string, unknown> = {};
  // 透传供应商专属额外参数（extraBody 优先级最低，被下方标准字段覆盖）
  Object.assign(base, cfg.extraBody);

  if (cfg.format === "claude") {
    // Anthropic /v1/messages：system 单独提出来，其余按 role 组装
    const systemParts: string[] = [];
    const conv: any[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
      } else if (m.role === "assistant") {
        const c = (m.content ?? "").toString();
        const blocks: any[] = [];
        if (c) blocks.push({ type: "text", text: c });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            let input: any = {};
            try {
              input = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch {
              input = {};
            }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
          }
        }
        conv.push({ role: "assistant", content: blocks });
      } else if (m.role === "tool") {
        const c = (m.content ?? "").toString();
        conv.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: c }],
        });
      } else {
        conv.push({ role: "user", content: m.content });
      }
    }
    // Prompt Caching：system 必须是块数组才能挂 cache_control（Anthropic 原生，
    // 固定 system 前缀在长任务/多轮中命中缓存，输入 token 按折扣计费）。
    let system: any = systemParts.join("\n\n");
    if (cfg.promptCache && system) {
      system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    }
    return {
      ...base,
      model: cfg.model,
      max_tokens: Math.min(Math.max((cfg.extraBody.max_tokens as number) ?? 4096, 256), 32000),
      system,
      messages: conv,
      stream: true,
    };
  }

  if (cfg.format === "gemini") {
    // Google Gemini generateContent：contents + systemInstruction + generationConfig
    const contents: any[] = [];
    let sysText = "";
    for (const m of messages) {
      if (m.role === "system") {
        sysText += m.content + "\n";
      } else {
        const role = m.role === "assistant" ? "model" : "user";
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        if (m.images?.length) {
          for (const img of m.images) {
            const match = img.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
            if (match) {
              parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
            }
          }
        }
        contents.push({ role, parts });
      }
    }
    return {
      ...base,
      contents,
      ...(sysText ? { systemInstruction: { parts: [{ text: sysText.trim() }] } } : {}),
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      stream: true,
    };
  }

  // openai 兼容
  const openaiMessages = messages.map(stripUndefined);
  // Prompt Caching：部分 openai 兼容网关（DeepSeek/OpenAI 等）支持在消息上加 "cache" 标记，
  // 命中后多轮固定前缀按折扣计费。不支持的服务会忽略该字段，安全无害。
  if (cfg.promptCache && openaiMessages.length > 0) {
    const first = openaiMessages[0];
    if (first && first.role === "system") {
      openaiMessages[0] = { ...first, cache: true };
    }
  }
  const body: Record<string, unknown> = {
    ...base,
    model: cfg.model,
    messages: openaiMessages,
    stream: true,
    temperature: 0.7,
    stream_options: { include_usage: true },
  };
  // 默认给出较充分的 max_tokens：推理模型（DeepSeek-R1/Qwen3 等）会先把额度花在
  // reasoning_content 上，额度太小会导致"一直在思考、content 为空"（finish_reason=length）。
  // 允许通过 extraBody.max_tokens 覆盖；未设置时给一个默认值，保证思考后还能输出正文。
  if (body.max_tokens == null) {
    body.max_tokens = (cfg.extraBody.max_tokens as number) ?? 4096;
  }
  // deepseek-free-api 与官方都支持 tools 参数（官方原生；免费服务新版也已支持）。
  if (tools.length > 0 && cfg.toolMode === "native" && cfg.capabilities.tools !== false) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

/** 解析单条 Anthropic SSE 事件（event: content_block_delta / message_delta / ...）。 */
/** 解析单条 Claude SSE 事件（content_block_delta / message_delta），累计文本、思维链与用量。 */
export function parseClaudeLine(
  trimmed: string,
  acc: { assistantText: string; reasoningText: string; finishReason: string; lastUsage: any },
  handlers: StreamHandlers
): void {
  let data = trimmed;
  if (trimmed.startsWith("data:")) data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]" || data.startsWith("event:")) return;
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  const type = json.type;
  if (type === "content_block_delta") {
    const d = json.delta ?? {};
    if (d.type === "text_delta" && typeof d.text === "string") {
      acc.assistantText += d.text;
      handlers.onText(d.text);
    } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
      acc.reasoningText += d.thinking;
      handlers.onReasoning?.(d.thinking);
    }
  } else if (type === "message_delta") {
    const fr = json.delta?.stop_reason;
    if (fr) acc.finishReason = fr;
    if (json.usage && typeof json.usage === "object") {
      acc.lastUsage = {
        prompt_tokens: json.usage.input_tokens ?? 0,
        completion_tokens: json.usage.output_tokens ?? 0,
        total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
      };
    }
  }
}

/** 解析单条 Gemini SSE 事件（data: {"candidates":[{"content":{"parts":[{"text":...}]}}]}）。 */
export function parseGeminiLine(
  trimmed: string,
  acc: { assistantText: string; reasoningText: string; finishReason: string; lastUsage: any },
  handlers: StreamHandlers
): void {
  let data = trimmed;
  if (trimmed.startsWith("data:")) data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return;
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  const cand = json.candidates?.[0];
  if (!cand) return;
  const parts = cand.content?.parts ?? [];
  for (const p of parts) {
    if (typeof p.text === "string") {
      acc.assistantText += p.text;
      handlers.onText(p.text);
    } else if (typeof p.thought === "string") {
      acc.reasoningText += p.thought;
      handlers.onReasoning?.(p.thought);
    }
  }
  if (cand.finishReason) acc.finishReason = cand.finishReason;
  if (json.usageMetadata && typeof json.usageMetadata === "object") {
    acc.lastUsage = {
      prompt_tokens: json.usageMetadata.promptTokenCount ?? 0,
      completion_tokens: json.usageMetadata.candidatesTokenCount ?? 0,
      total_tokens: json.usageMetadata.totalTokenCount ?? 0,
    };
  }
}

/** 把内部 ChatMessage 归一化为 OpenAI 兼容消息：多模态 user 消息转 content 数组，剔除空字段。 */
export function stripUndefined(m: ChatMessage): any {
  const out: any = { role: m.role, content: m.content };
  // 多模态：带图片的 user 消息转 OpenAI 兼容的 content 数组
  if (m.images && m.images.length > 0 && m.role === "user") {
    const parts: any[] = [{ type: "text", text: m.content || "" }];
    for (const img of m.images) {
      parts.push({ type: "image_url", image_url: { url: img } });
    }
    out.content = parts;
  }
  if (m.name) out.name = m.name;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.reasoning_content && m.role === "assistant") out.reasoning_content = m.reasoning_content;
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  return out;
}

/**
 * 非流式摘要调用（供上下文压缩使用）。
 * 免费服务（deepseek-free-api）主要支持流式；若其不支持非流式，将返回空字符串，
 * 调用方需退化为启发式压缩（见 context.ts）。
 */
export async function summarizeConversation(text: string, override?: ModelOverride): Promise<string> {
  let cfg;
  try {
    // 摘要 = 推理任务：Auto 模式下优先 flagship/pro 档；显式覆盖走指定模型
    cfg = override ? resolveConfigFor(override, "reason") : resolveActiveConfig("reason");
  } catch {
    return "";
  }
  try {
    if (cfg.format === "responses") {
      return await completeResponsesText(cfg, [
        {
          role: "system",
          content:
            "你是上下文压缩模块。请将以下编程助手对话历史压缩为结构化摘要，严格保留所有关键决策、文件路径、函数/类名、未完成任务与重要事实。用中文，按以下小标题分节（无内容则省略该节）：\n" +
            "## 目标\n## 关键决策\n## 代码改动\n## 待办事项\n## 风险与未决问题\n" +
            "若历史以代码为主，务必保留文件路径与符号名；不要编造未出现的内容。",
        },
        { role: "user", content: text },
      ], { temperature: 0.2 });
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是上下文压缩模块。请将以下编程助手对话历史压缩为结构化摘要，严格保留所有关键决策、文件路径、函数/类名、未完成任务与重要事实。用中文，按以下小标题分节（无内容则省略该节）：\n" +
              "## 目标\n## 关键决策\n## 代码改动\n## 待办事项\n## 风险与未决问题\n" +
              "若历史以代码为主，务必保留文件路径与符号名；不要编造未出现的内容。",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) {
      debugLogAux("summarizeConversation", cfg.endpoint, false, `HTTP ${res.status}`);
      return "";
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    debugLogAux("summarizeConversation", cfg.endpoint, false, e?.message ?? String(e));
    return "";
  }
}

/**
 * 非流式「持久记忆抽取」调用（供上下文压缩时自动固化重要信息）。
 * 从将被压缩的对话历史中，提取值得长期记住的持久事实（用户偏好、项目约定、
 * 关键技术决策、文件/模块架构、未决问题、踩过的坑）。失败（无 Key、服务不可用、
 * 本地模型不配合）时返回空字符串，调用方静默跳过——保证压缩主流程不依赖此步。
 */
export async function extractMemoryFacts(text: string): Promise<string> {
  let cfg;
  try {
    cfg = resolveActiveConfig();
  } catch {
    return "";
  }
  try {
    if (cfg.format === "responses") {
      return await completeResponsesText(cfg, [
        {
          role: "system",
          content:
            "你是记忆抽取模块。从以下将被压缩的对话历史中，提取值得长期记住的持久事实：用户偏好与习惯、项目约定、关键技术决策、文件/模块架构、未决问题、踩过的坑。每条以 [记忆] 开头写一行，只输出 [记忆] 行，不要其他解释。若没有值得记住的，只输出 [NO_MEMORY]。",
        },
        { role: "user", content: text },
      ], { temperature: 0.2 });
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是记忆抽取模块。从以下将被压缩的对话历史中，提取值得长期记住的持久事实：用户偏好与习惯、项目约定、关键技术决策、文件/模块架构、未决问题、踩过的坑。每条以 [记忆] 开头写一行，只输出 [记忆] 行，不要其他解释。若没有值得记住的，只输出 [NO_MEMORY]。",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) {
      debugLogAux("extractMemoryFacts", cfg.endpoint, false, `HTTP ${res.status}`);
      return "";
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    debugLogAux("extractMemoryFacts", cfg.endpoint, false, e?.message ?? String(e));
    return "";
  }
}

/**
 * 非流式「自我审视」调用（供 Layer 2 OnStop 反思 hook 使用）。
 * 让模型回顾本次会话，输出是否需要固化规则 / 新建技能的建议。
 * 失败（无 Key、服务不可用）时返回空字符串，调用方静默跳过。
 */
export async function reflectConversation(prompt: string): Promise<string> {
  let cfg;
  try {
    cfg = resolveActiveConfig();
  } catch {
    return "";
  }
  if (!cfg.apiKey) return "";
  try {
    if (cfg.format === "responses") {
      return await completeResponsesText(cfg, [
        {
          role: "system",
          content:
            "你是编程智能体的自我审视模块。基于给定会话片段，用中文简洁输出：是否反复犯错、用户是否反复纠正、是否有高频操作可做成技能。严格按要求的格式输出。",
        },
        { role: "user", content: prompt },
      ], { temperature: 0.3 });
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "你是编程智能体的自我审视模块。基于给定会话片段，用中文简洁输出：是否反复犯错、用户是否反复纠正、是否有高频操作可做成技能。严格按要求的格式输出。",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      debugLogAux("reflectConversation", cfg.endpoint, false, `HTTP ${res.status}`);
      return "";
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    debugLogAux("reflectConversation", cfg.endpoint, false, e?.message ?? String(e));
    return "";
  }
}

async function readAll(stream: any): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let s = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    s += dec.decode(value, { stream: true });
  }
  return s;
}

/**
 * 流空闲看门狗（对齐 Claude Code CLAUDE_STREAM_IDLE_TIMEOUT_MS / Codex withTimeout 注入 truncation）。
 * 模型开始流式响应后若超过 idleMs 毫秒未吐出任何增量 token（网络假死 / 服务挂起 / 推理卡死），
 * 主动 abort 本次请求并抛错，交由调用方的重试逻辑兜底，避免整轮对话永久 hang。
 * 每次收到文本或思维链增量都会重置计时器（只关心「是否还在输出」，不关心输出快慢）。
 * idleMs 默认 90_000（90s），与 Claude Code 默认对齐。
 */
export async function streamChatWithIdleTimeout(
  idleMs = 90_000,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  handlers: StreamHandlers,
  override?: ModelOverride,
  profile?: TaskProfile,
  /** 可注入底层 stream 实现，便于单测；默认使用本模块的 streamChat。 */
  streamChatImpl: typeof streamChat = streamChat
): Promise<{ message: ChatMessage; finishReason: string }> {
  // 组合外部 signal 与内部 idle 计时器：任一方 abort 都终止底层 fetch
  const inner = new AbortController();
  const external = handlers.signal;
  let onExternalAbort: (() => void) | null = null;
  if (external) {
    if (external.aborted) inner.abort();
    else {
      onExternalAbort = () => inner.abort();
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => inner.abort(), idleMs);
  };
  // 进入即武装：连接建立后若迟迟不吐字也算空闲（首 token 等待同样受保护）
  armIdle();

  const wrappedHandlers: StreamHandlers = {
    ...handlers,
    signal: inner.signal,
    onText: (d) => {
      armIdle();
      handlers.onText(d);
    },
    onReasoning: handlers.onReasoning
      ? (d) => {
          armIdle();
          handlers.onReasoning!(d);
        }
      : undefined,
  };

  try {
    const out = await streamChatImpl(messages, tools, wrappedHandlers, override, profile);
    if (idleTimer) clearTimeout(idleTimer);
    return out;
  } catch (e: any) {
    if (idleTimer) clearTimeout(idleTimer);
    // 因 idle 超时被我们主动 abort：转成带语义的错误，便于调用方识别并提示
    if (inner.signal.aborted && !external?.aborted) {
      const err = new Error(
        `模型响应空闲超过 ${idleMs}ms 被看门狗中断（stream idle timeout）。可重试或检查网络/服务可用性。`
      );
      err.name = "StreamIdleTimeoutError";
      throw err;
    }
    throw e;
  } finally {
    if (onExternalAbort && external) external.removeEventListener("abort", onExternalAbort);
  }
}
