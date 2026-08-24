/**
 * Unified Tool Runtime Pipeline
 *
 * 所有模型工具调用统一经过：
 * admission/mode -> permission rules -> user approval -> MCP approval -> pre hooks
 * -> timeout/cancellation -> body dispatch -> post hooks -> offload/truncation。
 *
 * Agent 只负责“模型循环与工具结果回灌”，不再自行拼权限/沙箱/hook/timeout 分支。
 */
import type { ToolContext } from "./tools";
import { maybeOffload } from "./tools";
import { applyPermissionRules, postToolUse, runPreToolHooks } from "./hooks";
import { commandExecPlan, execPolicyFromContext } from "./sandbox";
import { truncateToolResult, withAbortableTimeout } from "./agent-utils";
import type { ToolRuntimeSpec } from "./tool-runtime-spec";
import { ToolRegistry } from "./tool-registry";
import { captureWorkspaceCheckpoint } from "./workspace-timeline";
import { resolveSafeInRoots } from "./path-safety";

export type ToolApprovalResult = {
  allow: boolean;
  persist?: "allow" | "deny";
  reason?: string;
};

export interface ToolRuntimeCallbacks {
  requestApproval?: (toolName: string, input: any, callId?: string) => Promise<ToolApprovalResult>;
  onTimeout?: (toolName: string, timeoutMs: number) => void;
  onStatus?: (text: string) => void;
}

export interface ToolRuntimeOutcome {
  result: string;
  spec: ToolRuntimeSpec;
  blocked?: "mode" | "policy" | "approval" | "mcp" | "hook" | "capability" | "cancelled";
  timedOut?: boolean;
}

export interface ToolRuntimeExecuteOptions {
  callId?: string;
}

function readOnlyMode(ctx: ToolContext): boolean {
  return !!ctx.planMode || ctx.agentMode === "plan" || ctx.agentMode === "ask";
}

function modeLabel(ctx: ToolContext): string {
  return ctx.agentMode === "ask" ? "问答" : ctx.agentMode === "plan" ? "规划" : "只读";
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}); } catch { return String(value ?? ""); }
}

function cancelledText(): string {
  return "⛔ 当前 Agent/job 已取消，工具未执行或已中止。";
}

function genericApprovalRequired(spec: ToolRuntimeSpec, args: any, ctx: ToolContext): boolean {
  switch (spec.approval) {
    case "always": return true;
    case "confirm-write": return ctx.confirmFileWrites === true;
    case "user-scope": return String(args?.scope ?? "project") === "user";
    case "auto":
    default: return false;
  }
}

/** 一个 runAgent 对应一个实例：其中保存 MCP 会话级 approval cache。 */
function operationWorkspaceRoot(ctx: ToolContext, toolName: string, args: any): string {
  const raw = toolName === "run_command" || toolName === "run_code" || toolName === "run_python"
    ? args?.cwd
    : ["read_file", "write_file", "edit_file", "delete_file", "list_directory", "grep"].includes(toolName)
      ? args?.path
      : undefined;
  if (typeof raw !== "string" || !raw.trim() || ctx.worktreeRoot) return ctx.worktreeRoot ?? ctx.workspaceRoot;
  try {
    return resolveSafeInRoots(ctx.workspaceRoot, ctx.additionalWorkspaceRoots, raw).root;
  } catch {
    return ctx.workspaceRoot;
  }
}

export class ToolRuntime {
  private readonly mcpApproved = new Set<string>();

  constructor(
    private readonly ctx: ToolContext,
    private readonly registry: ToolRegistry,
    private readonly callbacks: ToolRuntimeCallbacks = {}
  ) {}

  async execute(
    name: string,
    args: any,
    options: ToolRuntimeExecuteOptions = {}
  ): Promise<ToolRuntimeOutcome> {
    const actor = this.ctx.eventActor ?? "main";
    const emit = (type: string, data?: unknown) => this.ctx.eventLog?.append(type, data, actor);
    const startedAt = Date.now();
    emit("tool/call", { callId: options.callId, name, args });
    const done = (candidate: ToolRuntimeOutcome): ToolRuntimeOutcome => {
      const outcome = this.finish(candidate);
      emit("tool/result", {
        callId: options.callId,
        name,
        result: outcome.result.slice(0, 8000),
        blocked: outcome.blocked,
        timedOut: outcome.timedOut === true,
        durationMs: Date.now() - startedAt,
      });
      return outcome;
    };
    const registration = this.registry.get(name);
    if (!registration) {
      return done({
        result: `⛔ 未注册工具「${name}」不能执行。Provider schema 与 Runtime Registry 可能已漂移。`,
        spec: { name, effect: "external", concurrency: "exclusive", readOnlyAllowed: false, approval: "always" },
        blocked: "capability",
      });
    }
    const spec = registration.runtime;
    const signal = this.ctx.signal;

    if (signal?.aborted) {
      return done({ result: cancelledText(), spec, blocked: "cancelled" });
    }
    if (this.ctx.toolWhitelist && !this.ctx.toolWhitelist.includes(name)) {
      return done({
        result: `⛔ 工具「${name}」不在当前 Agent 的能力白名单中。`,
        spec,
        blocked: "capability",
      });
    }
    if (readOnlyMode(this.ctx) && !spec.readOnlyAllowed) {
      return done({
        result: `⛔ ${modeLabel(this.ctx)}模式：已阻止「${name}」（只读工具可用）。请切换到 Craft（制作）模式后再执行。`,
        spec,
        blocked: "mode",
      });
    }
    if (this.ctx.sandboxMode === "readonly" && !spec.readOnlyAllowed) {
      return done({
        result:
          `⛔ 沙箱（只读）模式：已阻止 ${name}。\n` +
          `说明：read-only 档是显式硬拒；如需执行，请改为 sandbox（OS 沙箱）或 off。`,
        spec,
        blocked: "mode",
      });
    }
    if (spec.requiresShell && !this.ctx.allowShell) {
      return done({
        result: `⚠️ ${name} 需要执行代码/命令，但 freesek.allowShell 未开启。`,
        spec,
        blocked: "capability",
      });
    }
    if (spec.requiresNetwork && this.ctx.allowNetwork === false) {
      return done({
        result: `⚠️ ${name} 需要联网，但联网已禁用（freesek.allowNetwork=false）。`,
        spec,
        blocked: "capability",
      });
    }

    // monotonic 权限规则：deny 永远优先；allow 可跳过通用 UI approval 与危险文本硬阻断。
    const perm = applyPermissionRules(name, args, this.ctx.allowRules ?? [], this.ctx.denyRules ?? []);
    if (perm.decision === "deny") {
      return done({
        result: `⛔ 被权限规则拒绝（${perm.reason ?? "deny"}）：${name}`,
        spec,
        blocked: "policy",
      });
    }

    // H2 Extension policies are monotonic: they may only block/warn and therefore cannot
    // bypass built-in deny, generic approval, MCP approval or sandbox admission.
    let extensionWarnings: string[] = [];
    if (this.ctx.extensionLease) {
      try {
        const policy = await this.ctx.extensionLease.evaluatePolicies(name, args, this.ctx);
        if (policy.blocked) {
          return done({ result: `⛔ [extension policy] ${policy.blocked}`, spec, blocked: "policy" });
        }
        if (policy.warnings?.length) extensionWarnings.push(...policy.warnings);
      } catch (error: any) {
        return done({
          result: `⛔ Extension policy 执行失败，已 fail-closed：${error?.message ?? String(error)}`,
          spec,
          blocked: "policy",
        });
      }
    }

    if (perm.decision !== "allow" && genericApprovalRequired(spec, args, this.ctx)) {
      if (!this.callbacks.requestApproval) {
        return done({
          result: `⛔ 工具「${name}」需要用户审批，但当前运行环境没有可用的 approval handler。`,
          spec,
          blocked: "approval",
        });
      }
      emit("approval/request", { callId: options.callId, name, category: "tool", args });
      let decision: ToolApprovalResult;
      try {
        decision = await this.callbacks.requestApproval(name, args, options.callId);
        emit("approval/result", {
          callId: options.callId, name, category: "tool", allow: decision.allow, persist: decision.persist, reason: decision.reason,
        });
      } catch (e: any) {
        emit("approval/result", { callId: options.callId, name, category: "tool", allow: false, reason: e?.message ?? String(e) });
        return done({
          result: `⛔ 工具「${name}」审批失败：${e?.message ?? String(e)}`,
          spec,
          blocked: "approval",
        });
      }
      if (!decision.allow) {
        return done({
          result: `⛔ ${decision.reason || "权限被用户拒绝（通过权限弹窗）。"}`,
          spec,
          blocked: "approval",
        });
      }
    }

    // MCP 为独立信任边界：即使通用权限允许，首次外部调用仍需 MCP 专门授权。
    if (spec.mcpApproval && !this.mcpApproved.has(name)) {
      if (!this.ctx.requestMCPApproval) {
        return done({
          result: `⛔ 外部 MCP 工具「${name}」需要独立审批，但当前运行环境没有 MCP approval handler。`,
          spec,
          blocked: "mcp",
        });
      }
      emit("approval/request", { callId: options.callId, name, category: "mcp", args });
      let decision: "allow" | "once" | "";
      try {
        decision = await this.ctx.requestMCPApproval(name, safeJson(args), options.callId);
        emit("approval/result", {
          callId: options.callId, name, category: "mcp", allow: decision === "allow" || decision === "once", persist: decision === "allow" ? "allow" : undefined,
        });
      } catch (e: any) {
        emit("approval/result", { callId: options.callId, name, category: "mcp", allow: false, reason: e?.message ?? String(e) });
        return done({
          result: `⛔ MCP 审批失败：${e?.message ?? String(e)}`,
          spec,
          blocked: "mcp",
        });
      }
      if (decision === "allow") this.mcpApproved.add(name);
      else if (decision !== "once") {
        return done({
          result: `⛔ 用户拒绝了外部 MCP 访问「${name}」。请尊重用户决定。`,
          spec,
          blocked: "mcp",
        });
      }
    }

    const sandboxPlan = commandExecPlan(execPolicyFromContext(this.ctx)).plan;
    const opRoot = operationWorkspaceRoot(this.ctx, name, args);
    const pre = await runPreToolHooks(
      name,
      args,
      sandboxPlan.osSandboxed,
      opRoot,
      perm.decision === "allow",
      this.ctx.allowCommandHooks ?? false
    );
    if (!pre.ok) {
      return done({ result: pre.message ?? "操作被拦截。", spec, blocked: "hook" });
    }
    if (pre.warnings?.length) extensionWarnings.push(...pre.warnings);
    if (this.ctx.extensionLease) {
      try {
        const hook = await this.ctx.extensionLease.runHooks("pre-tool", { toolName: name, args, ctx: this.ctx });
        if (hook.blocked) return done({ result: `⛔ [extension hook] ${hook.blocked}`, spec, blocked: "hook" });
        if (hook.warnings?.length) extensionWarnings.push(...hook.warnings);
      } catch (error: any) {
        return done({
          result: `⛔ Extension pre-tool hook 执行失败，已 fail-closed：${error?.message ?? String(error)}`,
          spec,
          blocked: "hook",
        });
      }
    }

    const warningPrefix = extensionWarnings.length
      ? `[安全提示] ${extensionWarnings.join(" ")}\n`
      : "";
    // File evidence is emitted by tool bodies only after a real read/mutation succeeds.
    // Thread the provider tool-call id through those callbacks here instead of asking
    // hosts to infer correlation from execution order (parallel read tools are allowed).
    const bodyContext: ToolContext = {
      ...this.ctx,
      ...(this.ctx.onFileDiff
        ? {
            onFileDiff: (info) =>
              this.ctx.onFileDiff?.(info, options.callId),
          }
        : {}),
      ...(this.ctx.onFileRead
        ? {
            onFileRead: (file, filePath) =>
              this.ctx.onFileRead?.(file, filePath, options.callId),
          }
        : {}),
    };
    // 所有 body（包括 Agent-native override）都走同一个取消/错误归一化包装；
    // timeoutMs 未声明时仅提供 parent AbortSignal 与异常归一化，不额外设置 deadline。
    const guard = await withAbortableTimeout(
      (childSignal) => this.registry.executeBody(name, args, { ...bodyContext, signal: childSignal }),
      spec.timeoutMs,
      signal
    );
    if (signal?.aborted) {
      return done({ result: cancelledText(), spec, blocked: "cancelled" });
    }
    if (guard.timedOut) {
      const timeoutMs = spec.timeoutMs ?? 0;
      emit("tool_timeout", { name, timeoutMs });
      this.callbacks.onTimeout?.(name, timeoutMs);
      this.callbacks.onStatus?.(`⛔ 工具「${name}」超时（${timeoutMs}ms），已强制终止`);
      return done({
        result:
          `⛔ TOOL_TIMEOUT：工具「${name}」超过声明超时预算（${timeoutMs}ms），执行被守卫终止。` +
          `请拆分任务、简化逻辑，或调整工具参数后重试。`,
        spec,
        timedOut: true,
      });
    }
    let result = String(guard.value ?? "");

    const post = await postToolUse(name, args, opRoot, this.ctx.runtime?.autoFormat !== false);
    if (post) result += post;
    if (this.ctx.extensionLease) {
      try {
        const hook = await this.ctx.extensionLease.runHooks("post-tool", { toolName: name, args, result, ctx: this.ctx });
        const postNotes = [...(hook.warnings ?? []), ...(hook.note ? [hook.note] : [])];
        if (postNotes.length) result += `\n[extension hook] ${postNotes.join(" ")}`;
      } catch (error: any) {
        // The tool body already completed. A post hook cannot retroactively turn a successful
        // side effect into a failure, so surface the hook error as an appended diagnostic.
        result += `\n[extension hook warning] ${error?.message ?? String(error)}`;
      }
    }

    // 对可能改变工作区的能力在“工具 + formatter 已结束”后记录 post-state checkpoint。
    // pre-edit checkpoint 负责撤销当前危险操作；post-state checkpoint 负责精确 replay/fork。
    if (name !== "checkpoint" && ["write", "execute", "destructive"].includes(spec.effect)) {
      try {
        captureWorkspaceCheckpoint(
          { ...this.ctx, workspaceRoot: opRoot },
          `freesek-post:${name}:${Date.now().toString(36)}`,
          "auto",
          true
        );
      } catch {
        /* timeline checkpoint 是 best-effort；工具结果本身不能因此被改写。 */
      }
    }
    return done({ result: warningPrefix + result, spec });
  }

  private finish(outcome: ToolRuntimeOutcome): ToolRuntimeOutcome {
    let result = maybeOffload(
      String(outcome.result ?? ""),
      this.ctx.offloadDir,
      this.ctx.runtime?.offloadThreshold ?? 50000
    );
    result = truncateToolResult(result);
    return { ...outcome, result };
  }
}
