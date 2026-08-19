// check:max-lines 1000 (tools/ 已拆 web/verify/exec_code/fs_utils/defs；executeTool 深拆为后续技术债)
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ToolDefinition } from "./provider";
import type { SessionEventSink } from "./eventlog";
import { decodeBuffer, encodeBuffer, isNonUtf8 } from "./encoding";
import { ModelOverride } from "./providers";
import { SkillManager } from "./skills";
import { rememberFact } from "./memory";
import { runLsp, LspAction } from "./lsp";
import { mcpManager } from "./mcp";
import { connectorToolDefinitions, dispatchConnectorTool } from "./connectors";
import { SandboxMode, SandboxNetworkConfig, execPolicyFromContext, commandExecPlan } from "./sandbox";
import { getCommandRunner } from "./seam";
import { snapshotGitStatus, detectWorkspaceChanges } from "./wsdiff";
import { addWorktree, removeWorktree, listWorktrees, isGitRepo } from "./worktree";
import { loadCommands, resolveCommand } from "./commands";
import { browserAction } from "./browser";
import { GoalState, emptyGoalState, applyGoalOp, saveGoalState, renderGoalView } from "./goal";
import { jobRegistry, renderJobView } from "./jobs";
import { listCheckpoints, restoreCheckpoint } from "./checkpoints";
import { captureWorkspaceCheckpoint } from "./workspace-timeline";
// ── tools/ 子模块（按工具族拆分；tools.ts 仅保留分发骨架与文件快照/目标逻辑）──
import { TOOL_DEFINITIONS } from "./tools/defs";
import { resolveSafe, trashPath, unifiedDiff, walkMatch, grepWalk, escapeRegExp } from "./tools/fs_utils";
import { runWebSearch, runWebFetch } from "./tools/web";
import { runVerification } from "./tools/verify";
import { runPython, runCode } from "./tools/exec_code";
export { TOOL_DEFINITIONS }; // 兼容：agent.ts 等仍从 ./tools 导入

/** 对话模式（对齐 CodeBuddy / Cline 三态 + Coder 专职编码）：
 *  - plan（规划）：只读调研 + 产出实施计划并审批，禁止写/执行
 *  - ask（问答）：纯问答，只用只读工具查信息，不写不改不执行
 *  - craft（制作）：完整能力，可写文件 / 执行命令
 *  - coder（编码）：专职「需求理解 + 代码生成」的智能体，权限等同 craft
 */
export type AgentMode = "plan" | "ask" | "craft" | "coder";


/** read_file 默认读取行数上限：避免超大文件全量塞回上下文撑爆预算。 */
const READ_FILE_DEFAULT_LIMIT = 2000;

/** 单个任务项（TodoWrite）。状态与 Claude Code 对齐。 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** Agent 运行期间的任务清单状态（在工具循环内共享、回传给前端渲染）。 */
export interface TodoState {
  items: TodoItem[];
}

/** ask_user 的单个选项（对齐 Claude Code Interactive Questions 的结构化选择）。 */
export interface AskOption {
  label: string;
  description?: string;
}

/** ask_user 的请求结构（question + 可选的多选项）。 */
export interface AskRequest {
  question: string;
  options?: AskOption[];
  multiSelect?: boolean;
}

export interface ToolContext {
  workspaceRoot: string;
  /** Agent/工具的宿主无关运行参数。VS Code 由扩展层注入，Headless 可直接提供。 */
  runtime?: {
    maxSteps?: number;
    contextBudget?: number;
    /** Deterministic repository context planning. off preserves the legacy grep/read-only exploration path. */
    contextPlanner?: "off" | "v1" | "v1.1" | "v1.2";
    /** Maximum tokens injected by Context Planner v1 for one run. */
    contextPlannerBudget?: number;
    maxWallClockMs?: number;
    autoCheckpoint?: boolean;
    offloadThreshold?: number;
    autoFormat?: boolean;
  };

  allowShell: boolean;
  /** 文件写入是否需要逐次确认；由 ToolRuntime 读取，子 Agent 继承。 */
  confirmFileWrites?: boolean;
  /** 是否允许联网（web_search / web_fetch）。独立于 allowShell——联网检索不是执行命令，
   * 默认开启（true），仅沙箱 readonly / 明确关闭时才禁用。 */
  allowNetwork?: boolean;
  askUser: (request: AskRequest) => Promise<string>;
  /** 技能自动激活（验证门控）：模型用 pending 技能完成任务并通过 verify 后，调用其激活。 */
  promoteSkill?: (name: string) => string;
  /** MCP 工具审批（对齐 CodeBuddy MCP 工具独立审批）：外部 MCP 工具首次调用时询问 allow/allow-once/deny。 */
  requestMCPApproval?: (toolName: string, description: string) => Promise<"allow" | "once" | "">;
  /**
   * 指令执行前确认（指令审核）：Agent 调用 slash_command 执行自定义 .md 命令前，
   * 弹窗让用户审核（命令可能含危险操作）。返回 true 才执行。
   */
  confirmCommand?: (name: string, description: string) => Promise<boolean>;
  skillManager?: SkillManager;
  /** 任务清单（TodoWrite）的运行态，必须提供 */
  todoState: TodoState;
  /** 目标状态机（goal）：跟踪当前目标 + 阶段 + 轮次预算，跨压缩/跨会话持久。未提供时按空目标处理。 */
  goalState?: GoalState;
  /** 是否允许派发子智能体（主 Agent=true，子 Agent 默认 false 防递归） */
  canSpawn?: boolean;
  /** 工具白名单：若存在，则只暴露这些工具（子智能体据此限定权限） */
  toolWhitelist?: string[];
  /** 用户级记忆目录（globalStorage），remember 写用户级记忆用 */
  userMemoryPath?: string;
  /** Plan Mode：兼容旧入口；实际只读准入由 ToolRuntime spec 的 readOnlyAllowed 统一裁决。 */
  planMode?: boolean;
  /** 对话模式（plan/ask/craft/coder）。plan 与 ask 均只读；craft 与 coder 完整能力（含执行命令）。 */
  agentMode?: AgentMode;
  /** 模型覆盖（多模型分工）：本智能体用指定 provider/model，而非全局活动模型。
   * 由 runSubAgent 解析 spawn_agent 的 provider/model 参数或角色定义注入。 */
  modelOverride?: ModelOverride;
  /** OS 沙箱（受限执行器）：off 原样 / readonly 禁止 / sandbox 过滤 env + 硬超时（进程级受限，非 OS 级容器） */
  sandboxMode?: SandboxMode;
  /** run_command 硬超时（毫秒），防止命令挂起 / 资源耗尽 */
  commandTimeout?: number;
  /** 子智能体在指定 worktree 内运行时，文件操作上限改为该路径（主 Agent 一般为空） */
  worktreeRoot?: string;
  /** sandbox 档额外允许的 env 键（在系统必需之外） */
  envWhitelist?: string[];
  /** OS 沙箱网络出网配置（仅 sandbox 档生效，对标 Claude Code network.allowedDomains） */
  sandboxNetwork?: SandboxNetworkConfig;
  /** 引擎缺失时是否硬失败拦截（托管部署安全闸门，默认 false → 软降级进程级受限） */
  sandboxFailIfUnavailable?: boolean;
  /** 权限放行规则（allow，正则数组），由调用方传入 hooks.preToolUse 判定（单一真相源化） */
  allowRules?: string[];
  /** 权限拒绝规则（deny，正则数组），同上 */
  denyRules?: string[];
  /** 是否允许 hookify 命令规则执行外部命令（默认 false，安全闸门） */
  allowCommandHooks?: boolean;
  /** 大结果卸载目录（globalStorage），工具输出超阈值时落盘只留引用 */
  offloadDir?: string;
  /** 安全检查点的外部存储根目录（默认 ~/.freesek/checkpoints）。由扩展层传 globalStorage 更佳。 */
  checkpointDir?: string;
  /** 本 Agent / job 的取消信号。进程执行、模型请求与可取消工具应透传此 signal。 */
  signal?: AbortSignal;
  /** 当前 run 绑定的 durable event sink；按 session 捕获，避免 UI 切换导致后台日志串线。 */
  eventLog?: SessionEventSink;
  /** 事件流 actor：主 Agent 为 main，子 Agent 使用 sub:<name>。 */
  eventActor?: string;
  /** 文件修改痕迹（diff）：write_file/edit_file 执行后回传 unified diff（红绿对照），
   * 供前端渲染「修改痕迹」卡片（含 接受/回滚 操作）。不直接进模型上下文，避免污染。
   * 可选（子智能体未接线则不推送）。 */
  onFileDiff?: (info: {
    /** 本次编辑的唯一标识（前端回滚/接受时回传） */
    id: string;
    /** 展示用路径（相对工作区的原样参数） */
    file: string;
    /** 绝对路径（回滚时写入用） */
    path: string;
    kind: "create" | "write" | "edit" | "delete";
    diff: string;
    added: number;
    removed: number;
    /** 编辑前文件内容（create 时为 ""） */
    original: string;
    /** 编辑后文件内容 */
    applied: string;
  }) => void;
  /** 文件读取痕迹：read_file 成功读取后回传（展示路径 + 绝对路径），供前端「文件列表」面板
   * 实时展示本次回合涉及的文件。可选（子智能体未接线则不推送）。 */
  onFileRead?: (file: string, path: string) => void;
  /** run_python 生成的图表（matplotlib 等保存的 PNG）：把 base64 data URL 回传前端渲染进聊天。
   * 可选（子智能体未接线则不推送）。 */
  onPythonCharts?: (charts: Array<{ path: string; dataUrl: string; caption: string }>) => void;
  /** browser 工具截图：把 PNG data URL 回传前端渲染进聊天。可选（子智能体未接线则不推送）。 */
  onBrowserShot?: (shots: Array<{ path: string; dataUrl: string; caption: string }>) => void;
}

/** 生成一次文件编辑的唯一标识（diff 卡片 接受/回滚 用）。 */
function makeEditId(): string {
  return "ed-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 文件冲突检测：记录 FreeSeek 最近读/写过的文件指纹（mtime + size + sha1），
 * 在后续写/删前比对磁盘当前状态。若磁盘已被外部（用户编辑器/其它工具）改动，
 * 则与"上次已知状态"不一致 → 拒绝写/删并提示用户先重新 read_file，避免悄悄覆盖。
 * 关键缺口补齐（编码探测 + 冲突检测）之一。
 */
interface FileFingerprint {
  mtimeMs: number;
  size: number;
  hash: string;
}
const fileSnapshots = new Map<string, FileFingerprint>();

/** 计算文件指纹（读为 Buffer 算 sha1；读取失败返回 null）。 */
function snapshotFile(fp: string): FileFingerprint | null {
  try {
    const buf = fs.readFileSync(fp);
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    const st = fs.statSync(fp);
    return { mtimeMs: st.mtimeMs, size: buf.length, hash };
  } catch {
    return null;
  }
}

/** 记录/更新某文件的指纹（读或写后可调用）。 */
function recordSnapshot(fp: string): void {
  const fp0 = fp;
  const snap = snapshotFile(fp0);
  if (snap) fileSnapshots.set(path.resolve(fp0), snap);
}

/** 清空全部文件指纹（新建对话 / 切换会话时调用，避免跨会话误报冲突）。 */
export function clearFileSnapshots(): void {
  fileSnapshots.clear();
}

/**
 * 检测"文件自上次记录以来是否被外部改动"。
 * 返回 null 表示无记录（从未读/写，不拦截）；否则返回 {changed, info}。
 */
function checkConflict(fp: string): { changed: boolean; info?: FileFingerprint } | null {
  const abs = path.resolve(fp);
  const prev = fileSnapshots.get(abs);
  if (!prev) return null; // 本会话未接触过该文件，放行
  const cur = snapshotFile(fp);
  if (!cur) return null; // 当前读不到（可能刚被删除），放行
  const changed = prev.mtimeMs !== cur.mtimeMs || prev.size !== cur.size || prev.hash !== cur.hash;
  return { changed, info: cur };
}

/**
 * 自动 pre-edit Checkpoint：把当前工作区状态提交到 FreeSeek 独立 shadow Git，
 * 绝不调用用户仓库的 git stash / git reset，因此不会把用户或前序 Agent 改动从工作树移走。
 * 失败静默跳过，绝不阻断编辑。
 */
function autoCheckpoint(ctx: ToolContext): void {
  try {
    const label = `freesek-auto-cp:${Date.now().toString(36)}`;
    captureWorkspaceCheckpoint(ctx, label, "auto", true);
  } catch {
    /* git 不可用 / 存储不可写时静默跳过；永不改变用户工作树 */
  }
}

export async function executeToolBody(
  name: string,
  args: any,
  ctx: ToolContext
): Promise<string> {
  try {
    // 安全策略（mode / permission / hooks / timeout / MCP approval）由 ToolRuntime 统一处理。
    // 本函数只实现工具 body；禁止 Agent/扩展层直接调用（见 scripts/check.mjs runtime 边界检查）。
    switch (name) {
      case "read_file": {
        const fp = resolveSafe(ctx.workspaceRoot, String(args.path));
        // 防御性上限：先 stat 拿到大小，避免把超大文件（GB 级媒体/数据库/日志）整读进内存导致 OOM。
        let size = 0;
        try { size = fs.statSync(fp).size; } catch { /* 后续 readFileSync 会报错 */ }
        const READ_FILE_HARD_LIMIT = 16 * 1024 * 1024; // 16MB
        if (size > READ_FILE_HARD_LIMIT) {
          return (
            `⚠️ 文件 ${args.path} 过大（${size} 字节 > ${READ_FILE_HARD_LIMIT} 上限），已拒绝整读以免撑爆内存。\n` +
            `请改用 grep 检索、或对二进制用专用工具；若确需分段查看文本，可用 offset/limit 参数按需读取（本限制针对"无范围整读"）。`
          );
        }
        const buf = fs.readFileSync(fp);
        const enc = decodeBuffer(buf);
        // 记录指纹（供后续写/删时的冲突检测）
        recordSnapshot(fp);
        // 读取痕迹：推送给前端文件列表面板（展示路径 + 绝对路径）
        try {
          ctx.onFileRead?.(String(args.path), fp);
        } catch {
          /* 面板回调失败不影响工具执行 */
        }
        const raw = enc.text.split("\n");
        const offset = args.offset ? Number(args.offset) - 1 : 0;
        const limit = args.limit ? Number(args.limit) : READ_FILE_DEFAULT_LIMIT;
        const slice = raw.slice(offset, offset + limit);
        const encHint = enc.encoding === "utf-8"
          ? ""
          : `\n[编码探测] 该文件非 UTF-8，判定为 ${enc.encoding}${enc.bom ? "（含 BOM）" : "（无 BOM）"}；write_file/edit_file 会按原编码写回，请保留原内容编码。`;
        return `文件 ${args.path}（共 ${raw.length} 行，展示第 ${offset + 1}-${offset + slice.length} 行${
          !args.limit && raw.length > limit ? `，可用 limit 参数查看更多` : ""
        }${encHint}）:\n\n` +
          slice.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
      }
      case "write_file": {
        autoCheckpoint(ctx);
        const fp = resolveSafe(ctx.workspaceRoot, String(args.path));
        const newContent = String(args.content ?? "");
        // 冲突检测：若该文件本会话曾读/写过，且磁盘已被外部改动，则拒绝覆盖（除非 force）
        if (!args.force) {
          const cf = checkConflict(fp);
          if (cf && cf.changed) {
            return (
              `⚠️ 冲突检测：文件 ${args.path} 自上次读取/写入后已被外部修改（可能是你在编辑器里改了它）。\n` +
              `为避免覆盖你的改动，已拒绝本次 write_file。请先 read_file 重新读取最新内容，确认后再写入；或用 {force:true} 强制覆盖。`
            );
          }
        }
        // 编码探测：若已存在，按原编码写回（保留 GBK/UTF-16 等非 UTF-8 编码，避免乱码/破坏）
        let oldContent = "";
        let existed = false;
        let enc = "utf-8";
        let bom = false;
        try {
          if (fs.existsSync(fp)) {
            const buf = fs.readFileSync(fp);
            const info = decodeBuffer(buf);
            oldContent = info.text;
            enc = info.encoding;
            bom = info.bom;
            existed = true;
          }
        } catch {
          /* 读取旧内容失败（如权限），视为新文件 */
        }
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        const body = encodeBuffer(newContent, enc, existed ? bom : false);
        fs.writeFileSync(fp, body);
        recordSnapshot(fp);
        // 推送修改痕迹（unified diff），供前端渲染 + 接受/回滚；无实际差异时跳过
        if (ctx.onFileDiff) {
          const d = unifiedDiff(oldContent, newContent);
          if (d.added > 0 || d.removed > 0) {
            ctx.onFileDiff({
              id: makeEditId(),
              file: String(args.path),
              path: fp,
              kind: existed ? "write" : "create",
              diff: d.text,
              added: d.added,
              removed: d.removed,
              original: oldContent,
              applied: newContent,
            });
          }
        }
        const encNote = existed && isNonUtf8(enc) ? `（已按原编码 ${enc}${bom ? "(BOM)" : ""} 写回）` : "";
        return `已写入 ${args.path}（${newContent.length} 字符）${encNote}。`;
      }
      case "list_directory": {
        const dir = args.path ? resolveSafe(ctx.workspaceRoot, String(args.path)) : ctx.workspaceRoot;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries
          .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
          .join("\n");
      }
      case "search_files": {
        const results = walkMatch(ctx.workspaceRoot, String(args.pattern), 0, 200);
        return results.length ? results.join("\n") : "未找到匹配文件。";
      }
      case "grep": {
        const start = args.path ? resolveSafe(ctx.workspaceRoot, String(args.path)) : ctx.workspaceRoot;
        const inc = args.include ? String(args.include) : null;
        const re = new RegExp(escapeRegExp(String(args.pattern)), "i");
        const out: string[] = [];
        grepWalk(start, re, inc, out, 0, 100);
        return out.length ? out.join("\n") : "未找到匹配内容。";
      }
      case "run_command": {
        if (!ctx.allowShell) {
          return "⚠️ 执行命令被禁用。请在设置中开启 freesek.allowShell（高危操作）。";
        }
        const base = ctx.worktreeRoot ?? ctx.workspaceRoot;
        const cwd = args.cwd ? resolveSafe(base, String(args.cwd)) : base;
        const policy = execPolicyFromContext(ctx);
        const exec = commandExecPlan(policy);
        if (exec.plan.blocked) {
          return `⛔ ${exec.plan.blockedReason}`;
        }
        const timeout = ctx.commandTimeout ?? 120000;
        const argv = Array.isArray(args.argv)
          ? args.argv.map((value: unknown) => String(value)).filter((value: string, index: number) => index > 0 || value.trim())
          : undefined;
        const shellCommand = typeof args.command === "string" ? args.command.trim() : "";
        const command = shellCommand || (argv?.length ? argv.map((value: string) => JSON.stringify(value)).join(" ") : "");
        if (!command) return "run_command 失败：command / argv 至少需要提供一个。";
        // 工作区变更检测（对标 Codex shell_snapshot）：命令执行前后各取 git 快照，
        // 出现未声明变更时把提示回灌给模型核实/回滚。非 git 仓库自动跳过，不阻塞执行。
        const before = await snapshotGitStatus(cwd);
        const out = await getCommandRunner().run({
          cwd,
          command,
          ...(argv?.length ? { argv } : {}),
          timeoutMs: timeout,
          envWhitelist: ctx.envWhitelist,
          exec,
          network: policy.network,
          label: "run_command",
          signal: ctx.signal,
          ...(typeof args.input === "string" ? { input: args.input } : {}),
        });
        const note = await detectWorkspaceChanges(cwd, before);
        return note ? out + note : out;
      }
      case "ask_user": {
        const req: AskRequest = { question: String(args.question ?? "") };
        if (Array.isArray(args.options)) {
          req.options = (args.options as any[]).slice(0, 4).map((o) => ({
            label: String(o?.label ?? ""),
            description: o?.description ? String(o.description) : undefined,
          }));
        }
        if (typeof args.multiSelect === "boolean") req.multiSelect = args.multiSelect;
        return await ctx.askUser(req);
      }
      case "edit_file": {
        autoCheckpoint(ctx);
        const fp = resolveSafe(ctx.workspaceRoot, String(args.path));
        const buf = fs.readFileSync(fp);
        const info = decodeBuffer(buf);
        const content = info.text;
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!oldStr) return "edit_file 失败：old_string 为空。";
        // 冲突检测：磁盘内容与上次读取不一致（old_string 也据此判断）
        if (!args.force) {
          const cf = checkConflict(fp);
          if (cf && cf.changed) {
            return (
              `⚠️ 冲突检测：文件 ${args.path} 自上次读取/写入后已被外部修改。\n` +
              `为避免覆盖你的改动，已拒绝本次 edit_file。请先 read_file 重新读取最新内容，确认后再编辑；或用 {force:true} 强制覆盖。`
            );
          }
        }
        if (!content.includes(oldStr)) {
          return `edit_file 失败：在 ${args.path} 中未找到 old_string（该文件编码为 ${info.encoding}，已按原编码读取；若你在别处改过文件，请先 read_file 重新读取）。`;
        }
        const count = content.split(oldStr).length - 1;
        if (count > 1 && !args.replace_all) {
          return `edit_file 失败：old_string 出现 ${count} 次，请用 replace_all=true 或提供更多上下文。`;
        }
        const newContent = args.replace_all
          ? content.split(oldStr).join(newStr)
          : content.replace(oldStr, newStr);
        fs.writeFileSync(fp, encodeBuffer(newContent, info.encoding, info.bom));
        recordSnapshot(fp);
        // 推送修改痕迹（unified diff），供前端渲染 + 接受/回滚；无实际差异时跳过
        if (ctx.onFileDiff) {
          const d = unifiedDiff(content, newContent);
          if (d.added > 0 || d.removed > 0) {
            ctx.onFileDiff({
              id: makeEditId(),
              file: String(args.path),
              path: fp,
              kind: "edit",
              diff: d.text,
              added: d.added,
              removed: d.removed,
              original: content,
              applied: newContent,
            });
          }
        }
        const encNote = isNonUtf8(info.encoding) ? `（已按原编码 ${info.encoding} 写回）` : "";
        return `已编辑 ${args.path}（${args.replace_all ? count : 1} 处替换）${encNote}。`;
      }
      case "glob": {
        const results = walkMatch(ctx.workspaceRoot, String(args.pattern), 0, 500);
        return results.length ? results.join("\n") : "未找到匹配文件。";
      }
      case "load_skill": {
        if (!ctx.skillManager) return "技能系统未初始化。";
        return ctx.skillManager.loadSkill(String(args.name));
      }
      case "todo_write": {
        const arr = Array.isArray(args.todos) ? (args.todos as any[]) : [];
        const items: TodoItem[] = arr.map((t) => {
          const s = String(t?.status ?? "pending");
          const status: TodoItem["status"] =
            s === "in_progress" ? "in_progress" : s === "completed" ? "completed" : "pending";
          return {
            content: String(t?.content ?? ""),
            status,
            activeForm: t?.activeForm ? String(t.activeForm) : undefined,
          };
        });
        ctx.todoState.items = items;
        if (!items.length) return "任务清单已清空。";
        return (
          `已更新任务清单（共 ${items.length} 项）：\n` +
          items.map((it, i) => `${i + 1}. [${it.status}] ${it.content}`).join("\n")
        );
      }
      case "todo_read": {
        const items = ctx.todoState.items;
        if (!items.length) return "任务清单为空。";
        return items.map((it, i) => `${i + 1}. [${it.status}] ${it.content}`).join("\n");
      }
      case "goal": {
        const op = String(args.op ?? "").trim();
        const g = ctx.goalState ?? emptyGoalState();
        const maxRounds = args.max_rounds !== undefined ? Number(args.max_rounds) : undefined;
        switch (op) {
          case "create": {
            const objective = String(args.objective ?? "").trim();
            if (!objective) return "goal create 需要 objective 参数。";
            applyGoalOp(g, { op: "create", objective, maxRounds });
            saveGoalState(ctx.workspaceRoot, g);
            return `目标已登记：\n${renderGoalView(g)}`;
          }
          case "edit":
            applyGoalOp(g, {
              op: "edit",
              objective: args.objective !== undefined ? String(args.objective) : undefined,
              maxRounds,
            });
            saveGoalState(ctx.workspaceRoot, g);
            return renderGoalView(g);
          case "pause":
            applyGoalOp(g, { op: "pause" });
            saveGoalState(ctx.workspaceRoot, g);
            return renderGoalView(g);
          case "resume":
            applyGoalOp(g, { op: "resume" });
            saveGoalState(ctx.workspaceRoot, g);
            return renderGoalView(g);
          case "complete":
            applyGoalOp(g, { op: "complete" });
            saveGoalState(ctx.workspaceRoot, g);
            return renderGoalView(g);
          case "clear":
            applyGoalOp(g, { op: "clear" });
            saveGoalState(ctx.workspaceRoot, g);
            return renderGoalView(g);
          case "block":
            applyGoalOp(g, { op: "block", reason: args.reason ? String(args.reason) : undefined });
            saveGoalState(ctx.workspaceRoot, g);
            return renderGoalView(g);
          default:
            return `未知操作「${op}」。支持：create/edit/pause/resume/complete/block/clear。`;
        }
      }
      case "goal_view": {
        return renderGoalView(ctx.goalState ?? emptyGoalState());
      }
      case "job_list": {
        const jobs = jobRegistry.list();
        if (!jobs.length) return "没有后台任务。";
        return "后台任务：\n" + jobs.map(renderJobView).join("\n");
      }
      case "job_output": {
        const id = String(args.id ?? "").trim();
        const j = jobRegistry.get(id);
        if (!j) return `未找到后台任务 ${id}。用 job_list 查看。`;
        return j.output.length ? j.output.join("\n") : `（${j.id} 暂无输出）`;
      }
      case "job_kill": {
        const id = String(args.id ?? "").trim();
        const r = jobRegistry.kill(id);
        if (r === null) return `未找到后台任务 ${id}。用 job_list 查看。`;
        return r;
      }
      case "remember": {
        const content = String(args.content ?? "").trim();
        if (!content) return "remember 失败：content 为空。";
        const scope: "user" | "project" = args.scope === "user" ? "user" : "project";
        return rememberFact(content, scope, ctx.workspaceRoot, ctx.userMemoryPath ?? "");
      }
      case "slash_command": {
        const cmds = loadCommands(ctx.workspaceRoot);
        const nm = args.name ? String(args.name).trim() : "";
        if (!nm) {
          if (!cmds.length)
            return "暂无可用 Slash 命令（在项目 .agent/commands/ 下放置 <name>.md 即可创建）。";
          return (
            "可用 Slash 命令：\n" +
            cmds.map((c) => `- /${c.name}: ${c.description}`).join("\n") +
            "\n调用 slash_command({name, args}) 执行某个命令。"
          );
        }
        const resolved = resolveCommand(ctx.workspaceRoot, nm, args.args ? String(args.args) : "");
        if (!resolved) return `未找到命令「${nm}」。`;
        // 指令审核：Agent 调用 slash_command 执行自定义命令前，弹窗让用户确认（命令可能含危险操作）
        if (ctx.confirmCommand) {
          const ok = await ctx.confirmCommand(nm, resolved.command.description || resolved.prompt.slice(0, 120));
          if (!ok) return `⛔ 用户拒绝了执行 Slash 命令 /${nm}。请尊重用户决定，改用其它方式。`;
        }
        return `【Slash 命令 /${nm}】请按以下指令继续：\n\n${resolved.prompt}`;
      }
      case "lsp": {
        const actionRaw = String(args.action ?? "definition");
        const valid: LspAction[] = [
          "definition",
          "references",
          "documentSymbols",
          "workspaceSymbols",
        ];
        const action = (valid as string[]).includes(actionRaw)
          ? (actionRaw as LspAction)
          : "definition";
        return runLsp(
          {
            action,
            file: args.file ? String(args.file) : undefined,
            line: args.line ? Number(args.line) : undefined,
            character: args.character ? Number(args.character) : undefined,
            query: args.query ? String(args.query) : undefined,
          },
          ctx.workspaceRoot
        );
      }
      case "create_worktree": {
        if (!isGitRepo(ctx.workspaceRoot)) {
          return "⚠️ 当前工作区不是 git 仓库，无法使用 worktree。请先在仓库根初始化 git。";
        }
        const name = String(args.name ?? "").trim();
        if (!name) return "create_worktree 失败：name 为空。";
        try {
          const wp = addWorktree(ctx.workspaceRoot, name, args.branch ? String(args.branch) : undefined, args.base ? String(args.base) : undefined);
          return `已创建工作树：${wp}\n分支：worktree/${name}\n可派发子智能体并行工作：spawn_agent({ task, mode:"executor", worktree:"${wp}" })`;
        } catch (e: any) {
          return `create_worktree 失败：${e?.message ?? String(e)}`;
        }
      }
      case "remove_worktree": {
        const p = args.path ? String(args.path) : "";
        if (!p) return "remove_worktree 失败：path 为空。";
        const wt = resolveSafe(ctx.workspaceRoot, p);
        if (!wt.includes(path.join(ctx.workspaceRoot, ".worktrees"))) {
          return "⛔ 仅允许移除 .worktrees/ 下的工作树。";
        }
        try {
          return removeWorktree(ctx.workspaceRoot, wt);
        } catch (e: any) {
          return `remove_worktree 失败：${e?.message ?? String(e)}`;
        }
      }
      case "list_worktrees": {
        if (!isGitRepo(ctx.workspaceRoot)) return "⚠️ 当前工作区不是 git 仓库。";
        try {
          const wts = listWorktrees(ctx.workspaceRoot);
          if (!wts.length) return "未找到工作树。";
          return wts
            .map((w) => `${w.path}  [${w.branch || "?"}]${w.bare ? " (主)" : ""}`)
            .join("\n");
        } catch (e: any) {
          return `list_worktrees 失败：${e?.message ?? String(e)}`;
        }
      }
      case "checkpoint": {
        const cname = args.name ? String(args.name).trim() : "";
        const label = cname ? `freesek-cp:${cname}` : `freesek-cp:${Date.now().toString(36)}`;
        try {
          const captured = captureWorkspaceCheckpoint(ctx, label, "manual", false);
          const hash = captured?.hash ?? "";
          return `📌 已创建安全检查点：${label}（${hash.slice(0, 10)}）\n检查点保存在 FreeSeek 独立 shadow Git 中，不会修改用户 branch/index/stash。`;
        } catch (e: any) {
          return `checkpoint 失败：${e?.message ?? String(e)}（需要本机可用 git，且检查点存储目录可写）`;
        }
      }
      case "rewind": {
        try {
          const targetName = args.name ? String(args.name).trim() : "";
          const entries = listCheckpoints(ctx.workspaceRoot, ctx.checkpointDir, 200);
          if (!entries.length) {
            return "⚠️ 没有可回滚的 FreeSeek 检查点。请先用 checkpoint 创建，或开启 freesek.autoCheckpoint。";
          }
          if (targetName && !entries.some((e) => e.hash.startsWith(targetName) || e.label === `freesek-cp:${targetName}` || e.label === targetName)) {
            const names = entries.slice(0, 20).map((e) => e.label).join("、");
            return `⚠️ 未找到检查点「${targetName}」。当前检查点：${names}`;
          }
          const restored = restoreCheckpoint(ctx.workspaceRoot, targetName, ctx.checkpointDir);
          clearFileSnapshots();
          return `↩️ 已回滚到安全检查点 ${restored.label}（${restored.hash.slice(0, 10)}）。\n用户 Git stash/branch/index 未被修改。注意：该操作会恢复工作区文件状态，因此始终应经过破坏性权限确认。`;
        } catch (e: any) {
          return `rewind 失败：${e?.message ?? String(e)}`;
        }
      }
      case "list_checkpoints": {
        try {
          const entries = listCheckpoints(ctx.workspaceRoot, ctx.checkpointDir, 50);
          if (!entries.length) {
            return "当前没有 FreeSeek 检查点。用 checkpoint 工具创建后即可在此查看时间线并 rewind。";
          }
          const lines = entries.map((e, i) => {
            const when = new Date(e.createdAt).toLocaleString();
            return `  ${i + 1}. ${e.hash.slice(0, 10)}  ${e.label}  ${when}${e.eventSeq ? `  [event #${e.eventSeq}]` : ""}`;
          });
          return `📚 FreeSeek 安全检查点时间线（最新在前）：\n${lines.join("\n")}\n\n用 rewind({ name }) 按名称或 commit 前缀回滚。`;
        } catch (e: any) {
          return `list_checkpoints 失败：${e?.message ?? String(e)}`;
        }
      }
      case "verify": {
        if (!ctx.allowShell) {
          return "⚠️ verify 需要执行命令，但 freesek.allowShell 未开启。请在设置中开启以使用验证闭环。";
        }
        try {
          return await runVerification(ctx, args);
        } catch (e: any) {
          return `verify 失败：${e?.message ?? String(e)}`;
        }
      }
      case "run_python": {
        if (!ctx.allowShell) {
          return "⚠️ run_python 需要执行命令，但 freesek.allowShell 未开启。请在设置中开启以使用 Python 数据分析。";
        }
        try {
          return await runPython(ctx, args);
        } catch (e: any) {
          return `run_python 失败：${e?.message ?? String(e)}`;
        }
      }
      case "run_code": {
        if (!ctx.allowShell) {
          return "⚠️ run_code 需要执行命令，但 freesek.allowShell 未开启。请在设置中开启以使用 Code Mode。";
        }
        try {
          return await runCode(ctx, args);
        } catch (e: any) {
          return `run_code 失败：${e?.message ?? String(e)}`;
        }
      }
      case "browser": {
        try {
          return await browserAction(String(args.action ?? ""), args, {
            workspaceRoot: ctx.workspaceRoot,
            onBrowserShot: ctx.onBrowserShot,
          });
        } catch (e: any) {
          return `browser 失败：${e?.message ?? String(e)}`;
        }
      }
      case "promote_skill": {
        if (!ctx.promoteSkill) return "技能系统未初始化。";
        return ctx.promoteSkill(String(args.name ?? ""));
      }
      case "web_search": {
        if (ctx.allowNetwork === false) return "⚠️ web_search 需要联网，但联网已禁用（freesek.allowNetwork=false）。请在设置中开启以使用联网检索。";
        return await runWebSearch(ctx, args);
      }
      case "web_fetch": {
        if (ctx.allowNetwork === false) return "⚠️ web_fetch 需要联网，但联网已禁用（freesek.allowNetwork=false）。请在设置中开启以使用网页抓取。";
        return await runWebFetch(ctx, args);
      }
      case "mcp_read_resource":
      case "mcp_get_prompt":
      case "mcp_list_kb":
      case "mcp_kb_search":
        // MCP 独立审批与会话级 allow cache 已统一在 ToolRuntime；这里仅做 body dispatch。
        if (name === "mcp_read_resource") {
          const uri = String(args.uri ?? "");
          if (!uri) return "⚠️ mcp_read_resource 需要 uri。";
          return await mcpManager.callResource(uri, ctx.signal);
        }
        if (name === "mcp_get_prompt") {
          const pname = String(args.name ?? "");
          if (!pname) return "⚠️ mcp_get_prompt 需要 name。";
          return await mcpManager.callPrompt(pname, args.arguments || {}, ctx.signal);
        }
        if (name === "mcp_list_kb") {
          return mcpManager.knowledgeSummary() || "（未连接任何暴露检索工具/资源的 MCP server）";
        }
        // mcp_kb_search
        {
          const q = String(args.query ?? "").trim();
          if (!q) return "⚠️ mcp_kb_search 需要 query。";
          const server = args.server ? String(args.server) : undefined;
          const max = Math.min(Math.max(Number(args.max) || 5, 1), 50);
          return await mcpManager.searchKnowledge(q, server, max, ctx.signal);
        }
      case "delete_file": {
        const raw = String(args.path ?? "").trim();
        if (!raw) return "⚠️ delete_file 需要 path。";
        const abs = resolveSafe(ctx.workspaceRoot, raw);
        const rel = path.relative(ctx.workspaceRoot, abs);
        if (rel.startsWith("..") && path.isAbsolute(raw)) {
          return "⛔ 禁止删除工作区外路径。";
        }
        if (!fs.existsSync(abs)) return `未找到路径：${raw}`;
        const recursive = args.recursive === true;
        const stats = fs.statSync(abs);
        // 目录必须显式 recursive
        if (stats.isDirectory() && !recursive) {
          return `⚠️ ${raw} 是目录，删除目录需设 recursive: true。`;
        }
        // 删除前读取目标内容供 Agent 判断（安全确认 + 文件列表统计）
        let deletedContent = "";
        if (stats.isFile() && stats.size <= 4096) {
          try { deletedContent = fs.readFileSync(abs, "utf8"); } catch { /* 忽略 */ }
        }
        const preview = deletedContent ? `\n内容预览:\n${deletedContent.slice(0, 500)}` : "";
        const r = trashPath(abs, recursive);
        if (r.ok) {
          // 删除痕迹（kind=delete）：推送给前端文件列表面板，removed=原文件行数
          if (ctx.onFileDiff) {
            try {
              ctx.onFileDiff({
                id: makeEditId(),
                file: raw,
                path: abs,
                kind: "delete",
                diff: "",
                added: 0,
                removed: deletedContent ? deletedContent.split("\n").length : 0,
                original: "",
                applied: "",
              });
            } catch {
              /* 面板回调失败不影响工具执行 */
            }
          }
          return `✅ 已安全删除（${r.detail}，可恢复）：${raw}${preview}`;
        }
        // 回收站不可用：警告 + 不永久删除，改为建议
        return (
          `⚠️ 无法移入回收站（${r.detail}）。出于安全未执行永久删除。\n` +
          `请手动删除 ${raw}，或确认后使用系统命令 rm/Remove-Item 删除。`
        );
      }
      default: {
        // 动态 MCP 工具与 connector 仍只提供 body dispatch；审批/模式/超时由 ToolRuntime 包裹。
        if (name.startsWith("mcp__")) {
          return await mcpManager.callTool(name, args, ctx.signal);
        }
        const r = await dispatchConnectorTool(name, args, ctx);
        if (r.handled) return r.result;
        return `未知工具: ${name}`;
      }
    }
  } catch (e: any) {
    return `工具执行出错: ${e?.message ?? String(e)}`;
  }
}

/**
 * 大结果卸载（Layer 7 可观测/防爆上下文）：工具输出超过阈值时写入 offloadDir，
 * 上下文里只保留引用路径，模型可用 read_file 按需取回。对齐 Claude Code「>50K 落盘只留引用」。
 */
export function maybeOffload(result: string, offloadDir?: string, threshold = 50000): string {
  if (!offloadDir || result.length <= threshold) return result;
  try {
    fs.mkdirSync(offloadDir, { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const fp = path.join(offloadDir, `result-${id}.txt`);
    fs.writeFileSync(fp, result, "utf8");
    return (
      `工具输出较大（${result.length} 字符），已卸载到：\n${fp}\n` +
      `如需查看完整内容，请用 read_file 读取该路径（不要复述此引用本身）。`
    );
  } catch {
    return result; // 落盘失败则原样返回，降级不阻塞
  }
}

/** 合并内置工具与已连接 MCP server 的工具定义，供系统提示词与模型调用使用。 */
export function getAllToolDefinitions(): ToolDefinition[] {
  // 内置工具 + MCP 工具 + 连接器插件工具
  return [...TOOL_DEFINITIONS, ...mcpManager.getToolDefinitions(), ...connectorToolDefinitions()];
}
