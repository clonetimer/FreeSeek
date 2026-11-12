/** Auto 路由的任务画像：调用方根据本次请求推断，传给 getActiveProvider/profile，
 *  路由模块据此挑选最合适的「已配置 key + 任务匹配 + 性价比优」的 provider/model。 */
export type TaskProfile = "chat" | "code" | "reason" | "vision" | "tools" | "long";

/** 从对话历史推断任务画像（用于 Auto 模式路由）。优先看最近一条 user 消息；
 *  - 看到图片 → vision；看到工具调用链 → tools；包含 "<think>" / "推理" / 数学 → reason；
 *  - 提到代码关键词或 read_file / grep 类上下文 → code；长上下文（>8K）→ long；
 *  - 其它 → chat（默认）。 */
export function inferTaskProfile(messages: ReadonlyArray<{ role: string; content?: string; images?: unknown[] }>): TaskProfile {
  let lastUser = "";
  let lastAssistant = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && !lastUser) lastUser = String(m.content ?? "");
    else if (m.role === "assistant" && !lastAssistant) lastAssistant = String(m.content ?? "");
    if (lastUser && lastAssistant) break;
  }
  const text = (lastUser + "\n" + lastAssistant).slice(0, 4000).toLowerCase();
  if (/```|\.ts|\.py|\.js|class |function |import |select |<code|read_file|grep|搜索|查(找|看)文件/.test(text)) return "code";
  if (/<think>|推理|证明|计算|推导|equation|math|微分|积分|概率|统计/.test(text)) return "reason";
  if (/\.(png|jpg|jpeg|gif|webp)|data:image|base64|image_url|图片|截图|看图|附图/.test(text)) return "vision";
  if (/工具调用|tool_call|tool_result|spawn_agent|run_command|edit_file|write_file/.test(text)) return "tools";
  if (text.length > 2000) return "long";
  return "chat";
}

