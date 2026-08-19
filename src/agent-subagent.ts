/**
 * 子智能体（Sub-Agent）：runAgent 的 send_message 分支创建命名子任务，
 * 子任务内部再调用 runAgent 执行独立循环；两文件函数级互相 import，
 * esbuild bundle 扁平化后无运行时循环。
 */
import * as fs from "fs";
import * as path from "path";
import { parseFrontmatter, fmString, fmStringArray } from "./frontmatter";
import type { ChatMessage } from "./provider";
import type { ModelOverride } from "./providers";
import type { ToolContext } from "./tools";
import { TOOL_DEFINITIONS } from "./tools";
import type { AgentCallbacks } from "./agent-types";
import { subagentStopHook } from "./hooks";
import { emptyGoalState } from "./goal";
import { EXEC_TOOLS, getRolePreset } from "./rolePresets";
import { subAgentRegistry } from "./agent-registry";
import { runAgent } from "./agent";
import { resolveSafe } from "./path-safety";

/**
 * 子智能体（Layer 6 工作流编排）：以独立上下文运行一轮 Agent 循环，
 * 只把最终结论交回主 Agent，从而保持主上下文干净（对应 Claude Code 的
 * Task / 子 Agent 思路——上下文切分而非能力切分）。
 *
 * 权限控制（防失控）：
 *  - canSpawn=false：子 Agent 默认不能再派子 Agent（防递归膨胀）；
 *  - toolWhitelist：按角色定义 ∩ 父 Agent 拥有 限定其工具集；
 *  - 编排者/执行者工具集互补，不重叠。
 */
export async function runSubAgent(
  args: any,
  parentCtx: ToolContext,
  parentCb: AgentCallbacks,
  signal?: AbortSignal
): Promise<string> {
  const root = parentCtx.workspaceRoot;
  // 命名团队支持：若显式指定 name，则把该子智能体登记到团队注册表，
  // 后续可用 send_message 按名寻址续跑（对标 Claude Code Agent Teams / SendMessage）。
  const teamName =
    typeof args.name === "string" && args.name.trim() ? args.name.trim() : "";

  // 解析可选 worktree（Layer 6 并行隔离）：子智能体在独立工作树内运行，
  // 文件改动隔离在副本，避免并行改不同模块时互相覆盖。路径必须限定在 root 内。
  let subRoot = root;
  if (args.worktree) {
    let wt: string;
    try {
      wt = resolveSafe(root, String(args.worktree));
    } catch (e: any) {
      return `⛔ worktree 路径越界或不安全：${e?.message ?? String(e)}`;
    }
    if (!fs.existsSync(wt)) return `⛔ worktree 不存在：${wt}`;
    subRoot = wt;
  }

  // 解析角色定义文件（.agent/agents/<name>.md），含 tools 白名单 / system body / 可选模型绑定
  let roleBody = "";
  let whitelist: string[] | undefined;
  let fmModel: string | undefined;
  let fmProvider: string | undefined;
  let fmSkills: string[] | undefined;
  const agentName = typeof args.agent === "string" ? args.agent.trim() : "";
  if (agentName) {
    // 兼容两个子代理目录：FreeSeek 原生 .agent/agents/ + CodeBuddy 约定 .codebuddy/agents/（后者优先对齐 CodeBuddy）
    const p = [".codebuddy", ".agent"].map((d) => path.join(root, d, "agents", `${agentName}.md`)).find((f) => fs.existsSync(f));
    if (p) {
      const raw = fs.readFileSync(p, "utf8");
      const fm = parseAgentFrontmatter(raw);
      roleBody = fm.body;
      whitelist = fm.tools;
      fmModel = fm.model;
      fmProvider = fm.provider;
      fmSkills = fm.skills;
    }
  }

  // 角色预设（role 参数）：优先用户自定义，其次内置（explore / plan / verify / general）
  const roleKey = typeof args.role === "string" ? args.role.trim().toLowerCase() : "";
  const preset = roleKey ? getRolePreset(roleKey) : undefined;
  if (!roleBody && preset) {
    roleBody = preset.body;
  }
  if (!whitelist && preset) {
    whitelist = preset.tools;
  }

  // 多模型分工：解析该子智能体使用的 provider/model（优先级：显式参数 > 角色文件 frontmatter > 角色预设）。
  // 解析出的覆盖仅作用于本子智能体，不触碰全局活动模型（freesek.activeModel）。
  let modelOverride: ModelOverride | undefined;
  const provArg =
    typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : undefined;
  const modelArg = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
  if (provArg || modelArg) {
    modelOverride = { providerId: provArg, modelId: modelArg };
  } else if (fmProvider || fmModel) {
    modelOverride = { providerId: fmProvider, modelId: fmModel };
  } else if (preset?.provider || preset?.model) {
    modelOverride = { providerId: preset.provider, modelId: preset.model };
  }

  // 无显式角色时，按 mode 回退到内置预设（executor → general，explore → explore），
  // 避免在 ROLE_PRESETS 之外再维护一份重复的默认 body/白名单。
  if (!roleBody || !whitelist) {
    const modePreset = getRolePreset(args.mode === "executor" ? "general" : "explore");
    if (!roleBody && modePreset) roleBody = modePreset.body;
    if (!whitelist && modePreset) whitelist = modePreset.tools;
  }

  // 工具集交集：角色声明 ∩ 父 Agent 拥有（父未暴露的不可用），并显式禁止子 Agent 再派发
  const parentTools = parentCtx.toolWhitelist ?? TOOL_DEFINITIONS.map((t) => t.function.name);
  const effectiveWhitelist = deriveSubagentPermissions(parentTools, whitelist ?? []);

  // 执行/只读模式判定：显式 mode 优先；否则按角色白名单推断——含 shell/验证类工具的角色
  // （general/verify 等）视为 executor，只读角色（explore/plan）视为 explore。
  // 修复此前「role=general（白名单含 run_command）但 allowShell 恒为 false」的语义脱节：
  // mode 决定 allowShell，必须与白名单是否含执行工具保持一致。
  const mode: "explore" | "executor" =
    args.mode === "executor"
      ? "executor"
      : args.mode === "explore"
        ? "explore"
        : (whitelist ?? []).some((t) => EXEC_TOOLS.has(t))
          ? "executor"
          : "explore";

  const subCtx: ToolContext = {
    workspaceRoot: subRoot,
    allowShell: mode === "executor" ? parentCtx.allowShell : false,
    confirmFileWrites: parentCtx.confirmFileWrites,
    allowNetwork: parentCtx.allowNetwork,
    askUser: parentCtx.askUser,
    skillManager: parentCtx.skillManager,
    todoState: { items: [] },
    goalState: emptyGoalState(), // 子智能体独立目标上下文（不继承主 Agent 目标）
    canSpawn: false, // 防递归
    toolWhitelist: effectiveWhitelist,
    userMemoryPath: parentCtx.userMemoryPath,
    planMode: parentCtx.planMode, // 继承主 Agent 的规划/沙箱约束
    agentMode: parentCtx.agentMode,
    sandboxMode: parentCtx.sandboxMode,
    allowRules: parentCtx.allowRules,
    denyRules: parentCtx.denyRules,
    commandTimeout: parentCtx.commandTimeout,
    worktreeRoot: subRoot !== root ? subRoot : undefined,
    offloadDir: parentCtx.offloadDir,
    checkpointDir: parentCtx.checkpointDir,
    envWhitelist: parentCtx.envWhitelist,
    sandboxNetwork: parentCtx.sandboxNetwork,
    sandboxFailIfUnavailable: parentCtx.sandboxFailIfUnavailable,
    allowCommandHooks: parentCtx.allowCommandHooks,
    signal: signal ?? parentCtx.signal ?? parentCb.signal,
    eventLog: parentCtx.eventLog,
    eventActor: `${parentCtx.eventActor ?? "main"}/sub:${teamName || agentName || roleKey || mode}`,
    // 多模型分工：子智能体按解析出的覆盖模型运行（无覆盖则与主 Agent 共用全局活动模型）
    modelOverride,
    // 子代理继承父级的安全审批回调：MCP 工具/资源、技能激活仍需用户确认（避免子代理绕过主 Agent 审批）
    requestMCPApproval: parentCtx.requestMCPApproval,
    promoteSkill: parentCtx.promoteSkill,
  };

  // 子代理启动时自动加载技能（对齐 CodeBuddy 子代理的 skills 字段）：
  // 优先级 agent frontmatter > role 预设；mode 仅为回退占位、不携带技能（避免隐式副作用）。
  // 用 parentCtx.skillManager 把技能全文拼进 system body，让子代理开箱即掌握该 SOP。
  const skillNames = fmSkills ?? preset?.skills ?? undefined;
  if (skillNames?.length && parentCtx.skillManager) {
    const parts: string[] = [];
    for (const sn of skillNames) {
      try {
        const full = parentCtx.skillManager.loadSkill(sn.trim());
        if (full && !full.startsWith("未找到技能") && !full.includes("pending 待审核")) {
          parts.push(`## 技能：${sn.trim()}\n${full}`);
        }
      } catch {
        /* 单个技能加载失败不阻断派发 */
      }
    }
    if (parts.length) {
      roleBody = `${roleBody}\n\n## 你应遵循的预设技能\n${parts.join("\n\n---\n\n")}`;
    }
  }

  const subMessages: ChatMessage[] = [
    { role: "system", content: roleBody },
    { role: "user", content: String(args.task ?? "") },
  ];

  const subCb: AgentCallbacks = {
    onAssistantText: () => {
      /* 子智能体正文不灌入主 UI，最终以 report 形式交回 */
    },
    onToolStart: (call) =>
      parentCb.onSubAgentTool?.(call.function.name, call.function.arguments),
    onToolResult: (call, result) =>
      parentCb.onSubAgentResult?.(call.function.name, result),
    onStep: () => {},
    onStripToolCall: () => {},
    // 子 Agent 的权限只能更小，不能因为“没有回调”而自动放行。
    onPermissionRequest: parentCb.onPermissionRequest,
    signal: signal ?? parentCtx.signal ?? parentCb.signal,
  };

  const subLabel = agentName || roleKey || mode;
  try {
    const out = await runAgent(subMessages, TOOL_DEFINITIONS, subCtx, subCb);
    // 取最后一条 assistant 消息作为结论报告
    let report = "（子智能体未返回结论）";
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "assistant") {
        const text = (out[i].content || "").trim();
        if (text) {
          report = text;
          break;
        }
      }
    }
    // 命名子智能体：登记到团队注册表，供 send_message 续跑
    if (teamName) {
      subAgentRegistry.set(teamName, { messages: out, ctx: subCtx, cb: subCb, label: subLabel });
    }
    parentCb.onContextStatus?.(subagentStopHook(subLabel));
    return report;
  } catch (e: any) {
    parentCb.onContextStatus?.(subagentStopHook(subLabel));
    return `子智能体执行出错：${e?.message ?? String(e)}`;
  }
}

/**
 * 解析子代理 Markdown 的 frontmatter（对齐 CodeBuddy Subagents 格式）：
 * 支持 name / description / tools / model / provider / skills / body。
 * description 用于主 Agent 自动路由派发（必填在 CodeBuddy；FreeSeek 缺省回退 body 摘要）。
 * skills 为子代理启动时自动加载的技能名列表。
 */
function parseAgentFrontmatter(raw: string): {
  tools?: string[];
  body: string;
  model?: string;
  provider?: string;
  description?: string;
  skills?: string[];
} {
  const { fm, body } = parseFrontmatter(raw);
  return {
    tools: fmStringArray(fm, "tools"),
    body: body.trim(),
    model: fmString(fm, "model"),
    provider: fmString(fm, "provider"),
    description: fmString(fm, "description"),
    skills: fmStringArray(fm, "skills"),
  };
}

/**
 * Layer 6 权限交集（对应 AllenTang harness-19「权限交集——子 Agent 的权限只能更小」）：
 *   有效工具 = 角色声明 ∩ 父 Agent 拥有，并默认去掉 spawn_agent（防递归膨胀）。
 * 这样子 Agent 既不能越权使用父未暴露的工具，也不能自行派发新子 Agent。
 */
export function deriveSubagentPermissions(
  parentTools: string[],
  declaredTools: string[]
): string[] {
  const allowed = declaredTools.filter((t) => parentTools.includes(t));
  return allowed.filter((t) => t !== "spawn_agent" && t !== "spawn_agents");
}
