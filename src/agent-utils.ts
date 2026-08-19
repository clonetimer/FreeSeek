/**
 * agent.ts 拆出的纯工具函数：工具并发判定、有界执行、消息序列修复、
 * ReAct 协议解析、超时守卫、工具名模糊纠正。全部为纯函数（无 runAgent /
 * runSubAgent 依赖），可独立单测。
 */
import type { ChatMessage, ToolDefinition } from "./provider";
import { isRuntimeConcurrencySafe } from "./tool-runtime-spec";

/** 并行工具执行的有界并发数（过多会触发 DeepSeek 免费端限流，控制在 4 以内）。 */
export const TOOL_PARALLEL_LIMIT = 4;

/** 工具是否并发安全：外部动态工具（mcp__/conn__）保守串行，白名单内只读工具可并行。 */
export function isConcurrencySafe(name: string): boolean {
  return isRuntimeConcurrencySafe(name);
}

/** 有界并发执行器：至多 limit 个任务同时运行，返回结果数组并保持入参顺序。 */
export async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<string>
): Promise<string[]> {
  const out: string[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/**
 * 修复工具消息序列：删除未闭合的「assistant 携带 tool_calls 但缺少后续 tool 结果」的回合，
 * 以及孤立的 tool 消息（没有对应 assistant.tool_calls）。
 * OpenAI/DeepSeek 协议要求：每条 role='tool' 消息必须紧接在携带同名 tool_call_id 的
 * assistant 消息之后，否则会报 400 "Messages with role 'tool' must be a response...".
 */
export function trimUnfinishedTurn(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pendingToolCalls: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const toolCallIds = ((m as any).tool_calls as Array<{ id?: string }> | undefined)
        ?.map((t) => t.id)
        .filter((id): id is string => !!id) ?? [];
      // 如果前一条 assistant 仍有未闭合的 tool_calls，先回滚它
      while (
        out.length > 0 &&
        out[out.length - 1].role === "assistant" &&
        pendingToolCalls.length > 0
      ) {
        out.pop();
      }
      out.push(m);
      pendingToolCalls = toolCallIds;
    } else if (m.role === "tool") {
      const id = (m as any).tool_call_id as string | undefined;
      if (id && pendingToolCalls.includes(id)) {
        out.push(m);
        pendingToolCalls = pendingToolCalls.filter((tcId) => tcId !== id);
      }
      // 孤立的 tool 消息直接丢弃
    } else {
      // system / user 消息直接保留，同时清理 pending tool 状态
      pendingToolCalls = [];
      out.push(m);
    }
  }
  // 遍历结束后如果最后一条 assistant 仍带有未闭合的 tool_calls，回滚它
  while (
    out.length > 0 &&
    out[out.length - 1].role === "assistant" &&
    pendingToolCalls.length > 0
  ) {
    out.pop();
    pendingToolCalls = [];
  }
  return out;
}

/**
 * 工具单次输出预览/落盘截断上限（字符）。各工具内部对单次执行输出做封顶（防巨输出），
 * 事件日志也按此截断预览；统一收口到本常量，消除散落的裸数字（8000/4000）。
 * 注意：此上限与 truncateToolResult 的 200K 回灌兜底不冲突——本常量是「执行层单次封顶」，
 * truncateToolResult 是「回灌上下文层总兜底」。
 */
export const TOOL_OUTPUT_PREVIEW_CAP = 8000;

/** 单次执行输出预览截断（执行层封顶）：超过 cap 保留前段并标注总长。 */
export function truncatePreview(text: string, cap: number = TOOL_OUTPUT_PREVIEW_CAP): string {
  const s = String(text ?? "");
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…（输出已截断，共 ${s.length} 字符；可缩小打印量或写文件后 read_file）`;
}

/**
 * todo 分解 nudge 判定：任务面板仍只有单条「进行中」任务（种子任务未被模型分解成步骤）
 * 且已执行 ≥minSteps 步工具调用时，需要推动模型调用 todo_write 补充分解。
 * 结构化参数避免依赖 tools 的 TodoItem 类型（防循环依赖）。
 */
export function needsTodoNudge(
  items: Array<{ content: string; status: string }>,
  steps: number,
  minSteps = 2
): boolean {
  return steps >= minSteps && items.length === 1 && items[0]?.status === "in_progress";
}

/** todo 分解 nudge 推动消息（对标 lazy-nudge：注入后让模型补充分解，不替它规划）。 */
export const TODO_NUDGE_MESSAGE =
  "检测到任务面板仍只有一条「整条需求」的任务项（未分解）。请调用 todo_write 把任务分解为 ≥2 个" +
  "可执行的具体步骤（如：理解 → 实现 → 验证），逐项标注 pending/in_progress/completed 状态，" +
  "不要保留整条需求作为单一任务项。";

/**
 * 工具结果回灌统一截断（对齐 Codex output-truncation / Claude Code maxResultSizeChars）。
 * 各工具内部已有按文件的零散上限（read 16MB、grep 8MB），但工具输出进入上下文前
 * 需要一个与 offload 解耦的硬兜底：即便 offloadDir 未配置，超长结果也只保留首尾两段
 * 并标注，避免极端长输出直接撑爆上下文预算（性能/可靠性）。
 * 截断策略：保留前 headChars 与后 tailChars，中间折叠为省略说明。
 */
export function truncateToolResult(
  result: string,
  maxChars = 200_000,
  headChars = 80_000,
  tailChars = 20_000
): string {
  if (result.length <= maxChars) return result;
  const head = result.slice(0, headChars);
  const tail = result.slice(result.length - tailChars);
  const omitted = result.length - headChars - tailChars;
  return (
    `${head}\n\n` +
    `…（工具结果过长，已从中间省略 ${omitted.toLocaleString()} 字符；` +
    `总长约 ${result.length.toLocaleString()} 字符，超出 ${maxChars.toLocaleString()} 硬上限）\n` +
    `如需查看被省略的中间内容，请用更精确的检索（grep 限定 pattern / read_file 用 offset+limit 分段）。\n\n` +
    `${tail}`
  );
}

/**
 * 超时守卫（timeout-policy guard，借鉴 deepseek-harness timeout-policy）：
 * 把 promise 包上超时预算，超时后返回 { timedOut: true }。
 * 底层任务无法在 JS 层真正中断（子进程类工具自带 execFile 超时会自行 kill），
 * 因此这里把底层 promise 的 rejection 吞掉，避免超时返回后产生 unhandledRejection。
 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number | undefined
): Promise<{ timedOut: boolean; value?: T }> {
  if (!ms || ms <= 0) {
    return { timedOut: false, value: await p };
  }
  // 吞掉底层 rejection：无论成败都 resolve，超时场景下结果被 race 丢弃也不会崩
  // catch 分支的值仅在超时丢弃路径出现，这里强转 T 以保持 work 类型干净
  const work: Promise<{ timedOut: false; value: T }> = p
    .catch((e: any) => `⚠️ 工具执行出错：${e?.message ?? String(e)}` as unknown as T)
    .then((value) => ({ timedOut: false as const, value }));
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([work, timeout]);
}

/**
 * 可取消超时守卫：超时不仅返回 timedOut，还会 abort 子信号，让支持 AbortSignal 的
 * 模型请求/命令执行真正停止。对不观察 signal 的同步工具仍只能做到“停止等待”。
 */
export async function withAbortableTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number | undefined,
  parentSignal?: AbortSignal
): Promise<{ timedOut: boolean; value?: T }> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    if (!ctrl.signal.aborted) ctrl.abort(parentSignal?.reason);
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  const run = work(ctrl.signal)
    .catch((e: any) => `⚠️ 工具执行出错：${e?.message ?? String(e)}` as unknown as T)
    .then((value) => ({ timedOut: false as const, value }));
  if (!ms || ms <= 0) {
    try { return await run; } finally {
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (!ctrl.signal.aborted) ctrl.abort(new Error(`TOOL_TIMEOUT:${ms}`));
      resolve({ timedOut: true });
    }, ms);
  });
  try {
    const result = await Promise.race([run, timeout]);
    // 若父信号先 abort，work 通常会很快以 AbortError 收敛；保留该错误文本，
    // 不把用户取消误报为 timeout。
    return timedOut ? { timedOut: true } : result;
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * 解析 ReAct 文本协议中的工具调用。
 *
 * 支持两种格式：
 *  1) 显式 <tool_call>...</tool_call> 标签（推荐、精确）
 *  2) Markdown 代码围栏 ```json\n{"name":"...", "arguments":{}}\n```
 *     某些模型即使被指示用 <tool_call> 仍会输出 markdown 代码块，这里兜底解析。
 *
 * 免费 DeepSeek 服务（deepseek-free-api）会把整段对话压平成一条文本发给
 * DeepSeek 网页端，网页端不支持原生 function calling，因此 `tools` 参数被服务端
 * 直接丢弃。我们改用文本协议：由本函数解析后真正执行工具，再把结果回填给模型继续推理。
 */
export function parseToolCalls(text: string): { name: string; arguments: any }[] {
  const calls: { name: string; arguments: any }[] = [];

  // 1) 显式 <tool_call> 标签
  const tagRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const jsonStr = m[1].trim();
    try {
      const obj = JSON.parse(jsonStr);
      if (obj && typeof obj.name === "string") {
        calls.push({ name: obj.name, arguments: obj.arguments ?? {} });
      }
    } catch {
      // 非法 JSON 由调用方提示模型重试
    }
  }

  // 2) Markdown 代码围栏兜底：```json ... ``` 或 ``` ... ``` 内含有 name/arguments 的 JSON
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  while ((m = fenceRe.exec(text)) !== null) {
    const jsonStr = m[1].trim();
    try {
      const obj = JSON.parse(jsonStr);
      if (obj && typeof obj.name === "string") {
        calls.push({ name: obj.name, arguments: obj.arguments ?? {} });
      }
    } catch {
      // 不是工具 JSON 的普通代码块，忽略
    }
  }

  return calls;
}

/** 从文本中移除所有 ReAct 工具调用痕迹（用于前端隐藏原始工具调用文本）。 */
export function stripToolCalls(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/```(?:json)?\s*\n?([\s\S]*?)```/g, (_match, inner: string) => {
      try {
        const obj = JSON.parse(inner.trim());
        if (obj && typeof obj.name === "string") return "";
      } catch {
        /* 普通代码块保留 */
      }
      return _match;
    })
    .trim();
}

/** 工具名模糊纠正：先包含关系，再编辑距离（≤2）。mcp__/conn__ 动态工具由上层分支处理，不在此列。 */
export function fuzzyResolveTool(name: string, tools: ToolDefinition[]): string | null {
  if (name.startsWith("mcp__") || name.startsWith("conn__")) return null;
  const names = tools.map((t) => t.function.name);
  if (names.includes(name)) return name;
  // 1) 包含关系（覆盖 list_directorylist_directory → list_directory 这类重复拼接）
  for (const n of names) {
    if (name.includes(n) || n.includes(name)) return n;
  }
  // 2) 编辑距离（覆盖轻微拼写错误）
  let best: string | null = null;
  let bestD = 3;
  for (const n of names) {
    const d = levenshtein(name, n);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return bestD <= 2 ? best : null;
}

/** 编辑距离（Levenshtein），工具名纠错与模糊匹配用。 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[n];
}
