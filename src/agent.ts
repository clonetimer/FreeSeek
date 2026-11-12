// check:max-lines 800 (待拆分：runAgent 内 budget/context 状态机拆出后减小；v0.17.6 加固重复检测 + normalizeArgsKey 后行数上升，v0.17.8 加 STREAM_IDLE_MS 常量 + truncateToolResult 串联后上升，v0.17.16 todo 分解 nudge 再升)
/**
 * Agent 主循环：模型可连续发起工具调用，本函数负责执行并把结果回灌给模型。
 * 共享类型见 agent-types.ts，命名子智能体注册表见 agent-registry.ts，
 * 子智能体执行（runSubAgent）见 agent-subagent.ts。
 */
import {
  ChatMessage,
  ToolCall,
  ToolDefinition,
  streamChat,
  streamChatWithIdleTimeout,
  summarizeConversation,
} from "./provider";
import { copyResponsesOutputState } from "./provider-responses";
import { ToolContext, TOOL_DEFINITIONS } from "./tools";
import { preCompactHook, subagentStartHook } from "./hooks";
import { usageRatio, conversationTokens, tieredCompact, BudgetTracker } from "./context";
import { extractDurableMemory } from "./memory";
import { estimateCost } from "./pricing";
import { resolveActiveConfig, resolveConfigFor, ModelOverride } from "./providers";
import { appendEvent, conversationForEventLog, messageForEventLog } from "./eventlog";
import { bumpGoalRound } from "./goal";
import { jobRegistry } from "./jobs";
import {
  runBounded,
  trimUnfinishedTurn,
  parseToolCalls,
  stripToolCalls,
  fuzzyResolveTool,
  TOOL_PARALLEL_LIMIT,
  needsTodoNudge,
  TODO_NUDGE_MESSAGE,
} from "./agent-utils";
import { subAgentRegistry, busyAgents } from "./agent-registry";
import { runSubAgent } from "./agent-subagent";
import { ToolRuntime } from "./tool-runtime";
import type { ToolExecutorOverrides } from "./tool-registry";
import { captureWorkspaceCheckpoint } from "./workspace-timeline";
import { applyContextPlanner } from "./agent-context-planner";
import { acquireExtensionRunBoundary } from "./kernel/extensions/run-boundary";
import type { AgentCallbacks } from "./agent-types";
export type { AgentCallbacks, SubAgentHandle } from "./agent-types";
export { clearSubAgentRegistry } from "./agent-registry";
export { runSubAgent } from "./agent-subagent";
/** 流空闲看门狗阈值（ms）：模型开始流式响应后超过该时长未吐出任何增量 token 即中断。
 *  对齐 Claude Code CLAUDE_STREAM_IDLE_TIMEOUT_MS（默认 90s），防服务假死/网络挂起导致整轮 hang。 */
export const STREAM_IDLE_MS = 90_000;
/**
 * 工具参数归一化键：用于重复调用检测。
 * 攻击面：模型可通过微调参数（增减空白/注释、调整无关字段顺序）伪装成"新调用"，
 * 绕过「参数完全相等」的死循环检测，空转到步数/墙钟上限浪费 token。
 * 这里对参数做结构化归一化：递归排序对象 key、剥离字符串首尾与中间多余空白、
 * 移除形如 `//...` 或 `#...` 的行内注释，使语义等价的调用归并为同一键。
 */
export function normalizeArgsKey(args: any): string {
  const norm = (v: any): any => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "string") return v.replace(/\/\/[^\n]*|#[^\n]*/g, "").replace(/\s+/g, " ").trim();
      return v;
    }
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  };
  try {
    return JSON.stringify(norm(args));
  } catch {
    return JSON.stringify(args);
  }
}
/**
 * 判断一段纯文本是否「几乎完全由任务/待办清单构成、缺乏任何结论性内容」。
 * 用于 lazy-nudge：当模型无 tool_use 退出、回复疑似只丢给用户一个计划清单
 * （如截图场景「了解文件夹功能」只返回任务清单）时，推动其给出结构化总结。
 * 命中条件：至少 3 行，且其中 ≥80% 的行是 checkbox / 列表项，且不含明显的总结性标记
 * （如「总结」「技术栈」「入口」「功能」等），避免误伤正常带列表的总结回复。
 */
export function looksLikeTaskListOnly(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  // 行首列表项：`-`/`*` 项目、数字序号（1. 或 1、）、或 checkbox（`- [ ]`/`- [x]`）
  const listRe = /^(-|\*|\d+\.|\d+、|[-*]\s*\[[ xX]\])/;
  const listCount = lines.filter((l) => listRe.test(l)).length;
  if (listCount / lines.length < 0.8) return false;
  const summaryMarker = /(总结|概述|技术栈|入口|使用方式|主要功能|架构|模块|定位|怎么做|如何运行)/;
  if (summaryMarker.test(text)) return false;
  return true;
}
/**
 * 运行一次 Agent 回合：模型可连续发起工具调用，本函数负责执行并把结果
 * 回灌给模型，直到模型不再调用工具或达到步数上限。
 *
 * 工具调用来源有两路：
 *  1) 原生 function calling（官方 DeepSeek API，会返回 delta.tool_calls）；
 *  2) ReAct 文本协议（免费服务，从 assistant 文本中解析 <tool_call> 块）。
 * 两路统一为内部 ToolCall 结构后执行。
 */
export async function runAgent(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  toolCtx: ToolContext,
  cb: AgentCallbacks
): Promise<ChatMessage[]> {
  const maxSteps = toolCtx.runtime?.maxSteps ?? 25;
  const contextBudget = toolCtx.runtime?.contextBudget ?? 32000;
  const wallClockMs = toolCtx.runtime?.maxWallClockMs ?? 10 * 60 * 1000;
  // 若当前 provider 声明了模型真实上下文窗口（本地小模型常远小于 32K），
  // 以 min(contextBudget, contextWindow) 作为压缩触发预算，避免请求先超窗被服务端拒绝。
  // 多模型分工：子智能体带 modelOverride 时，按其覆盖模型的窗口计算。
  let effectiveBudget = contextBudget;
  let traceProvider = "unknown";
  let traceModel = "unknown";
  try {
    const rc = toolCtx.modelOverride ? resolveConfigFor(toolCtx.modelOverride) : resolveActiveConfig();
    traceProvider = rc.providerName || "unknown";
    traceModel = rc.model || "unknown";
    if (rc.contextWindow && rc.contextWindow > 0) {
      effectiveBudget = Math.min(contextBudget, rc.contextWindow);
    }
  } catch {
    /* 未配置 provider 时忽略，沿用默认预算 */
  }
  let steps = 0;
  let contextWarned = false;
  // lazy-nudge 限次开关：模型无 tool_use 但仅返回任务清单时，最多推动一轮（见下方退出分支）
  let lazyNudgeUsed = false;
  // todo 分解 nudge 限次开关：面板仍为单条种子任务（未分解）时，最多推动一轮让模型调用 todo_write
  let todoNudgeUsed = false;
  // Layer 7 用量统计（真实 token，来自 streamChat 的 onUsage；缺失时回退估算）
  let totalPrompt = 0;
  let totalCompletion = 0;
  // Layer 7 工具调用总次数（审计明细）
  let toolCallTotal = 0;
  // 重复工具调用提醒窗口（跨轮检测：同一工具+相同参数连续出现 3 次时提醒模型更换思路）
  const repeatWindow: { name: string; key: string }[] = [];
  const runSignal = cb.signal ?? toolCtx.signal;
  if (runSignal) toolCtx.signal = runSignal;
  const eventActor = toolCtx.eventActor ?? "main";
  const event = (type: string, data?: unknown) =>
    toolCtx.eventLog?.append(type, data, eventActor) ?? appendEvent(type, data, eventActor);
  const persistMessage = (message: ChatMessage) =>
    toolCtx.eventLog?.persistMessage(message) ?? messageForEventLog(message);
  const persistConversation = (current: readonly ChatMessage[]) =>
    toolCtx.eventLog?.persistConversation(current) ?? conversationForEventLog(current);
  let releaseExtensionRun: (() => Promise<void>) | undefined;
  try {
  // General HMR：每个 Agent run 在边界获取 immutable generation lease；子 Agent retain 同一快照。
  const extensionRun = acquireExtensionRunBoundary(toolCtx);
  releaseExtensionRun = () => extensionRun.release();
  const mergedTools = extensionRun.merge(tools);
  // 按 ToolContext 约束裁剪工具集：子智能体据此限定权限（白名单 + 禁止递归派发）
  const effectiveTools = mergedTools.filter((t) => {
    if (toolCtx.toolWhitelist && !toolCtx.toolWhitelist.includes(t.function.name)) return false;
    if (!toolCtx.canSpawn && (t.function.name === "spawn_agent" || t.function.name === "spawn_agents")) return false;
    return true;
  });
  // Layer 7：三维预算（轮次 / token / 墙钟），不依赖模型自我判断
  const budget = new BudgetTracker({
    maxTurns: maxSteps,
    maxTokens: effectiveBudget,
    maxWallClockMs: wallClockMs,
  });
  const snapshot = (reason: string) => {
    const logged = persistConversation(messages);
    event("conversation/snapshot", { ...logged, reason });
  };
  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  /** Agent 原生工具 body：编排能力也由 ToolRuntime 包裹，只把真正执行体留在 Agent 层。 */
  const executeAgentToolBody = async (
    name: string,
    args: any,
    bodyCtx: ToolContext
  ): Promise<string | undefined> => {
    if (name === "spawn_agent") {
      const subName = args.agent || args.role || args.mode || "subagent";
      cb.onSubAgentStart?.(subName, String(args.task ?? ""));
      cb.onContextStatus?.(subagentStartHook(subName));
      if (args.run_in_background) {
        const taskId = jobRegistry.start("subagent", subName);
        const jobSignal = jobRegistry.signal(taskId);
        event("subagent", { name: subName, background: true, taskId });
        void runSubAgent(args, bodyCtx, cb, jobSignal)
          .then((report) => {
            if (jobRegistry.get(taskId)?.status === "killed") return;
            jobRegistry.appendOutput(taskId, report);
            jobRegistry.settle(taskId, "completed");
            cb.onSubAgentEnd?.(report);
            cb.onNotification?.({
              title: "后台子智能体完成",
              body: `${subName}（${taskId}）：${report.slice(0, 160)}`,
            });
          })
          .catch((e: any) => {
            if (jobRegistry.get(taskId)?.status === "killed") {
              cb.onNotification?.({
                title: "后台子智能体已终止",
                body: `${subName}（${taskId}）已响应 job_kill。`,
              });
              return;
            }
            jobRegistry.settle(taskId, "failed", e?.message ?? String(e));
            cb.onNotification?.({
              title: "后台子智能体失败",
              body: `${subName}（${taskId}）：${e?.message ?? String(e)}`,
            });
          });
        return `已在后台启动子智能体（taskId=${taskId}），可用 job_list / job_output / job_kill 管理，完成后将通过通知回报结论，不阻塞主流程。`;
      }
      event("subagent", { name: subName, background: false });
      const report = await runSubAgent(args, bodyCtx, cb, bodyCtx.signal);
      cb.onSubAgentEnd?.(report);
      return report;
    }

    if (name === "spawn_agents") {
      const agents = Array.isArray(args.agents) ? args.agents.slice(0, 4) : [];
      if (agents.length < 2) return "⚠️ spawn_agents 需要至少 2 个并行子任务（agents 数组）。";
      const results = await Promise.all(
        agents.map((a: any) => {
          const subName = a.label || a.role || a.mode || "subagent";
          cb.onSubAgentStart?.(subName, String(a.task ?? ""));
          return runSubAgent({ ...a, role: a.role, mode: a.mode }, bodyCtx, cb, bodyCtx.signal)
            .then((report) => ({ label: subName, report }));
        })
      );
      const merged = results
        .map((r, i) => `### 子任务 ${i + 1}：${r.label}\n${r.report}`)
        .join("\n\n");
      event("subagents", { count: results.length, labels: results.map((r) => r.label) });
      cb.onSubAgentEnd?.(`并行 ${results.length} 个子任务完成`);
      return `并行完成 ${results.length} 个子任务：\n\n${merged}`;
    }

    if (name === "send_message") {
      const target = String(args.target ?? "");
      const handle = subAgentRegistry.get(target);
      if (!handle) return `⛔ 未找到名为「${target}」的命名子智能体。请先用 spawn_agent({task, name:"..."}) 派发并命名。`;
      if (busyAgents.has(target)) return `⛔ 子智能体「${target}」正忙（正在处理另一条消息），请稍后重试或等其完成。`;
      cb.onContextStatus?.(`📨 向子智能体「${target}」发送消息并续跑…`);
      handle.messages.push({ role: "user", content: String(args.message ?? "") });
      busyAgents.add(target);
      let out2: ChatMessage[];
      try {
        event("send_message", { target });
        const continuedCtx: ToolContext = { ...handle.ctx, signal: bodyCtx.signal };
        const continuedCb: AgentCallbacks = { ...handle.cb, signal: bodyCtx.signal };
        out2 = await runAgent(
          handle.messages,
          [...(handle.ctx.toolDefinitions ?? TOOL_DEFINITIONS)],
          continuedCtx,
          continuedCb
        );
      } finally {
        busyAgents.delete(target);
      }
      subAgentRegistry.set(target, { messages: out2, ctx: handle.ctx, cb: handle.cb, label: handle.label });
      for (let i = out2.length - 1; i >= 0; i--) {
        if (out2[i].role === "assistant") {
          const text = (out2[i].content || "").trim();
          if (text) return text;
        }
      }
      return "（子智能体未返回结论）";
    }

    return undefined;
  };
  const executorOverrides: ToolExecutorOverrides = {
    spawn_agent: async (args, bodyCtx) => String((await executeAgentToolBody("spawn_agent", args, bodyCtx)) ?? ""),
    spawn_agents: async (args, bodyCtx) => String((await executeAgentToolBody("spawn_agents", args, bodyCtx)) ?? ""),
    send_message: async (args, bodyCtx) => String((await executeAgentToolBody("send_message", args, bodyCtx)) ?? ""),
  };
  const toolRegistry = await extensionRun.createRegistry(effectiveTools, executorOverrides);
  // Provider 看到的 schema 与 Runtime 真正可执行的注册快照必须来自同一 Registry，
  // 避免 run 中途定义数组被修改后出现“模型看得到但 Runtime 不认”或反向漂移。
  const registeredTools = toolRegistry.definitions();
  extensionRun.mountSkills(registeredTools.map((definition) => definition.function.name));
  // 基础 schema 与 HMR generation 分开保存；当前子 Agent retain 固定快照，下一独立 turn 可见新 generation。
  toolCtx.toolDefinitions = extensionRun.baseDefinitions(registeredTools);
  const toolRuntime = new ToolRuntime(toolCtx, toolRegistry, {
    requestApproval: cb.onPermissionRequest,
    onTimeout: () => {},
    onStatus: (text) => cb.onContextStatus?.(text),
  });
  // 只有 Registry/Runtime 成功构建后才承认一个 durable turn 已开始；
  // 这样启动阶段配置错误不会留下没有 turn/end 的半截生命周期。
  const extensionLeaseEvent = extensionRun.eventData();
  if (extensionLeaseEvent) event("extension/lease", extensionLeaseEvent);
  event("turn/start", { turnId, messageCount: messages.length, startedAt: Date.now() });
  if (eventActor === "main") {
    try {
      captureWorkspaceCheckpoint(
        toolCtx,
        `freesek-turn-start:${turnId}`,
        "auto",
        true
      );
    } catch {
      /* 无 git / 存储不可写时 EventLog 仍可运行，只失去 workspace time-travel anchor。 */
    }
  }
  messages = applyContextPlanner(messages, registeredTools.length, toolCtx, cb, event, persistMessage);
  snapshot("run_start");
  let turnReason: "completed" | "budget" | "aborted" | "error" = "completed";
  let turnError = "";
  let stepOpen = false;
  const endStep = (data: Record<string, unknown>) => {
    if (!stepOpen) return;
    event("step/end", data);
    stepOpen = false;
  };
  try {
    while (true) {
    if (runSignal?.aborted) {
      throw runSignal.reason instanceof Error ? runSignal.reason : new Error("Agent 已取消");
    }
    steps++;
    // 三维预算检查（循环顶部，加新条件只改一处）
    const tokens = conversationTokens(messages);
    const [exhausted, reason] = budget.check(steps, tokens);
    if (exhausted) {
      messages.push({
        role: "system",
        content: `⚠️ ${reason} 请基于已有结果给出总结，或开启新会话继续。`,
      });
      cb.onContextStatus?.(`⚠️ ${reason}（已执行 ${steps} 步）`);
      turnReason = "budget";
      break;
    }
    event("step/start", { turnId, step: steps, messageCount: messages.length, tokens });
    stepOpen = true;
    // Layer 7：上下文预算感知 —— 70% 预警、85% 主动分级压缩
    // 复用上方已算出的 tokens，避免 usageRatio 内部对全部消息二次全量估算（性能）
    const ratio = effectiveBudget > 0 ? tokens / effectiveBudget : 0;
    const convLen = messages.filter((m) => m.role !== "system").length;
    // 触发条件：① 预算 85%；② 消息数兜底（仅对小窗口模型生效——effectiveBudget 被模型
    // contextWindow 压小时，token 估算不可靠，用消息数保护；大窗口模型按 85% 预算触发，
    // 避免消息数一多就在低占比下过早压缩）。
    if (ratio >= 0.85 || (convLen >= 30 && effectiveBudget < contextBudget)) {
      // PreCompact Hook：压缩前钉住任务目标（确定性保证，跨压缩持久）。
      // goal 状态机存在时优先锚定其 objective（较 user 消息启发式更稳）。
      const preNote = await preCompactHook(messages, toolCtx.workspaceRoot, toolCtx.goalState);
      if (preNote) cb.onContextStatus?.(preNote);
      cb.onContextStatus?.(`上下文已使用 ${(ratio * 100).toFixed(0)}%，正在分级压缩历史…`);
      messages = await tieredCompact(
        messages,
        cb.onContextStatus,
        12,
        16,
        async (oldText) => {
          // 压缩前抽取持久事实写入记忆（best-effort，失败不影响压缩）
          try {
            const r = await extractDurableMemory(
              oldText,
              toolCtx.workspaceRoot,
              toolCtx.userMemoryPath ?? ""
            );
            if (r.count > 0) {
              cb.onContextStatus?.(`🧠 已从压缩历史抽取 ${r.count} 条持久记忆`);
            }
          } catch {
            /* 忽略 */
          }
        },
        // 多模型分工：子智能体的压缩摘要也用其覆盖模型
        toolCtx.modelOverride
      );
      event("compact", {
        trigger: ratio >= 0.85 ? "budget_85%" : "message_count",
        ratio: Number(ratio.toFixed(3)),
        tokens,
        budget: effectiveBudget,
      });
      snapshot("compact");
      contextWarned = false;
    } else if (ratio >= 0.7 && !contextWarned) {
      const warningMessage: ChatMessage = {
        role: "system",
        content: `⚠️ 上下文已使用 ${(ratio * 100).toFixed(0)}%。请避免读取大文件，优先关键步骤；如需继续大量探索，建议开新会话。`,
      };
      messages.push(warningMessage);
      event("system/message", { message: persistMessage(warningMessage).message });
      contextWarned = true;
      cb.onContextStatus?.(`上下文已使用 ${(ratio * 100).toFixed(0)}%`);
    }
    // todo 分解 nudge（对标 lazy-nudge）：面板仍只有单条「进行中」种子任务（模型未主动调用
    // todo_write 分解）且已执行 ≥2 步工具调用 → 注入推动消息让模型补充分解。限次 1 次，
    // 避免被小模型/免费模型"只干活不规划"卡在整条需求单任务上。
    if (!todoNudgeUsed && needsTodoNudge(toolCtx.todoState.items, steps)) {
      todoNudgeUsed = true;
      cb.onContextStatus?.("⚠️ 任务面板仍为单条种子任务，已推动模型用 todo_write 分解步骤");
      const nudgeMessage: ChatMessage = { role: "user", content: TODO_NUDGE_MESSAGE };
      messages.push(nudgeMessage);
      const loggedNudge = persistMessage(nudgeMessage);
      event("user/message", { ...loggedNudge });
      endStep({ turnId, step: steps, toolCalls: 0, finishReason: "todo_nudge" });
      continue;
    }
    // 工具循环节流：连续多轮请求可能触发 DeepSeek 免费端限流/禁言，轮间稍作停顿
    if (steps > 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
    let toolCalls: ToolCall[] = [];
    let rawContent = "";
    // 循环内 try/catch 赋值后必 break 或抛错（streamError），TS 流分析无法跨分支证明已赋值，用断言消除 TS2454
    let message!: ChatMessage;
    let finishReason = "";
    let streamError: unknown = null;
    // 超限自动降级：本地小模型窗口（如 8K）装不下历史时，服务端直接返回
    // exceed_context_size_error（400）。此时自动截断最旧历史后重试（最多 2 次），
    // 而不是让整个回合失败——这正是"一直不回复/只出错误卡"的直接原因之一。
    for (let attempt = 0; attempt < 3; attempt++) {
      toolCalls = [];
      rawContent = "";
      finishReason = "";
      const basePrompt = totalPrompt;
      const baseCompletion = totalCompletion;
      const requestStartedAt = Date.now();
      let requestPrompt = 0, requestCompletion = 0;
      event("model/request", { turnId, step: steps, attempt: attempt + 1, provider: traceProvider, model: traceModel, messageCount: messages.length, toolCount: registeredTools.length, startedAt: requestStartedAt });
      try {
        const streamed = await streamChatWithIdleTimeout(
            STREAM_IDLE_MS,
            messages,
            registeredTools,
            {
              onText: (d) => {
                rawContent += d;
                cb.onAssistantText(d);
              },
              onReasoning: cb.onReasoning,
              onToolCalls: (calls) => {
                toolCalls = calls;
              },
              onUsage: (u) => {
                requestPrompt = u.prompt_tokens; requestCompletion = u.completion_tokens;
                totalPrompt += requestPrompt; totalCompletion += requestCompletion;
              },
              signal: runSignal,
            },
            // 多模型分工：子智能体按其 modelOverride 走指定模型，主 Agent 传 undefined 用全局活动模型
            toolCtx.modelOverride
          );
        message = streamed.message;
        finishReason = streamed.finishReason;
        event("model/result", { turnId, step: steps, attempt: attempt + 1, provider: traceProvider, model: traceModel, durationMs: Date.now() - requestStartedAt, promptTokens: requestPrompt, completionTokens: requestCompletion, totalTokens: requestPrompt + requestCompletion, finishReason });
        streamError = null;
        break;
      } catch (e) {
        totalPrompt = basePrompt;
        totalCompletion = baseCompletion;
        event("model/result", { turnId, step: steps, attempt: attempt + 1, provider: traceProvider, model: traceModel, durationMs: Date.now() - requestStartedAt, promptTokens: 0, completionTokens: 0, totalTokens: 0, error: String((e as any)?.message ?? e).slice(0, 2000) });
        const errMsg = String((e as any)?.message ?? e);
        const isCtxError =
          /exceed_context_size|context (size|length|window)|context_window|ctx window/i.test(
            errMsg
          );
        // 已产生部分输出则不能安全重试（避免内容重复）；消息数太少无历史可截，直接上报
        const hasOutput = rawContent.length > 0 || toolCalls.length > 0;
        const convCount = messages.filter((m) => m.role !== "system").length;
        if (!isCtxError || hasOutput || attempt >= 2 || convCount <= 8) {
          streamError = e;
          break;
        }
        cb.onContextStatus?.(
          `⚠️ 模型上下文不足（${errMsg.slice(0, 90)}），正在截断最旧历史后重试…（第 ${attempt + 1}/2 次）`
        );
        messages = await truncateForRetry(messages, cb.onContextStatus, 10, toolCtx.modelOverride);
        snapshot("retry_truncate");
      }
    }
    if (streamError) {
      endStep({ turnId, step: steps, toolCalls: toolCalls.length, finishReason, error: String((streamError as any)?.message ?? streamError) });
      throw streamError;
    }

    // 优先使用原生工具调用；免费服务无原生 tool_calls，回退到 ReAct 文本解析
    if (toolCalls.length === 0) {
      const parsed = parseToolCalls(message.content);
      if (parsed.length > 0) {
        toolCalls = parsed.map((p, i) => ({
          id: `call_react_${steps}_${i}`,
          type: "function" as const,
          function: { name: p.name, arguments: JSON.stringify(p.arguments) },
        }));
        // 让前端移除流式显示出来的原始 <tool_call> 块，改用干净的 tool UI
        cb.onStripToolCall?.();
      }
    }

    if (toolCalls.length === 0) {
      // 模型给出纯文本答复。借鉴 Claude Code 主循环「无 tool_use 不直接放弃，先诊断」的
      // 工程纪律：若本轮答复几乎完全由 checkbox / 待办列表构成（疑似只返回任务清单、
      // 未给出任何结论），且尚未做过一次 lazy-nudge，则注入推动消息再跑一轮，迫使模型
      // 基于已读文件直接输出结构化总结，而不是把计划清单当最终答案结束对话。
      // 限次 1 次，避免被恶意/异常模型拖入死循环（硬上限 maxSteps / 墙钟仍兜底）。
      const finalText = (message.content ?? "").trim();
      if (!lazyNudgeUsed && looksLikeTaskListOnly(finalText)) {
        lazyNudgeUsed = true;
        cb.onContextStatus?.("⚠️ 检测到回复疑似仅含任务清单、无结论，已推动模型给出最终总结");
        messages.push(message);
        event("assistant/message", { message: persistMessage(message).message, step: steps });
        const lazyNudge: ChatMessage = {
          role: "user",
          content:
            "你刚才只返回了一个任务/待办清单，但这不是最终答案。请基于你已读取的文件，" +
            "直接输出结构化的项目总结（功能定位、技术栈、主要模块/文件、入口与使用方式），" +
            "不要再把计划当结论。若信息不足，请继续读取 README / package.json / 核心入口后再总结。",
        };
        messages.push(lazyNudge);
        const loggedLazy = persistMessage(lazyNudge);
        event("user/message", { ...loggedLazy });
        endStep({ turnId, step: steps, toolCalls: 0, finishReason });
        continue;
      }
      // 模型给出最终答复，结束
      messages.push(message);
      event("assistant/message", { message: persistMessage(message).message, step: steps });
      // 最终答复后不应遗留待闭合的 tool_calls；若因异常仍残留，清理掉，避免污染下轮
      messages = trimUnfinishedTurn(messages);
      endStep({ turnId, step: steps, toolCalls: 0, finishReason });
      break;
    }

    // 关键：必须把 model 返回的 tool_calls 一并写回 assistant 消息。
    // DeepSeek 官方等原生 function calling 要求紧跟在 tool 消息前的 assistant 消息携带
    // tool_calls（且 tool_call_id 与之对应），否则报：
    // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'。
    // 修复：原实现只读 message.tool_calls（原生模式有值），但 ReAct 文本解析模式
    // 下 toolCalls 是从 content 里解析出来的，message.tool_calls 为空——这种情况不写入
    // 就会导致下一轮 400。这里改用「parsed toolCalls」作为权威源，与下方循环使用的
    // call.id 严格对齐（call_react_* / 原生 delta id），保证 tool 消息能找到对应 assistant。
    // 同时清理 content 中残留的工具调用文本（部分 OpenAI 兼容服务对 content+tool_calls
    // 同时存在处理不标准，会误判为 tool 消息前无 tool_calls）。
    const effectiveToolCalls = toolCalls.length > 0 ? toolCalls : (message as any).tool_calls ?? undefined;
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: effectiveToolCalls ? stripToolCalls(message.content ?? "") : message.content,
    };
    if (message.reasoning_content) assistantMsg.reasoning_content = message.reasoning_content;
    copyResponsesOutputState(message, assistantMsg, effectiveToolCalls);
    if (effectiveToolCalls) {
      (assistantMsg as any).tool_calls = effectiveToolCalls;
    }
    messages.push(assistantMsg);
    event("assistant/message", {
      message: persistMessage(assistantMsg).message,
      step: steps,
    });

    let invalidJson = false;
    // ── 并行工具执行（借鉴 deepseek-harness：isConcurrencySafe + 有界并发池）──
    // 模型一次返回的多个 tool_calls 中，只读类工具（read/search/grep/lsp/web 等）彼此
    // 无副作用、可并行执行；写操作/有状态工具作为屏障保持串行，保证执行语义不变。
    // 执行结果一律按原始调用顺序写回，保证 tool_call_id 序列与模型请求严格对齐。
    const toolOutcomes: { call: ToolCall; content: string }[] = [];

    /** 执行单个工具调用：全部工具统一进入 ToolRuntime，结果再按模型协议回灌。 */
    const runOneToolCall = async (call: ToolCall): Promise<string> => {
      let args: any = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        invalidJson = true;
        args = {};
      }

      toolCallTotal++;
      const agentNative = ["spawn_agent", "spawn_agents", "send_message"].includes(call.function.name);
      if (!agentNative) cb.onToolStart(call);
      const outcome = await toolRuntime.execute(call.function.name, args, { callId: call.id });
      let result = outcome.result;
      if (!agentNative) cb.onToolResult(call, result);

      // 重复工具调用提醒：统一在 Runtime 最终结果之后判定，动态 MCP/connector 也不能绕过。
      const argsKey = normalizeArgsKey(args);
      const window = repeatWindow.slice(-2);
      const isExactRepeat =
        window.length === 2 && window.every((x) => x.name === call.function.name && x.key === argsKey);
      const resultSig = result.slice(0, 200).replace(/\s+/g, " ").trim();
      const isNoProgress =
        window.length === 2 &&
        window.every((x) => x.name === call.function.name) &&
        repeatWindow.slice(-2).every((x) => (x as any).resultSig === resultSig) &&
        resultSig.length > 0;
      repeatWindow.push({ name: call.function.name, key: argsKey, resultSig } as any);
      if (isExactRepeat || isNoProgress) {
        const tip =
          `\n\n⚠️ 提醒：你已连续 3 次调用同一工具「${call.function.name}」且未产生进展。` +
          `若前两次结果未能推进任务，请更换思路、调整参数，或直接向用户说明结论，避免无效重复调用。`;
        result += tip;
        cb.onContextStatus?.(`⚠️ 检测到连续重复调用「${call.function.name}」，已提醒模型更换思路`);
      }
      return `<tool_result name="${call.function.name}">\n${result}\n</tool_result>`;
    };

    // 工具名容错统一预处理（并行前一次性纠正，避免执行期竞态修改 call.function.name）
    for (const call of toolCalls) {
      if (
        !call.function.name.startsWith("mcp__") &&
        !call.function.name.startsWith("conn__")
      ) {
        if (!toolRegistry.has(call.function.name)) {
          const fixed = fuzzyResolveTool(call.function.name, registeredTools);
          if (fixed) {
            cb.onContextStatus?.(
              `🛠 工具名「${call.function.name}」未识别，已自动纠正为「${fixed}」`
            );
            call.function.name = fixed;
          }
        }
      }
    }

    // 调度：安全工具连续段并行（有界并发），非安全工具作为屏障串行执行
    for (let idx = 0; idx < toolCalls.length; ) {
      const call = toolCalls[idx];
      if (toolRegistry.isConcurrencySafe(call.function.name)) {
        const batch: ToolCall[] = [];
        while (idx < toolCalls.length && toolRegistry.isConcurrencySafe(toolCalls[idx].function.name)) {
          batch.push(toolCalls[idx]);
          idx++;
        }
        const contents = await runBounded(batch, TOOL_PARALLEL_LIMIT, runOneToolCall);
        for (let k = 0; k < batch.length; k++) {
          toolOutcomes.push({ call: batch[k], content: contents[k] });
        }
      } else {
        const content = await runOneToolCall(call);
        toolOutcomes.push({ call, content });
        idx++;
      }
    }

    // 按原始调用顺序写回 tool 消息（严格对齐 tool_call_id）
    for (const o of toolOutcomes) {
      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: o.call.id,
        content: o.content,
      };
      messages.push(toolMessage);
      event("tool/message", { message: persistMessage(toolMessage).message, name: o.call.function.name });
    }

    // 工具轮结束后做最终序列清理：若因异常/停止导致仍有未闭合的 tool_calls，回滚掉，
    // 保证下一轮请求满足 "tool 消息前必须有对应 assistant.tool_calls" 的协议约束。
    messages = trimUnfinishedTurn(messages);

    // Loop：任务清单若有变化，回传前端渲染（每次工具轮后同步一次即可）
    cb.onTodos?.(toolCtx.todoState.items.map((it) => ({
      content: it.content,
      status: it.status,
      activeForm: it.activeForm,
    })));

    // 目标状态机（goal）：active 目标每工具轮自动推进轮次预算并回传前端。
    // 轮次为会话内预算（不写盘），目标描述/阶段在 goal 操作时持久化。
    if (toolCtx.goalState) {
      bumpGoalRound(toolCtx.goalState);
      const g = toolCtx.goalState;
      cb.onGoal?.({
        objective: g.objective,
        phase: g.phase,
        roundsStarted: g.roundsStarted,
        maxRounds: g.maxRounds,
        blockedReason: g.blockedReason,
      });
    }

    if (invalidJson) {
      // 模型输出的工具 JSON 无法解析，提示它用合法 JSON 重试（计入步数上限，避免死循环）
      const invalidJsonMessage: ChatMessage = {
        role: "user",
        content:
          "你输出的 <tool_call> 块内 JSON 无法解析，请只输出一个合法的 JSON 对象，例如：\n" +
          '<tool_call>\n{"name":"read_file","arguments":{"path":"src/main.ts"}}\n</tool_call>',
      };
      messages.push(invalidJsonMessage);
      const loggedInvalid = persistMessage(invalidJsonMessage);
      event("user/message", { ...loggedInvalid });
    }

    endStep({ turnId, step: steps, toolCalls: toolCalls.length, finishReason });
    cb.onStep(steps, `完成第 ${steps} 步工具调用，继续让模型综合结果…`);
  }

  // Layer 7 可观测性：单轮运行统计回传前端（轮次 / token / 上下文占比 / 估算成本）。
  // 多模型分工：子智能体按覆盖模型计算成本（主 Agent 传 undefined → 全局活动模型）。
  let model = "";
  try {
    model = (toolCtx.modelOverride ? resolveConfigFor(toolCtx.modelOverride) : resolveActiveConfig()).model;
  } catch {
    /* 取不到模型不影响主流程，成本按 default 估算 */
  }
  const cost = estimateCost(model, totalPrompt, totalCompletion);
  cb.onObservability?.({
    turns: steps,
    tokens: conversationTokens(messages),
    ratio: usageRatio(messages, contextBudget),
    cost,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
    toolCalls: toolCallTotal,
  });

  return messages;
  } catch (e: any) {
    turnReason = runSignal?.aborted ? "aborted" : "error";
    turnError = e?.message ?? String(e);
    endStep({
      turnId,
      step: steps,
      toolCalls: 0,
      finishReason: "error",
      error: turnError.slice(0, 2000),
    });
    throw e;
  } finally {
    try {
      event("turn/end", {
        turnId,
        reason: turnReason,
        steps,
        endedAt: Date.now(),
        ...(turnError ? { error: turnError.slice(0, 2000) } : {}),
      });
      if (extensionLeaseEvent) event("extension/release", extensionLeaseEvent);
    } finally {
      await extensionRun.release();
    }
  }
  } finally { await releaseExtensionRun?.(); }
}

/**
 * 超限降级：保留 system + 最近 keepRecent 条非 system 消息，更早历史 best-effort
 * 压缩为一段摘要后以 system 消息注入（摘要失败则纯丢弃），并确保工具消息与对应的
 * assistant 消息成对保留，避免重试请求再次被服务端校验拒绝。
 */
async function truncateForRetry(
  messages: ChatMessage[],
  onStatus?: (t: string) => void,
  keepRecent = 10,
  /** 多模型分工：超限压缩摘要用覆盖模型（子智能体场景），省略则全局活动模型 */
  override?: ModelOverride
): Promise<ChatMessage[]> {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const conv = messages.filter((m) => m.role !== "system");
  if (conv.length <= keepRecent) return messages;
  const recent = conv.slice(-keepRecent);
  const old = conv.slice(0, conv.length - keepRecent);

  // best-effort：把被丢弃的旧历史压缩成一段摘要（请求体仅含旧文本，体量小，通常不会超限）
  let summary = "";
  try {
    const raw = old
      .map((m) => `[${m.role}] ${String(m.content ?? "").slice(0, 300)}`)
      .join("\n");
    const s = await summarizeConversation(raw, override);
    if (s && s.trim()) summary = s.trim();
  } catch {
    /* 摘要失败则纯丢弃，不影响重试 */
  }
  if (summary) {
    onStatus?.(`🧠 已把 ${old.length} 条旧消息压缩为摘要（${summary.length} 字符）`);
  } else {
    onStatus?.(`✂️ 已丢弃 ${old.length} 条最旧消息（摘要失败）`);
  }

  const out: ChatMessage[] = [...systemMsgs];
  if (summary) {
    out.push({ role: "system", content: `## 早期对话摘要（超限自动压缩）\n${summary}` });
  }
  // 补齐成对性：若保留段以 tool 消息开头，向上补齐对应的 assistant 消息
  // （必须携带 tool_calls）以及中间被截断的 tool 消息，避免 "tool 消息前无
  // tool_calls" 的 400。
  if (recent[0]?.role === "tool") {
    const startIdx = conv.length - keepRecent;
    let assistantIdx = -1;
    for (let i = startIdx - 1; i >= 0; i--) {
      const toolCalls = (conv[i] as any).tool_calls;
      if (conv[i].role === "assistant" && Array.isArray(toolCalls) && toolCalls.length > 0) {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx >= 0) {
      recent.unshift(...conv.slice(assistantIdx, startIdx));
    } else {
      // 找不到带 tool_calls 的 assistant，说明这些 tool 消息已经孤立，丢弃
      while (recent.length > 0 && recent[0].role === "tool") {
        recent.shift();
      }
    }
  }
  out.push(...recent);
  return out;
}
