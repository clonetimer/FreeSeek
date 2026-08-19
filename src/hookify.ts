import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFileSync } from "child_process";
import { parseFrontmatter } from "./frontmatter";

/**
 * Hookify —— 用户可编程 Hook 规则引擎（对标 Claude Code hookify 插件）。
 *
 * 用户无需改代码，只需在工作区写 markdown 规则文件即可新增「拦截/警告」行为，
 * 规则即时生效（按 mtime 热加载，无需重启）：
 *
 *   .freeseek/hooks/<name>.md        项目级规则
 *   ~/.freeseek/hooks/<name>.md      用户全局规则（跨项目生效）
 *
 * 规则文件格式（YAML frontmatter + markdown 正文）：
 *   ---
 *   name: block-dangerous-rm
 *   enabled: true
 *   event: bash            # bash | file | prompt | stop | all
 *   pattern: rm\s+-rf      # 简单规则：正则作用于事件主字段
 *   action: block          # warn | block（默认 warn）
 *   ---
 *   正文：命中时返回给模型/用户的提示语
 *
 * 高级规则（多条件，全部满足才命中）：
 *   ---
 *   name: no-credentials-in-ts
 *   enabled: true
 *   event: file
 *   action: warn
 *   conditions:
 *     - field: file_path
 *       operator: regex_match
 *       pattern: \.tsx?$
 *     - field: new_string
 *       operator: regex_match
 *       pattern: (API_KEY|SECRET|TOKEN)\s*=\s*["']
 *   ---
 */

export type HookifyEvent = "bash" | "file" | "prompt" | "stop" | "all";
export type HookifyAction = "warn" | "block" | "command";
export type HookifyOperator =
  | "regex_match"
  | "contains"
  | "equals"
  | "not_contains"
  | "starts_with"
  | "ends_with";

export interface HookifyCondition {
  field: string;
  operator: HookifyOperator;
  pattern: string;
}

export interface HookifyRule {
  name: string;
  enabled: boolean;
  event: HookifyEvent;
  action: HookifyAction;
  /** 简单规则：单个正则，作用于事件主字段 */
  pattern?: string;
  /** 高级规则：多条件，全部满足才命中（优先级高于 pattern） */
  conditions?: HookifyCondition[];
  /** action=command 时要执行的外部命令（受 allow 开关门控） */
  command?: string;
  message: string;
  source: string;
}

export interface HookifyResult {
  /** action=block 且命中时，返回阻断消息（否则为 null） */
  blocked: string | null;
  /** action=warn 且命中时，返回警告消息列表 */
  warnings: string[];
}

/** 事件 → 匹配的工具名集合（只列出 tools.ts 中真实存在的工具名） */
const EVENT_TOOLS: Record<Exclude<HookifyEvent, "all">, string[]> = {
  bash: ["run_command", "run_code"],
  file: ["edit_file", "write_file"],
  prompt: ["UserPromptSubmit"],
  stop: ["Stop"],
};

/**
 * 事件主字段候选名（pattern 的默认作用字段）。
 * 按优先级列出候选：同一事件会命中不同工具，而各工具的参数名并不统一
 * （如 file 事件：edit_file 用 new_string，write_file 用 content），
 * 因此取第一个非空字段值作为作用文本。
 */
const EVENT_FIELDS: Record<Exclude<HookifyEvent, "all">, string[]> = {
  bash: ["command", "code"],
  file: ["new_string", "new_text", "content"],
  prompt: ["user_prompt"],
  stop: ["transcript"],
};

/** 从工具参数中提取字段值 */
function extractField(field: string, input: any): string {
  const v = input?.[field];
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** 规则缓存：source → mtime，规则文件改动即时重载（热加载） */
const ruleCache = new Map<string, { mtimeMs: number; rule: HookifyRule }>();

/** 解析单个规则文件 → HookifyRule | null（解析失败返回 null） */
function parseRuleFile(fp: string): HookifyRule | null {
  let raw: string;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
  const { fm: data, body } = parseFrontmatter(raw);
  const name = String(data.name ?? path.basename(fp, ".md"));
  const event = String(data.event ?? "all") as HookifyEvent;
  const action = String(data.action ?? "warn") as HookifyAction;
  const enabled = data.enabled === undefined ? true : String(data.enabled).toLowerCase() !== "false";
  const pattern = data.pattern ? String(data.pattern) : undefined;

  let conditions: HookifyCondition[] | undefined;
  if (Array.isArray(data.conditions)) {
    conditions = data.conditions
      .map((c: any) => ({
        field: String(c?.field ?? ""),
        operator: String(c?.operator ?? "regex_match") as HookifyOperator,
        pattern: String(c?.pattern ?? ""),
      }))
      .filter((c) => c.field && c.pattern);
    if (!conditions.length) conditions = undefined;
  }

  const command = action === "command" && data.command ? String(data.command) : undefined;
  if (!body && !pattern && !conditions && !command) return null;
  return { name, enabled, event, action, pattern, conditions, command, message: body || name, source: fp };
}

/** 收集规则文件路径：项目级 + 用户全局 */
function collectRuleFiles(workspaceRoot: string): string[] {
  const files: string[] = [];
  const dirs = [
    path.join(workspaceRoot, ".freeseek", "hooks"),
    path.join(os.homedir(), ".freeseek", "hooks"),
  ];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".md")) files.push(path.join(dir, f));
      }
    } catch {
      /* 目录不存在则忽略 */
    }
  }
  return files;
}

/** 加载全部规则（带 mtime 缓存，热加载） */
export function loadHookifyRules(workspaceRoot: string): HookifyRule[] {
  const rules: HookifyRule[] = [];
  const files = collectRuleFiles(workspaceRoot);
  for (const fp of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch {
      ruleCache.delete(fp);
      continue;
    }
    const cached = ruleCache.get(fp);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      rules.push(cached.rule);
      continue;
    }
    const rule = parseRuleFile(fp);
    if (rule) {
      ruleCache.set(fp, { mtimeMs: stat.mtimeMs, rule });
      rules.push(rule);
    } else {
      ruleCache.delete(fp);
    }
  }
  // 清理已删除文件的缓存
  const live = new Set(files);
  for (const fp of [...ruleCache.keys()]) {
    if (!live.has(fp)) ruleCache.delete(fp);
  }
  return rules;
}

function applyOperator(op: HookifyOperator, text: string, pattern: string): boolean {
  try {
    switch (op) {
      case "regex_match":
        return new RegExp(pattern, "i").test(text);
      case "contains":
        return text.includes(pattern);
      case "equals":
        return text === pattern;
      case "not_contains":
        return !text.includes(pattern);
      case "starts_with":
        return text.startsWith(pattern);
      case "ends_with":
        return text.endsWith(pattern);
    }
  } catch {
    return false;
  }
  return false;
}

/** 单条规则是否命中当前事件上下文 */
function ruleMatches(
  rule: HookifyRule,
  event: HookifyEvent,
  toolName: string,
  input: any
): boolean {
  // 事件归一化：rule.event 为 "all" 时对任意事件生效，否则必须与当前事件一致
  if (rule.event !== "all" && rule.event !== event) return false;
  // 工具名匹配：all 事件对任意工具；具体事件需在 EVENT_TOOLS 集合内
  if (rule.event !== "all" && rule.event !== "stop") {
    const tools = EVENT_TOOLS[rule.event as keyof typeof EVENT_TOOLS] ?? [];
    if (!tools.includes(toolName)) return false;
  }

  // 高级规则：全部条件满足才命中
  if (rule.conditions && rule.conditions.length) {
    return rule.conditions.every((c) =>
      applyOperator(c.operator, extractField(c.field, input), c.pattern)
    );
  }

  // 简单规则：pattern 作用于事件主字段（多候选，取第一个非空字段值）
  if (rule.pattern) {
    const fields = EVENT_FIELDS[event as keyof typeof EVENT_FIELDS] ?? ["command"];
    const text = fields.map((f) => extractField(f, input)).find((v) => v !== "") ?? "";
    return applyOperator("regex_match", text, rule.pattern);
  }

  // 无 pattern 无 conditions：视为命中（用于纯提示型规则，需有正文）
  return !!rule.message;
}

/**
 * 评估 hookify 规则。event 与 toolName/input 的关系：
 *  - preToolUse：event=bash|file，toolName=实际工具名，input=工具参数
 *  - userPromptSubmit：event=prompt，toolName="UserPromptSubmit"，input={user_prompt: text}
 */
export function evaluateHookifyRules(
  event: HookifyEvent,
  toolName: string,
  input: any,
  workspaceRoot: string
): HookifyResult {
  const result: HookifyResult = { blocked: null, warnings: [] };
  if (!workspaceRoot) return result;
  let rules: HookifyRule[];
  try {
    rules = loadHookifyRules(workspaceRoot);
  } catch {
    return result;
  }
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.action === "command") continue; // command 由 runCommandHooks 单独执行
    if (!ruleMatches(rule, event, toolName, input)) continue;
    if (rule.action === "block" && !result.blocked) {
      result.blocked = `⛔ [hookify:${rule.name}] ${rule.message}`;
    } else {
      result.warnings.push(`⚠️ [hookify:${rule.name}] ${rule.message}`);
    }
  }
  return result;
}

/** 便捷：检查单条规则是否匹配（供配置 UI/测试使用） */
export function validateHookifyPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

/** 便捷：获取当前已加载规则清单（供 /hookify:list 类命令使用） */
export function listHookifyRules(workspaceRoot: string): { name: string; event: string; action: string; enabled: boolean; source: string }[] {
  return loadHookifyRules(workspaceRoot).map((r) => ({
    name: r.name,
    event: r.event,
    action: r.action,
    enabled: r.enabled,
    source: r.source,
  }));
}

export const _private = { parseFrontmatter, extractField };

/** 命令 hook 命中结果 */
export interface CommandHookResult {
  blocked: string | null;
  notes: string[];
}

/**
 * 执行 action=command 的 hookify 规则（对标 QwenWork hooks：外部命令 + stdin JSON + exit code）。
 * 仅当 allow=true 时才真正执行，否则命令类规则被跳过（安全闸门，默认关闭）。
 * exit code 语义：0=成功（stdout 作为 note 回灌）；2=阻塞（等价 block）；其他=警告。
 */
export async function runCommandHooks(
  workspaceRoot: string,
  event: HookifyEvent,
  toolName: string,
  input: any,
  allow: boolean
): Promise<CommandHookResult> {
  const result: CommandHookResult = { blocked: null, notes: [] };
  if (!allow || !workspaceRoot) return result;
  let rules: HookifyRule[];
  try {
    rules = loadHookifyRules(workspaceRoot);
  } catch {
    return result;
  }
  const payload = JSON.stringify({ hook_event: event, tool: toolName, input: input ?? {}, workspace: workspaceRoot });
  for (const rule of rules) {
    if (!rule.enabled || rule.action !== "command" || !rule.command) continue;
    try {
      if (!ruleMatches(rule, event, toolName, input)) continue;
    } catch {
      continue;
    }
    let code = 0;
    let stdout = "";
    try {
      stdout = String(
        execFileSync(rule.command, {
          shell: true,
          input: payload,
          timeout: 10000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        })
      );
    } catch (e: any) {
      code = e?.status ?? 2;
      stdout = String(e?.stdout ?? "");
    }
    const note = stdout.trim();
    if (code === 2) {
      result.blocked = `⛔ [hookify:${rule.name}] ${note || rule.message}`;
      break;
    }
    if (code !== 0) {
      result.notes.push(`⚠️ [hookify:${rule.name}] exit=${code} ${note || rule.message}`);
    } else if (note) {
      result.notes.push(`[hookify:${rule.name}] ${note}`);
    }
  }
  return result;
}

// ── 规则文件管理（侧边栏 UI / 命令用）：新建 / 启停 / 删除 ──

export interface RuleFileResult {
  ok: boolean;
  /** 成功时的文件路径（create 时为新建文件；toggle/delete 时为原 source） */
  path?: string;
  error?: string;
}

/** 新建规则的可选字段 */
export interface CreateHookifyRuleOpts {
  event: HookifyEvent;
  action: HookifyAction;
  pattern?: string;
  command?: string;
  message?: string;
}

/** 把规则字段序列化为 markdown 规则文件内容（YAML frontmatter + 正文）。 */
export function serializeHookifyRule(name: string, opts: CreateHookifyRuleOpts): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${name}`);
  lines.push(`enabled: true`);
  lines.push(`event: ${opts.event}`);
  lines.push(`action: ${opts.action}`);
  if (opts.pattern) lines.push(`pattern: ${opts.pattern}`);
  if (opts.command) lines.push(`command: ${opts.command}`);
  lines.push("---");
  const body = (opts.message ?? "").trim();
  lines.push(body);
  return lines.join("\n");
}

/** 项目级 hooks 目录（不存在则创建）。 */
function ensureHooksDir(workspaceRoot: string): string {
  const dir = path.join(workspaceRoot, ".freeseek", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 新建一条 hookify 规则到项目级 .freeseek/hooks/<name>.md。
 * name 需为安全文件名（字母/数字/_/-），返回 RuleFileResult。
 */
export function createHookifyRule(workspaceRoot: string, name: string, opts: CreateHookifyRuleOpts): RuleFileResult {
  if (!workspaceRoot) return { ok: false, error: "未打开工作区，无法创建规则。" };
  const safe = String(name || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(safe)) return { ok: false, error: "规则名仅允许字母/数字/下划线/连字符。" };
  const fp = path.join(ensureHooksDir(workspaceRoot), `${safe}.md`);
  if (fs.existsSync(fp)) return { ok: false, error: `规则「${safe}」已存在。` };
  try {
    fs.writeFileSync(fp, serializeHookifyRule(safe, opts), "utf8");
    return { ok: true, path: fp };
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message ?? e}` };
  }
}

/**
 * 切换规则启用状态：改写规则文件 frontmatter 的 enabled 行。
 * enabled 行缺失时在 name 行之后插入；热加载会因 mtime 变化自动重新解析。
 */
export function toggleHookifyRule(source: string, enabled: boolean): RuleFileResult {
  if (!source) return { ok: false, error: "缺少规则文件路径。" };
  let raw: string;
  try {
    raw = fs.readFileSync(source, "utf8");
  } catch (e: any) {
    return { ok: false, error: `读取失败：${e?.message ?? e}` };
  }
  const lines = raw.split(/\r?\n/);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*enabled\s*:/.test(lines[i])) { idx = i; break; }
  }
  if (idx >= 0) {
    lines[idx] = `enabled: ${enabled}`;
  } else {
    // 无 enabled 行：插到 name 行之后（frontmatter 内）
    let insertAt = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*name\s*:/.test(lines[i])) { insertAt = i + 1; break; }
    }
    lines.splice(insertAt, 0, `enabled: ${enabled}`);
  }
  try {
    fs.writeFileSync(source, lines.join("\n"), "utf8");
    return { ok: true, path: source };
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message ?? e}` };
  }
}

/** 删除一条规则文件。 */
export function deleteHookifyRule(source: string): RuleFileResult {
  if (!source) return { ok: false, error: "缺少规则文件路径。" };
  try {
    fs.unlinkSync(source);
    return { ok: true, path: source };
  } catch (e: any) {
    return { ok: false, error: `删除失败：${e?.message ?? e}` };
  }
}
