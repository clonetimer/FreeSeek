// 目标状态机（吸收 deepseek-harness packages/goal 的核心语义，零依赖纯 TS）。
// 与 todoState（任务清单）互补：todoState 跟踪"怎么做"（步骤），
// goal 跟踪"为什么做"（当前目标 + 状态机：active/paused/blocked/complete）。
// 支持轮次预算（maxRounds，防无限绕圈）与跨压缩、跨会话持久（.agent/.goal.json）。

import * as path from "path";
import * as fs from "fs";

export type GoalPhase = "active" | "paused" | "blocked" | "complete";

export const GOAL_PHASES: GoalPhase[] = ["active", "paused", "blocked", "complete"];

export interface GoalState {
  objective: string;
  phase: GoalPhase;
  /** 轮次预算上限（0 = 不限）。每次 bumpGoalRound 递增 roundsStarted，超过预算时提醒收敛。 */
  maxRounds: number;
  /** 当前目标已启动的工具轮数。 */
  roundsStarted: number;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export function emptyGoalState(): GoalState {
  return {
    objective: "",
    phase: "active",
    maxRounds: 0,
    roundsStarted: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

export type GoalOperation =
  | { op: "create"; objective: string; maxRounds?: number }
  | { op: "edit"; objective?: string; maxRounds?: number }
  | { op: "pause" }
  | { op: "resume" }
  | { op: "complete" }
  | { op: "block"; reason?: string }
  | { op: "clear" };

/** 目标状态机转移（原地修改 state 并返回，与既有 todoState 风格一致）。 */
export function applyGoalOp(state: GoalState, op: GoalOperation): GoalState {
  const now = Date.now();
  switch (op.op) {
    case "create": {
      const objective = op.objective.trim();
      if (!objective) return state;
      return {
        objective,
        phase: "active",
        maxRounds: op.maxRounds && op.maxRounds > 0 ? op.maxRounds : 0,
        roundsStarted: 0,
        createdAt: now,
        updatedAt: now,
      };
    }
    case "edit":
      if (op.objective !== undefined) state.objective = op.objective.trim();
      if (op.maxRounds !== undefined) state.maxRounds = op.maxRounds > 0 ? op.maxRounds : 0;
      state.updatedAt = now;
      return state;
    case "pause":
      if (state.phase === "active") {
        state.phase = "paused";
        state.updatedAt = now;
      }
      return state;
    case "resume":
      if (state.phase === "paused" || state.phase === "blocked") {
        state.phase = "active";
        state.blockedReason = undefined;
        state.updatedAt = now;
      }
      return state;
    case "complete":
      state.phase = "complete";
      state.updatedAt = now;
      return state;
    case "block":
      state.phase = "blocked";
      state.blockedReason = op.reason?.trim() || "（未说明原因）";
      state.updatedAt = now;
      return state;
    case "clear":
      return emptyGoalState();
  }
}

export function goalStatePath(root: string): string {
  return path.join(root, ".agent", ".goal.json");
}

export function loadGoalState(root: string): GoalState {
  try {
    const raw = fs.readFileSync(goalStatePath(root), "utf8");
    const j = JSON.parse(raw);
    if (typeof j?.objective === "string" && GOAL_PHASES.includes(j.phase)) {
      return {
        objective: j.objective,
        phase: j.phase,
        maxRounds: Number(j.maxRounds) || 0,
        roundsStarted: Number(j.roundsStarted) || 0,
        blockedReason: typeof j.blockedReason === "string" ? j.blockedReason : undefined,
        createdAt: Number(j.createdAt) || 0,
        updatedAt: Number(j.updatedAt) || 0,
      };
    }
  } catch {
    /* 无目标文件或格式损坏，视为空 */
  }
  return emptyGoalState();
}

export function saveGoalState(root: string, state: GoalState): void {
  try {
    fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
    fs.writeFileSync(goalStatePath(root), JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* best-effort：持久化失败不影响主流程 */
  }
}

const GOAL_PHASE_LABEL: Record<GoalPhase, string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  complete: "已完成",
};

export function renderGoalView(state: GoalState): string {
  if (!state.objective) return "当前没有已登记的目标。用 goal({op: 'create', objective}) 登记一个。";
  const lines = [
    `目标：${state.objective}`,
    `状态：${GOAL_PHASE_LABEL[state.phase]}${
      state.blockedReason ? `（原因：${state.blockedReason}）` : ""
    }`,
    `轮次：${state.roundsStarted}${state.maxRounds > 0 ? ` / ${state.maxRounds}` : "（不限）"}`,
  ];
  if (
    state.maxRounds > 0 &&
    state.roundsStarted >= state.maxRounds &&
    state.phase !== "complete"
  ) {
    lines.push(
      `⚠️ 已用满 ${state.maxRounds} 轮预算：应总结现状并 pause 暂停；若确需继续，先说明为何超额。`
    );
  }
  return lines.join("\n");
}

/** 每轮工具轮结束自动推进：已登记目标且 active 时 roundsStarted++（对标 goal_rounds，改为自动）。 */
export function bumpGoalRound(state: GoalState): GoalState {
  if (state.objective && state.phase === "active") {
    state.roundsStarted++;
    state.updatedAt = Date.now();
  }
  return state;
}
