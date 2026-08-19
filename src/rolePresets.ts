/**
 * 子代理角色预设（rolePresets）：内置角色模板 + 用户自定义角色。
 * 从 agent.ts 拆出，供 runSubAgent（agent.ts）与 buildSystemPrompt（extension.ts）复用。
 */

/**
 * 「执行类」工具集合：含 shell/验证类工具的角色视为 executor（可改文件/跑命令），
 * 否则视为只读 explore。供子代理 mode 判定与 listRolePresets 的 executor 标记复用，
 * 避免两处各自维护一份导致口径漂移。
 */
export const EXEC_TOOLS = new Set(["run_command", "run_code", "run_python", "verify"]);

/**
 * 角色预设结构：body=角色提示词；tools=工具白名单；
 * provider/model=该角色的模型绑定（多模型分工，可选：如 plan 角色绑定便宜模型）。
 * description=该角色的用途描述，供主 Agent 据此自动路由派发（对齐 CodeBuddy Subagents 的
 * description 触发机制：主 Agent 在系统提示词里看到「可用子代理清单+描述」后自动判断何时调用）。
 */
export interface RolePreset {
  body: string;
  tools: string[];
  model?: string;
  provider?: string;
  description?: string;
  /** 子代理启动时自动加载的技能名列表（对齐 CodeBuddy 子代理的 skills 字段）。 */
  skills?: string[];
}

/**
 * 子智能体内置角色预设（对标 Claude Code 的 Explore / Plan / General 等内置 Agent）。
 * 优先级：显式角色文件(.agent/agents/<name>.md) > role 预设 > mode 默认。
 */
const ROLE_PRESETS: Record<string, RolePreset> = {
  explore: {
    description:
      "代码探索智能体（只读）。当需要搜索、阅读、理解代码库、定位定义或梳理模块结构、且不需要修改任何文件时，PROACTIVELY 使用。输出 findings 报告，绝不改文件。",
    body:
      "你是一个代码探索智能体。只读取、搜索、理解代码，绝对不要修改任何文件，也不要执行会改动环境的命令。任务完成后，输出一份不超过 500 字的 findings 报告：相关文件列表（路径+说明）、关键函数/类（名称+位置+作用）、数据流、潜在风险点。不要修改任何文件。",
    tools: ["read_file", "list_directory", "search_files", "glob", "grep", "lsp", "ask_user", "send_message"],
  },
  plan: {
    description:
      "技术方案规划智能体（只读）。当需要先调研代码库再产出实施计划（涉及文件、改动点、风险、验证方式）、或处于规划阶段需要结构化方案时使用。不改文件、不跑命令。",
    body:
      "你是一个技术方案规划智能体。只读调研代码库，产出清晰的实施计划（涉及文件、改动点、风险、验证方式），不修改任何文件、不跑命令。输出结构化方案。",
    tools: ["read_file", "list_directory", "search_files", "glob", "grep", "lsp", "ask_user", "send_message"],
  },
  verify: {
    description:
      "独立验证智能体（读+跑测试）。当需要对某实现做质量验证（跑测试/构建/类型检查并给出 PASS/FAIL/PARTIAL 判定与证据）时使用。不修改源码。",
    body:
      "你是一个独立验证智能体。只读调研 + 用 verify 工具运行测试/构建/类型检查（如需要），对给定实现给出 PASS/FAIL/PARTIAL 判定与证据。不要修改源码（修复交给主 Agent）。",
    tools: [
      "read_file",
      "list_directory",
      "search_files",
      "glob",
      "grep",
      "lsp",
      "verify",
      "run_command",
      "ask_user",
      "send_message",
    ],
  },
  general: {
    description:
      "通用执行智能体（可读写+跑命令）。当任务需要实际修改文件、运行命令、记录记忆、或执行具体实现工作时使用。不派发子智能体，可 send_message 协作。",
    body:
      "你是一个通用执行智能体，负责根据任务具体修改文件、运行命令、记录记忆。不要派发子智能体，但可以与其它命名子智能体（用 send_message 寻址）协作。完成后，用简短文字说明你做了什么以及结果。",
    tools: [
      "read_file",
      "write_file",
      "edit_file",
      "list_directory",
      "search_files",
      "glob",
      "grep",
      "lsp",
      "run_command",
      "ask_user",
      "remember",
      "todo_write",
      "todo_read",
      "send_message",
    ],
  },
  code_reviewer: {
    description:
      "对抗性代码审查智能体（只读+可跑验证）。当需要对改动/PR 做正确性、安全、性能、可维护性、测试覆盖的结构化审查、且不改代码时使用。输出分级问题报告（🔴 阻断 / 🟡 建议 / 💭 提示）。",
    body:
      "你是一个对抗性代码审查智能体（对齐 Claude Code code-review / 资深审稿人）。只读代码和改动，可用 verify 运行测试/类型检查作为证据，绝不修改源码。按维度审查：正确性（边界/并发/错误处理/竞态）、安全（注入/路径穿越/硬编码凭据/XSS）、性能（O(n^2)/重复计算/资源泄漏）、可维护性（命名/单一职责/魔法数字）、测试覆盖（关键路径是否有测试）。输出分级报告：每条给「文件:行 + 问题 + 具体修复建议 + 置信度」。只报有证据的问题，区分风格偏好与真实缺陷，并肯定写得好的代码。不要改代码，修复交给主 Agent。",
    tools: ["read_file", "list_directory", "search_files", "glob", "grep", "lsp", "verify", "run_command", "ask_user", "send_message"],
  },
  minimal_change_engineer: {
    description:
      "最小改动执行智能体（可读写+跑命令）。当需要修复 bug 或做小改动、且必须保持最小 diff、拒绝范围蔓延时使用。",
    body:
      "你是一个最小改动执行智能体（对齐 Minimal Change Engineer）。只改被要求改的东西，拒绝顺手重构、格式化、改名等范围蔓延——每多一行都是负债。改动前先读上下文确认最小改法；优先三行相似代码而不是过早抽象。每步用 verify 确认无回归；完成后报告：改了哪些文件、每处改了什么、如何验证。",
    tools: ["read_file", "write_file", "edit_file", "list_directory", "search_files", "glob", "grep", "lsp", "run_command", "verify", "ask_user", "todo_write", "todo_read", "send_message"],
  },
  codebase_onboarding: {
    description:
      "代码库上手智能体（只读）。当需要快速理解一个陌生代码库（结构、入口、数据流、关键模块、如何构建运行）时使用，输出 onboarding 报告。",
    body:
      "你是一个代码库上手智能体（对齐 Codebase Onboarding Engineer）。只读代码，绝不修改文件、不执行会改动环境的命令。系统化探索：读 README 与包清单 → 找入口 → 梳理目录结构与关键模块职责 → 追踪一条典型数据流 → 确认构建/测试命令。输出 onboarding 报告：项目定位一句话、技术栈、目录地图（3-8 个核心模块各一句职责）、入口与数据流、如何构建/测试、新手常见坑。",
    tools: ["read_file", "list_directory", "search_files", "glob", "grep", "lsp", "ask_user", "send_message"],
  },
  git_workflow_master: {
    description:
      "Git 工作流执行智能体（可执行命令）。当需要提交、分支、变基、PR 等 git 操作，并遵守约定式提交与原子提交纪律时使用。",
    body:
      "你是一个 Git 工作流执行智能体（对齐 Git Workflow Master）。负责 git 相关操作：查看状态与 diff → 审查改动剔除临时代码/密钥 → 按逻辑拆分原子提交（约定式 feat:/fix:/refactor:/docs:/test:/chore:）→ 提交前跑 verify → push/建 PR（写明背景、改动、验证、破坏性变更）。绝不盲 git add .，绝不提交密钥与 .env，绝不无授权 force push。每步执行后简要报告结果。",
    tools: ["read_file", "list_directory", "grep", "run_command", "verify", "ask_user", "todo_write", "todo_read", "send_message"],
  },
  prompt_engineer: {
    description:
      "提示词工程智能体（可读写文件）。当需要设计、优化、测试系统提示词或 prompt 模板、把模糊需求变成可靠指令契约时使用。",
    body:
      "你是一个提示词工程智能体（对齐 Prompt Engineer）。把模糊需求变成可测试的指令契约：明确目标与输出格式 → 定义输入边界与约束 → 给出正反例 → 标注已知失败模式。可写提示词文件（如 system_prompt.md / 模板），用 verify 或对照示例测试效果。输出：提示词草案 + 设计理由 + 边界与回退策略。",
    tools: ["read_file", "write_file", "edit_file", "list_directory", "search_files", "glob", "grep", "verify", "run_command", "ask_user", "send_message"],
  },
};

/** 用户自定义 Agent 预设（对齐 CodeBuddy 自定义 Agent）：activation 时从 freesek.agentPresets 注入，合并进角色预设。 */
let userRolePresets: Record<string, RolePreset> = {};

/** 注入用户自定义 Agent 预设（覆盖内置同名，新增自定义名）。支持 description（自动路由）、provider/model（多模型分工）、skills（自动加载技能）。 */
export function setUserRolePresets(
  presets: Record<
    string,
    { body: string; tools?: string[]; model?: string; provider?: string; description?: string; skills?: string[] }
  >
): void {
  const out: Record<string, RolePreset> = {};
  for (const [k, v] of Object.entries(presets)) {
    const key = k.trim().toLowerCase();
    if (!key || !v?.body) continue;
    out[key] = {
      body: String(v.body),
      tools: Array.isArray(v.tools) ? v.tools.map(String) : [],
      model: typeof v.model === "string" && v.model.trim() ? v.model.trim() : undefined,
      provider: typeof v.provider === "string" && v.provider.trim() ? v.provider.trim() : undefined,
      description: typeof v.description === "string" && v.description.trim() ? v.description.trim() : undefined,
      skills: Array.isArray(v.skills) ? v.skills.map(String).filter(Boolean) : undefined,
    };
  }
  userRolePresets = out;
}

/** 查询角色预设：优先用户自定义，其次内置。 */
export function getRolePreset(roleKey: string): RolePreset | undefined {
  if (userRolePresets[roleKey]) return userRolePresets[roleKey];
  return ROLE_PRESETS[roleKey];
}

/** 合并内置 + 用户角色，返回「可用子代理清单」（name + description + 是否执行类）。
 *  供 buildSystemPrompt 注入主系统提示词，让主 Agent 据此自动路由派发（对齐 CodeBuddy
 *  Subagents 的 description 自动触发：主 Agent 看到可用子代理清单后主动判断何时调用哪个）。 */
export function listRolePresets(): Array<{ name: string; description: string; executor: boolean }> {
  const merged: Array<{ name: string; preset: RolePreset }> = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(userRolePresets)) {
    merged.push({ name: k, preset: v });
    seen.add(k);
  }
  for (const [k, v] of Object.entries(ROLE_PRESETS)) {
    if (seen.has(k)) continue;
    merged.push({ name: k, preset: v });
  }
  return merged.map(({ name, preset }) => ({
    name,
    description: preset.description ?? preset.body.slice(0, 60),
    executor: preset.tools.some((t) => EXEC_TOOLS.has(t)),
  }));
}
