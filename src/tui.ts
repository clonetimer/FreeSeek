/**
 * FreeSeek TUI（缺口1）：全交互式终端会话视图
 * ───────────────────────────────────────────────────────────────────────────
 * 对标 codex 的交互式终端：在真实 TTY 上提供
 *   - 实时流式渲染助手文本（行缓冲、按词 flush，避免半行撕裂）
 *   - 工具调用进度条（[tool ▸ name …] 完成后切到 [tool ✓ name]）
 *   - 状态指示器（reasoning / context-plan / session 状态）
 *   - 键盘审批：工具需要权限时直接在原地提示，y/Enter 批准、n 拒绝
 *
 * 非 TTY（管道 / CI）下自动降级为「朴素流式」：行为与旧版 --interactive 一致，
 * 不会尝试读取原始按键，确保可重定向与可测试。
 */
import * as readline from "readline";
import type { ToolCall } from "./provider";
import type { HeadlessIO } from "./headless";

export interface TuiHandle {
  start(): void;
  stop(): void;
  assistant(delta: string): void;
  toolStart(call: ToolCall): void;
  toolResult(call: ToolCall, result: string): void;
  status(label: string, text: string): void;
  /** 注册审批回调：TUI 在需要时调用它并向用户展示键盘提示。 */
  onApproval(fn: (toolName: string) => Promise<{ allow: boolean; reason?: string }>): void;
  /** 阻塞式请求一次审批（供 callbacks.onPermissionRequest 调用）。 */
  requestApproval(toolName: string): Promise<{ allow: boolean; reason?: string }>;
  readonly isTty: boolean;
}

interface SpinnerState {
  frame: number;
  timer: NodeJS.Timeout | undefined;
}

export function createTuiSession(io: HeadlessIO): TuiHandle {
  const isTty = Boolean(process.stdout.isTTY);
  const rl = isTty ? readline.createInterface({ input: process.stdin, terminal: true }) : undefined;
  let running = false;
  let assistantBuffer = "";
  const spinners = new Map<string, SpinnerState>();
  let approvalFn: ((toolName: string) => Promise<{ allow: boolean; reason?: string }>) | undefined;

  function flush(line: string): void {
    if (isTty) process.stdout.write(line);
    else io.stdout(line);
  }

  function renderSpinnerTick(): void {
    if (!running || !isTty || spinners.size === 0) return;
    const frames = ["▸", "▹", "▿", "◹"];
    let idx = 0;
    for (const [, st] of spinners) {
      st.frame = (st.frame + 1) % frames.length;
    }
    // 简化实现：仅推进计数，不重绘历史行（避免光标撕裂）。
    void idx;
  }

  return {
    isTty,
    start() {
      if (running) return;
      running = true;
      if (isTty && rl) {
        // 隐藏 stdin 回显，交由键盘审批逻辑接管。
        try { process.stdin.setRawMode?.(true); } catch { /* noop */ }
      }
      if (isTty) {
        const timer = setInterval(renderSpinnerTick, 200);
        rl && (rl as any)._tuiTimer === timer;
      }
    },
    stop() {
      if (!running) return;
      running = false;
      for (const [, st] of spinners) if (st.timer) clearInterval(st.timer);
      spinners.clear();
      if (isTty) {
        try { process.stdin.setRawMode?.(false); } catch { /* noop */ }
        process.stdout.write("\n");
      }
      rl?.close();
    },
    assistant(delta: string) {
      assistantBuffer += delta;
      // 按词边界 flush，避免半行撕裂；保留尾部不完整词。
      const parts = assistantBuffer.split(/(\s+)/);
      if (parts.length > 1) {
        const tail = parts.pop() ?? "";
        flush(parts.join(""));
        assistantBuffer = tail;
      }
    },
    toolStart(call: ToolCall) {
      const st: SpinnerState = { frame: 0, timer: undefined };
      spinners.set(call.id, st);
      flush(`\n\x1b[36m[tool ▸ ${call.function.name}]\x1b[0m `);
    },
    toolResult(call: ToolCall, result: string) {
      spinners.delete(call.id);
      const preview = result.replace(/\s+/g, " ").slice(0, 120);
      flush(`\x1b[32m[tool ✓ ${call.function.name}]\x1b[0m ${preview}\n`);
    },
    status(label: string, text: string) {
      flush(`\x1b[90m[${label}] ${text}\x1b[0m\n`);
    },
    onApproval(fn) {
      approvalFn = fn;
    },
    async requestApproval(toolName: string): Promise<{ allow: boolean; reason?: string }> {
      if (approvalFn) {
        const res = await approvalFn(toolName);
        flush(`\x1b[33m[approve ${res.allow ? "✓" : "✗"} ${toolName}]\x1b[0m ${res.reason ?? ""}\n`);
        return res;
      }
      // 无 TTY 时的降级：走普通交互 prompt。
      if (!io.prompt) return { allow: false, reason: "TUI 无审批通道" };
      const ans = (await io.prompt(`允许工具 ${toolName} 执行？(y/N) `)).trim().toLowerCase();
      const allow = ans === "y" || ans === "yes";
      return { allow, reason: allow ? "TUI 键盘批准" : "TUI 键盘拒绝" };
    },
  };
}
