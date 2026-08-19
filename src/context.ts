import { ChatMessage, summarizeConversation } from "./provider";
import { ModelOverride } from "./providers";

/** Layer 7: Context Manager —— token 估算 + 预算预警 + 主动分级压缩 + 三维预算 */

/**
 * 启发式 token 估算（无需 tiktoken，零依赖）：
 *  - CJK 字符约 1.5 token/字；
 *  - 其它字符约 4 字符/token。
 * 对中小代码库足够了；目的是给模型一个自然语言预算信号，而非精确计数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e7f) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5 + other / 4);
}

export function conversationTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateTokens(m.content ?? "") + 4;
  return n;
}

export function usageRatio(messages: ChatMessage[], budget: number): number {
  if (budget <= 0) return 0;
  return conversationTokens(messages) / budget;
}

/**
 * 工具消息序列配对齐整化（修复分级压缩破坏 tool/tool_calls 配对导致的 400）。
 * OpenAI/DeepSeek 协议：role='tool' 消息必须紧跟携带对应 tool_call_id 的 assistant 消息。
 * 压缩按消息年龄切段时，可能把 assistant(tool_calls) 摘要进 old 段、而 tool 结果留在 middle 段
 * （产生孤立 tool 消息），或把 tool 结果摘掉留下未闭合的 assistant.tool_calls——前者直接 400。
 * 本函数用栈式配对重建合法序列：
 *  - 孤立 tool（无前置匹配 tool_calls）→ 丢弃；
 *  - 未闭合的 assistant.tool_calls（无对应 tool 结果，含被 user/system 打断的）→ 移除 tool_calls 字段、保留消息文本。
 */
export function sanitizeToolSequence(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const stack: { idx: number; pending: Set<string> }[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const ids = (m.tool_calls ?? []).map((t) => t.id).filter(Boolean);
      const idx = out.length;
      out.push(m);
      if (ids.length) stack.push({ idx, pending: new Set(ids) });
    } else if (m.role === "tool") {
      const id = m.tool_call_id;
      let matched = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (id && stack[i].pending.has(id)) {
          stack[i].pending.delete(id);
          matched = true;
          break;
        }
      }
      if (matched) out.push(m);
      // 未匹配：孤立 tool 消息（前置 assistant.tool_calls 已被压缩摘要掉），丢弃
    } else {
      // user/system 打断：栈内未闭合的 assistant.tool_calls 已不可能等到结果，移除其 tool_calls
      for (const e of stack) {
        if (e.pending.size > 0) out[e.idx] = { ...out[e.idx], tool_calls: undefined };
      }
      stack.length = 0;
      out.push(m);
    }
  }
  // 结尾仍未闭合的 assistant.tool_calls：移除 tool_calls、保留消息文本
  for (const e of stack) {
    if (e.pending.size > 0) out[e.idx] = { ...out[e.idx], tool_calls: undefined };
  }
  return out;
}

/**
 * 主动分级压缩（Passive truncation 的替代）：
 * 每一轮按消息"年龄"分档处理，信息损失摊薄到多轮，而非断崖式砍最早历史——
 * 对应 Lilian Weng / AllenTang 的「tiered compaction」：
 *   - 最近 keepRecent 条：完整保留（正在用的上下文）；
 *   - 其前的 stripBand 条：工具消息剥离体积（仅留"已执行"事实），文本保留；
 *   - 更早的部分：整桶做一次模型摘要（优先）或退化为截断摘要。
 * 重要事实应在压缩前已写入记忆系统（memory.ts），压缩历史不会丢。
 */
export async function tieredCompact(
  messages: ChatMessage[],
  onSummary?: (summary: string) => void,
  keepRecent = 12,
  stripBand = 16,
  onCompressOld?: (oldText: string) => Promise<void>,
  /** 多模型分工：摘要调用使用指定模型（子智能体压缩用），省略则全局活动模型 */
  override?: ModelOverride
): Promise<ChatMessage[]> {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const conv = messages.filter((m) => m.role !== "system");
  if (conv.length <= keepRecent + stripBand) return messages;

  const recent = conv.slice(-keepRecent);
  const rest = conv.slice(0, conv.length - keepRecent);
  const middle = rest.slice(-stripBand);
  const old = rest.slice(0, Math.max(0, rest.length - stripBand));

  // middle：工具消息仅留"已执行"标记，省掉大段输出；文本消息保留
  const middleOut: ChatMessage[] = middle.map((m) => {
    if (m.role === "tool") {
      const name =
        (m.content?.match(/name="([^"]+)"/) || [])[1] || m.name || "tool";
      return {
        role: "tool",
        tool_call_id: m.tool_call_id,
        name,
        content: `<tool_result name="${name}">（结果已在分级压缩中省略，仅保留“工具曾执行”这一事实）</tool_result>`,
      };
    }
    return m;
  });

  // old：整桶做一次模型摘要（优先），失败退化为截断摘要
  let oldSummary = "";
  if (old.length) {
    const rawOld = old
      .map((m) => `[${m.role}] ${String(m.content ?? "").slice(0, 300)}`)
      .join("\n");
    // 压缩前先把待丢弃的旧历史交给记忆抽取（best-effort，失败不影响压缩）
    if (onCompressOld) {
      try {
        await onCompressOld(rawOld);
      } catch {
        /* 忽略记忆抽取异常 */
      }
    }
    try {
      const llmSummary = await summarizeConversation(rawOld, override);
      oldSummary = llmSummary && llmSummary.trim() ? llmSummary.trim() : rawOld;
    } catch {
      oldSummary = rawOld;
    }
    const text = `## 早期对话摘要（tiered compact 分级压缩）\n${oldSummary}`;
    onSummary?.(text);
  }

  const result: ChatMessage[] = [...systemMsgs];
  if (oldSummary) result.push({ role: "system", content: `## 早期对话摘要（tiered compact 分级压缩）\n${oldSummary}` });
  result.push(...middleOut, ...recent);
  // 分段压缩可能拆散 tool/tool_calls 配对（assistant 被摘要进 old、tool 结果留在 middle），
  // 输出前做一次配对齐整化，避免下轮请求报 400（孤立 tool 消息）。
  return sanitizeToolSequence(result);
}

/**
 * 三维预算（LoopBudget）：不依赖模型自我判断，用外部硬性上限兜底——
 * 防止工具调用失败→重试→又失败→死循环（对应 AllenTang harness-17）。
 *   - maxTurns：最多多少轮（LLM 调用）；
 *   - maxTokens：上下文 token 总量上限；
 *   - maxWallClockMs：墙钟时间上限。
 * check() 放在循环顶部，加新条件只改一处；预算耗尽返回文字而非抛异常，
 * 上层拿到的是"可用部分结果"，不是错误。
 */
export interface LoopBudget {
  maxTurns: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export class BudgetTracker {
  private startMs = Date.now();
  constructor(public limits: LoopBudget) {}

  /** 每轮（每步工具调用）调用一次，传入当前已用轮次与 token 估算。 */
  check(turns: number, tokens: number): [boolean, string | null] {
    if (turns >= this.limits.maxTurns) {
      return [true, `已达最大轮次上限 ${this.limits.maxTurns}，停止以避免死循环。`];
    }
    if (this.limits.maxTokens > 0 && tokens >= this.limits.maxTokens) {
      return [true, `上下文 token 已达预算上限 ${this.limits.maxTokens}，建议开启新会话。`];
    }
    if (Date.now() - this.startMs >= this.limits.maxWallClockMs) {
      return [true, `已达墙钟时间上限（${Math.round(this.limits.maxWallClockMs / 1000)}s），停止。`];
    }
    return [false, null];
  }
}
