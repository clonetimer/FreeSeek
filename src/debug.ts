/**
 * FreeSeek 调试输出通道（懒创建）。
 * 用户可在 VS Code「输出」面板下拉框选择 "FreeSeek Debug" 查看请求/响应细节，
 * 便于定位模型服务的 400 / 超时 / 协议问题。
 */

type DebugChannelLike = { appendLine(message: string): void };
let channel: DebugChannelLike | null = null;
let headlessVerbose = false;

/** Headless/测试可显式注入日志宿主，避免核心模块在加载时依赖 vscode。 */
export function configureDebugHost(next?: { channel?: DebugChannelLike; verbose?: boolean }): void {
  channel = next?.channel ?? null;
  headlessVerbose = next?.verbose === true;
}

export function getDebugChannel(): DebugChannelLike {
  if (!channel) {
    try {
      const vscode = require("vscode") as typeof import("vscode");
      channel = vscode.window.createOutputChannel("FreeSeek Debug");
    } catch {
      channel = { appendLine: (message: string) => console.error(message) };
    }
  }
  return channel;
}

export function debugLog(msg: string): void {
  try {
    getDebugChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  } catch {
    /* 扩展卸载等场景下忽略 */
  }
}

/** 输出一条警告级调试日志（带 ⚠ 前缀），复用 debugLog 通道。 */
export function debugWarn(msg: string): void {
  debugLog(`⚠ ${msg}`);
}

/** 仅当 freesek.debugVerbose 开启时输出（完整请求体等大块内容）。 */
export function debugVerbose(msg: string): void {
  if (headlessVerbose) { debugLog(msg); return; }
  try {
    const vscode = require("vscode") as typeof import("vscode");
    if (vscode.workspace.getConfiguration("freesek").get<boolean>("debugVerbose", false)) debugLog(msg);
  } catch {
    /* Headless 默认不输出 verbose。 */
  }
}

interface DebugMsgLike {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

/**
 * 记录一次请求的概要：provider / model / endpoint / 消息数量 / 每条的
 * role + content 长度 + tool_calls / tool_call_id，并做 tool 消息配对预检。
 * 该预检能直接指出 400 错误（"tool must be a response to preceding tool_calls"）的出处。
 */
export function debugLogRequest(opts: {
  provider: string;
  model: string;
  endpoint: string;
  messages: DebugMsgLike[];
  toolsCount: number;
  tag?: string;
  fullBody?: unknown;
}): void {
  const { provider, model, endpoint, messages, toolsCount, tag, fullBody } = opts;
  debugLog(
    `▶ [${provider} / ${model}]${tag ? ` ${tag}` : ""} POST ${endpoint} | msgs=${messages.length}, tools=${toolsCount}`
  );
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role ?? "?";
    const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls.length : 0;
    const raw = typeof m.content === "string" ? m.content : m.content ? JSON.stringify(m.content) : "";
    const len = raw?.length ?? 0;
    const callId = m.tool_call_id ? ` call=${String(m.tool_call_id).slice(0, 32)}` : "";
    const tcInfo = toolCalls
      ? ` tool_calls=${(m.tool_calls as Array<{ id?: string; function?: { name?: string } }>)
          .map((t) => `${t.function?.name ?? "?"}#${(t.id ?? "?").slice(0, 16)}`)
          .join(",")}`
      : "";
    debugLog(`  msg[${i}] ${role}${callId}${tcInfo} (${len}ch)`);
  }
  const issues = validateToolSequence(messages);
  if (issues.length > 0) {
    debugWarn(`tool 消息配对预检发现 ${issues.length} 处问题（模型服务可能因此返回 400）：`);
    for (const it of issues) debugWarn(`  - ${it}`);
  }
  if (fullBody !== undefined) {
    debugVerbose("  ── 完整请求体（debugVerbose 已开启） ──");
    try {
      debugVerbose(JSON.stringify(fullBody, null, 2));
    } catch {
      debugVerbose(String(fullBody));
    }
  }
}

/** 记录一次非流式辅助调用（摘要 / 记忆抽取 / 自我审视）。 */
export function debugLogAux(kind: string, endpoint: string, ok: boolean, detail: string): void {
  debugLog(`◇ ${kind} ${ok ? "OK" : "FAIL"} ${endpoint} | ${detail.slice(0, 2000)}`);
}

/**
 * 校验 OpenAI 兼容消息序列的 tool 配对约束：
 *   1) tool 消息前必须是携带 tool_calls 的 assistant 消息；
 *   2) tool 消息的 tool_call_id 必须能在前置 assistant.tool_calls 中找到；
 *   3) assistant 声明了 tool_calls 但后续没有 tool 结果（不报错，只是提示）。
 * 返回问题描述列表（空 = 无问题）。
 */
export function validateToolSequence(messages: DebugMsgLike[]): string[] {
  const issues: string[] = [];
  const declared = new Map<string, boolean>(); // call_id -> 是否已被 tool 消费
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role;
    if (role === "assistant") {
      const tcs = Array.isArray(m.tool_calls) ? (m.tool_calls as Array<{ id?: string }>) : [];
      if (tcs.length === 0 && messages[i + 1]?.role === "tool") {
        issues.push(`msg[${i}] assistant 没有 tool_calls，但其后紧跟 tool 消息`);
      }
      for (const tc of tcs) {
        if (tc.id) declared.set(tc.id, false);
      }
    } else if (role === "tool") {
      const id = m.tool_call_id;
      if (!id) {
        issues.push(`msg[${i}] tool 消息缺少 tool_call_id`);
      } else if (!declared.has(id)) {
        issues.push(`msg[${i}] tool 消息 tool_call_id="${String(id).slice(0, 32)}" 找不到前置 assistant.tool_calls`);
      } else {
        declared.set(id, true);
      }
    }
  }
  return issues;
}
