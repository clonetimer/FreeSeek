/** 命名子智能体团队注册表（同会话内按 name 寻址续跑，对标 Claude Code Agent Teams / SendMessage）。 */
import type { SubAgentHandle } from "./agent-types";

export const subAgentRegistry = new Map<string, SubAgentHandle>();
/** 正在被续跑（send_message 触发）的智能体集合：防止 A2A 互相递归调用导致死循环。 */
export const busyAgents = new Set<string>();

/** 清空团队注册表（新建/分叉对话时调用，避免跨会话寻址到陈旧子智能体）。 */
export function clearSubAgentRegistry(): void {
  subAgentRegistry.clear();
}
