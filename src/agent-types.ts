/** 共享类型：子智能体句柄与 Agent 回调契约（agent.ts / agent-subagent.ts 共用）。 */
import type { ChatMessage, ToolCall } from "./provider";
import type { ToolContext } from "./tools";

/** 命名子智能体团队注册表项：保存其完整上下文，便于 send_message 按名寻址续跑。 */
export interface SubAgentHandle {
  messages: ChatMessage[];
  ctx: ToolContext;
  cb: AgentCallbacks;
  label: string;
}


export interface AgentCallbacks {
  onAssistantText: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolStart: (call: ToolCall) => void;
  onToolResult: (call: ToolCall, result: string) => void;
  onStep: (step: number, text: string) => void;
  /** 检测到 ReAct 文本工具调用时，通知前端移除已流式显示的原始 <tool_call> 块 */
  onStripToolCall?: () => void;
  /** Layer 7：上下文预算状态变化（如 70% 预警、85% 压缩）时通知前端 */
  onContextStatus?: (text: string) => void;
  /** Loop：任务清单（TodoWrite）更新时回传前端渲染 */
  onTodos?: (items: { content: string; status: string; activeForm?: string }[]) => void;
  /** Loop：目标状态机（goal）每工具轮回传当前目标视图，供前端展示 */
  onGoal?: (view: {
    objective: string;
    phase: string;
    roundsStarted: number;
    maxRounds: number;
    blockedReason?: string;
  }) => void;
  /** 子智能体：开始 */
  onSubAgentStart?: (name: string, task: string) => void;
  /** 子智能体：调用工具（开始） */
  onSubAgentTool?: (name: string, args: string) => void;
  /** 子智能体：工具结果（完成） */
  onSubAgentResult?: (name: string, result: string) => void;
  /** 子智能体：结束并交回结论 */
  onSubAgentEnd?: (report: string) => void;
  /** Layer 7 可观测性：单轮结束后的运行统计（轮次 / token / 占比 / 估算成本美元 / 输入输出 token / 工具调用次数） */
  onObservability?: (stats: {
    turns: number;
    tokens: number;
    ratio: number;
    cost: number;
    promptTokens: number;
    completionTokens: number;
    toolCalls: number;
  }) => void;
  /** Notification Hook：需要用户注意时（如后台任务完成、需权限）上报前端。 */
  onNotification?: (n: { title: string; body: string }) => void;
  /**
   * ToolRuntime 的通用人类审批 UI 回调。Runtime spec 决定何时调用；扩展侧只负责展示弹窗，
   * 不再维护工具风险名单。返回 allow=false 即拦截。子智能体继承父 Agent 回调，不能通过委派绕过权限。
   */
  onPermissionRequest?: (
    toolName: string,
    input: any
  ) => Promise<{ allow: boolean; persist?: "allow" | "deny"; reason?: string }>;
  signal?: AbortSignal;
}
