import type { ResolvedConfig } from "./providers";
import type { ChatMessage, StreamHandlers, ToolCall, ToolDefinition } from "./provider";
import { debugLogRequest, debugWarn } from "./debug";

type ResponsesInputItem = Record<string, unknown>;

function cloneOutputItem(item: unknown): ResponsesInputItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Responses history contains a malformed output item.");
  }
  return { ...(item as Record<string, unknown>) };
}

/** Convert FreeSeek's durable ChatMessage history to stateless Responses input items. */
export function buildResponsesInput(messages: readonly ChatMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.responses_output_items?.length) {
      // Preserve the exact output item sequence, including encrypted reasoning state.
      input.push(...message.responses_output_items.map(cloneOutputItem));
      continue;
    }

    if (message.role === "tool") {
      if (!message.tool_call_id) {
        throw new Error("Cannot map a tool result to Responses API without tool_call_id.");
      }
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      });
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      if (message.content) {
        input.push({
          role: "assistant",
          content: message.content,
          ...(message.responses_phase ? { phase: message.responses_phase } : {}),
        });
      }
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }

    if (message.role === "user" && message.images?.length) {
      const content: Record<string, unknown>[] = [];
      if (message.content) content.push({ type: "input_text", text: message.content });
      for (const imageUrl of message.images) {
        content.push({ type: "input_image", image_url: imageUrl, detail: "auto" });
      }
      input.push({ role: "user", content });
      continue;
    }

    input.push({
      role: message.role,
      content: message.content ?? "",
      ...(message.role === "assistant" && message.responses_phase
        ? { phase: message.responses_phase }
        : {}),
    });
  }
  return input;
}

/** Responses function tools use top-level name/parameters rather than Chat Completions' nested function object. */
export function buildResponsesTools(tools: readonly ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    // FreeSeek tool schemas contain optional properties and provider-specific JSON Schema.
    // Keep their semantics instead of silently rewriting them into strict mode.
    strict: false,
  }));
}

/** Map Chat Completions response_format to Responses text.format. */
export function mapResponseFormat(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Responses response_format must be an object.");
  }
  const format = value as Record<string, any>;
  if (format.type === "json_schema") {
    const schema = format.json_schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error("response_format.json_schema must be an object.");
    }
    return {
      type: "json_schema",
      ...schema,
    };
  }
  if (format.type === "json_object" || format.type === "text") {
    return { type: format.type };
  }
  throw new Error(`Unsupported Responses structured-output format: ${String(format.type ?? "unknown")}`);
}

function validPositiveInteger(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Build a Responses API request. Server-side storage and response chaining are deliberately
 * disabled by default; the local EventLog is the source of truth for conversation history.
 */
export function buildResponsesBody(
  cfg: ResolvedConfig,
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  stream = true
): Record<string, unknown> {
  const extra: Record<string, unknown> = { ...cfg.extraBody };
  const legacyMaxTokens = extra.max_tokens;
  delete extra.max_tokens;
  delete extra.max_output_tokens;
  delete extra.model;
  delete extra.input;
  delete extra.messages;
  delete extra.tools;
  delete extra.stream;
  delete extra.stream_options;
  delete extra.store;
  delete extra.previous_response_id;
  delete extra.conversation;
  delete extra.include;
  delete extra.tool_choice;
  delete extra.parallel_tool_calls;
  const legacyResponseFormat = extra.response_format;
  delete extra.response_format;
  const requestedTopP = extra.top_p;
  delete extra.top_p;

  const maxOutputTokens =
    validPositiveInteger(cfg.extraBody.max_output_tokens) ??
    validPositiveInteger(legacyMaxTokens) ??
    validPositiveInteger(cfg.capabilities.maxOutputTokens) ??
    4096;
  const include = new Set<string>(
    Array.isArray(cfg.extraBody.include)
      ? cfg.extraBody.include.filter((item): item is string => typeof item === "string")
      : []
  );
  if (cfg.capabilities.reasoning === true) include.add("reasoning.encrypted_content");
  const requestedTemperature = extra.temperature;
  delete extra.temperature;

  const body: Record<string, unknown> = {
    ...extra,
    model: cfg.model,
    input: buildResponsesInput(messages),
    stream,
    store: cfg.storeResponses,
    include: Array.from(include),
    max_output_tokens: maxOutputTokens,
    ...(typeof requestedTemperature === "number" && cfg.capabilities.reasoning !== true
      ? { temperature: requestedTemperature }
      : {}),
    ...(typeof requestedTopP === "number" && cfg.capabilities.reasoning !== true
      ? { top_p: requestedTopP }
      : {}),
  };

  if (legacyResponseFormat && body.text === undefined) {
    if (cfg.capabilities.structuredOutput === false) {
      throw new Error(`Model "${cfg.model}" is configured without structured-output capability.`);
    }
    body.text = { format: mapResponseFormat(legacyResponseFormat) };
  } else if (body.text && cfg.capabilities.structuredOutput === false && (body.text as any).format) {
    throw new Error(`Model "${cfg.model}" is configured without structured-output capability.`);
  }

  const supportsTools = cfg.toolMode === "native" && cfg.capabilities.tools !== false;
  if (supportsTools && tools.length > 0) {
    body.tools = buildResponsesTools(tools);
    body.tool_choice = cfg.extraBody.tool_choice ?? "auto";
    body.parallel_tool_calls = cfg.extraBody.parallel_tool_calls ?? true;
  }
  const hasImages = messages.some((message) => message.images?.length);
  const inputModalitiesExcludeImages = !!cfg.capabilities.inputModalities?.length &&
    !cfg.capabilities.inputModalities.includes("image");
  if (hasImages && (cfg.capabilities.vision === false || inputModalitiesExcludeImages)) {
    throw new Error(
      `Model "${cfg.model}" is configured without image-input capability but the conversation contains images.`
    );
  }
  return body;
}

function outputTextFromItems(items: readonly any[]): string {
  const chunks: string[] = [];
  for (const item of items) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
      else if (part?.type === "refusal" && typeof part.refusal === "string") chunks.push(part.refusal);
    }
  }
  return chunks.join("");
}

function toolCallsFromItems(items: readonly any[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of items) {
    if (item?.type !== "function_call") continue;
    const id = typeof item.call_id === "string" && item.call_id
      ? item.call_id
      : typeof item.id === "string" && item.id
        ? item.id
        : "";
    if (!id || typeof item.name !== "string" || !item.name) continue;
    calls.push({
      id,
      type: "function",
      function: {
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      },
    });
  }
  return calls;
}

function usageFromResponse(usage: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.input_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? 0);
  const total = Number(usage.total_tokens ?? prompt + completion);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
  };
}

function responseFailure(response: any): Error {
  const detail = response?.error;
  const message = typeof detail?.message === "string"
    ? detail.message
    : typeof response?.incomplete_details?.reason === "string"
      ? `Response incomplete: ${response.incomplete_details.reason}`
      : "Responses API request failed.";
  const error = new Error(message);
  if (typeof detail?.code === "string") (error as Error & { code?: string }).code = detail.code;
  return error;
}

function parseSsePayload(data: string): any | null {
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function responseFinishReason(response: any): string {
  if (response?.status === "completed") return "stop";
  if (response?.status === "incomplete") {
    const reason = response?.incomplete_details?.reason;
    return reason === "max_output_tokens" ? "length" : String(reason ?? "incomplete");
  }
  return "stop";
}

function createAssistantMessage(
  text: string,
  reasoningText: string,
  outputItems: any[],
  finishResponse: any
): ChatMessage {
  const message: ChatMessage = { role: "assistant", content: text };
  if (reasoningText) message.reasoning_content = reasoningText;
  if (outputItems.length) message.responses_output_items = outputItems;
  const phase = outputItems.find((item) => item?.type === "message" && (item.phase === "commentary" || item.phase === "final_answer"))?.phase;
  if (phase) message.responses_phase = phase;
  const calls = toolCallsFromItems(outputItems);
  if (calls.length) message.tool_calls = calls;
  return message;
}

/** Preserve Responses output state and reconcile ReAct-parsed tool calls for the next stateless turn. */
export function copyResponsesOutputState(
  source: ChatMessage,
  target: ChatMessage,
  effectiveToolCalls?: ToolCall[]
): void {
  if (source.responses_output_items) {
    const outputItems = source.responses_output_items as any[];
    const responseCallIds = new Set(
      outputItems.filter((item) => item?.type === "function_call").map((item) => item.call_id)
    );
    const hasAllResponseCalls = !!effectiveToolCalls &&
      effectiveToolCalls.every((call) => responseCallIds.has(call.id));
    if (!effectiveToolCalls?.length || hasAllResponseCalls) {
      target.responses_output_items = outputItems;
    } else {
      // ReAct parsing can synthesize tool calls from text. Rebuild the Responses
      // input projection so each function_call_output has a matching function_call,
      // while retaining opaque reasoning state from the original model response.
      const reasoningItems = outputItems.filter((item) => item?.type === "reasoning");
      const originalMessage = outputItems.find((item) => item?.type === "message");
      const textItem = target.content
        ? {
            ...(originalMessage ?? {}),
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: target.content }],
          }
        : null;
      const syntheticCalls = effectiveToolCalls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));
      target.responses_output_items = [
        ...reasoningItems,
        ...(textItem ? [textItem] : []),
        ...syntheticCalls,
      ];
    }
  }
  if (source.responses_phase) target.responses_phase = source.responses_phase;
}

/** Stream OpenAI Responses API semantic SSE events through the existing FreeSeek stream contract. */
export async function streamResponses(
  cfg: ResolvedConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  handlers: StreamHandlers
): Promise<{ message: ChatMessage; finishReason: string }> {
  const body = buildResponsesBody(cfg, messages, tools, true);
  debugLogRequest({
    provider: cfg.providerName,
    model: cfg.model,
    endpoint: cfg.endpoint,
    messages,
    toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
    tag: `format=responses toolMode=${cfg.toolMode} store=${cfg.storeResponses}`,
    fullBody: body,
  });

  const response = await fetch(cfg.endpoint, {
    method: "POST",
    headers: cfg.headers,
    body: JSON.stringify(body),
    signal: handlers.signal,
  });
  if (!response.ok || !response.body) {
    const text = response.body ? await readAll(response.body) : await response.text();
    debugWarn(`Responses API returned ${response.status}: ${text.slice(0, 4000)}`);
    throw new Error(`Responses API returned ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let reasoningText = "";
  let completedResponse: any = null;
  const outputItemsByIndex = new Map<number, any>();

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const event = parseSsePayload(trimmed.slice(5).trim());
    if (!event || typeof event.type !== "string") return;

    switch (event.type) {
      case "response.output_text.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          assistantText += delta;
          handlers.onText(delta);
        }
        break;
      }
      case "response.refusal.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          assistantText += delta;
          handlers.onText(delta);
        }
        break;
      }
      case "response.reasoning_summary_text.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          reasoningText += delta;
          handlers.onReasoning?.(delta);
        }
        break;
      }
      case "response.output_item.done": {
        if (Number.isInteger(event.output_index) && event.item) {
          outputItemsByIndex.set(event.output_index, event.item);
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        completedResponse = event.response ?? completedResponse;
        break;
      }
      case "response.failed": {
        throw responseFailure(event.response);
      }
      case "error": {
        throw responseFailure(event);
      }
      default:
        break;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } catch (error) {
    try { await reader.cancel(error); } catch { /* stream may already be closed */ }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (completedResponse?.status === "failed") throw responseFailure(completedResponse);
  if (!completedResponse && outputItemsByIndex.size === 0) {
    throw new Error("Responses API stream ended before response.completed or response.incomplete.");
  }

  const responseOutput = Array.isArray(completedResponse?.output) ? completedResponse.output : [];
  const streamedOutput = Array.from(outputItemsByIndex.entries()).sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const outputItems = responseOutput.length ? responseOutput : streamedOutput;
  if (!assistantText) {
    assistantText = outputTextFromItems(outputItems);
    if (assistantText) handlers.onText(assistantText);
  }
  const usage = usageFromResponse(completedResponse?.usage);
  if (usage) handlers.onUsage?.(usage);
  const toolCalls = toolCallsFromItems(outputItems);
  if (toolCalls.length) handlers.onToolCalls?.(toolCalls);

  return {
    message: createAssistantMessage(assistantText, reasoningText, outputItems, completedResponse),
    finishReason: responseFinishReason(completedResponse),
  };
}

/** Non-streaming Responses call used by compaction, memory extraction and reflection helpers. */
export async function completeResponsesText(
  cfg: ResolvedConfig,
  messages: ChatMessage[],
  options: { temperature?: number } = {}
): Promise<string> {
  const body = buildResponsesBody(cfg, messages, [], false);
  delete body.max_output_tokens;
  if (typeof options.temperature === "number" && cfg.capabilities.reasoning === false) {
    body.temperature = options.temperature;
  }
  const response = await fetch(cfg.endpoint, {
    method: "POST",
    headers: cfg.headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Responses API returned ${response.status}: ${text.slice(0, 4000)}`);
  }
  const result = await response.json() as any;
  if (result?.status === "failed") throw responseFailure(result);
  if (typeof result?.output_text === "string") return result.output_text;
  return outputTextFromItems(Array.isArray(result?.output) ? result.output : []);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}
