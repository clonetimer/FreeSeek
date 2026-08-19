/**
 * 对话导入器：解析 Claude Code / Codex CLI 的 JSONL 会话文件，转为 FreeSeek 的 ChatMessage[]。
 * 目标格式均为「每行一个 JSON 对象」的 JSONL；本模块做宽容解析——坏行跳过并计数，
 * 尽量保留 user / assistant / tool 消息文本，tool 调用信息原样展示。
 */
import { ChatMessage } from "./provider";

export interface ImportResult {
  messages: ChatMessage[];
  /** 成功转换的消息条数 */
  converted: number;
  /** 被跳过的坏行 / 无法识别行数 */
  skipped: number;
  /** 识别到的来源（自动判定）：codex / claude / unknown */
  source: "codex" | "claude" | "unknown";
  /** 建议标题（取首条 user 文本前 40 字符） */
  title: string;
}

/** 安全读取某字段字符串；多模态 content 数组时提取纯文本部分。 */
function asText(v: unknown, maxLen: number): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, maxLen);
  if (Array.isArray(v)) {
    // OpenAI 多模态 content 数组：[{type:"text",text:"..."}, {type:"image_url",...}]
    const parts: string[] = [];
    for (const it of v) {
      if (it && typeof it === "object") {
        const o = it as Record<string, unknown>;
        if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
        else if (o.type === "image_url" && o.image_url) parts.push("[图片]");
      } else if (typeof it === "string") {
        parts.push(it);
      }
    }
    const joined = parts.join("\n");
    return joined.slice(0, maxLen);
  }
  return String(v).slice(0, maxLen);
}

/**
 * 解析一个 JSONL 文件内容，转换为 ChatMessage[]。
 * 兼容策略：逐行 JSON.parse，失败行跳过；按字段形态自动识别来源。
 */
export function importJsonl(content: string): ImportResult {
  const messages: ChatMessage[] = [];
  let skipped = 0;
  let source: "codex" | "claude" | "unknown" = "unknown";

  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!obj || typeof obj !== "object") {
      skipped++;
      continue;
    }
    const pushed = dispatchLine(obj, messages);
    if (pushed === "claude") source = source === "unknown" ? "claude" : source;
    else if (pushed === "codex") source = source === "unknown" ? "codex" : source;
    else if (pushed === "skip") skipped++;
  }

  const firstUser = messages.find((m) => m.role === "user");
  return {
    messages,
    converted: messages.length,
    skipped,
    source,
    title: firstUser ? String(firstUser.content).slice(0, 40) : "导入对话",
  };
}

function dispatchLine(
  obj: any,
  out: ChatMessage[]
): "claude" | "codex" | "skip" | "unknown" {
  const t: string | undefined = obj.type;
  const role = obj.message?.role as string | undefined;

  // ── Claude Code：每行有 type + message（{role, content}）或 toolUseResult ──
  if (t === "user" || t === "assistant") {
    if (role === "user" || role === "assistant") {
      const content = asText(obj.message?.content, 100000);
      if (!content) return "skip";
      out.push({
        role,
        content,
        ...(obj.message?.name ? { name: String(obj.message.name) } : {}),
      });
      return "claude";
    }
    return "skip";
  }
  if (t === "tool_use") {
    // Claude tool 调用：并入前一条 assistant（或单独起一条带 tool_calls 的 assistant）
    const name = String(obj.name || "");
    let args = "";
    try {
      args = typeof obj.input === "string" ? obj.input : JSON.stringify(obj.input ?? {});
    } catch {
      args = "";
    }
    if (!name) return "skip";
    let last = out[out.length - 1];
    if (last && last.role === "assistant" && !last.content) {
      // 复用上一条空内容的 assistant 挂 tool_calls
    } else {
      last = { role: "assistant", content: "" };
      out.push(last);
    }
    last.tool_calls = last.tool_calls || [];
    last.tool_calls.push({ id: String(obj.id || `t_${out.length}`), type: "function", function: { name, arguments: args } });
    return "claude";
  }
  if (t === "tool_result") {
    const content = asText(obj.content, 100000);
    out.push({ role: "tool", tool_call_id: String(obj.toolUseId || ""), content: content || "(工具无输出)" });
    return "claude";
  }

  // ── Codex：response_item 事件，内含 message / function_call / function_call_output / reasoning ──
  if (t === "response_item" && obj.payload) {
    const p = obj.payload;
    const itType: string | undefined = p.type;
    if (itType === "message" && p.role === "user") {
      const content = asText(p.content, 100000);
      if (content) {
        out.push({ role: "user", content });
        return "codex";
      }
      return "skip";
    }
    if (itType === "message" && p.role === "assistant") {
      const content = asText(p.content, 100000);
      // assistant 可能带 tool_calls（function_call 以独立 item 出现，或内联）
      const tcs = Array.isArray(p.tool_calls) ? p.tool_calls : [];
      if (content || tcs.length) {
        out.push({
          role: "assistant",
          content: content || "",
          tool_calls: tcs.map((tc: any) => ({
            id: String(tc.id || `t_${out.length}`),
            type: "function" as const,
            function: {
              name: tc.function?.name || "",
              arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
            },
          })),
        });
        return "codex";
      }
      return "skip";
    }
    if (itType === "function_call") {
      const name = String(p.name || "");
      if (!name) return "skip";
      let last = out[out.length - 1];
      if (!(last && last.role === "assistant")) {
        last = { role: "assistant", content: "" };
        out.push(last);
      }
      last.tool_calls = last.tool_calls || [];
      last.tool_calls.push({
        id: String(p.call_id || p.id || `t_${out.length}`),
        type: "function",
        function: {
          name,
          arguments: typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {}),
        },
      });
      return "codex";
    }
    if (itType === "function_call_output") {
      const content = asText(p.output, 100000);
      out.push({ role: "tool", tool_call_id: String(p.call_id || ""), content: content || "(工具无输出)" });
      return "codex";
    }
    if (itType === "reasoning") {
      const content = asText(p.summary || p.content, 5000);
      if (content) {
        out.push({ role: "assistant", content: "【思考过程】\n" + content });
      }
      return "codex";
    }
    return "skip";
  }

  // ── 通用兜底：裸 {role, content} 行（部分导出工具会生成）──
  if (typeof role === "string" && (role === "user" || role === "assistant" || role === "tool")) {
    const content = asText(obj.content, 100000);
    if (role === "tool") {
      out.push({ role: "tool", tool_call_id: String(obj.tool_call_id || ""), content: content || "(工具无输出)" });
      return "unknown";
    }
    if (content) {
      out.push({ role, content });
      return "unknown";
    }
    return "skip";
  }

  return "skip";
}
