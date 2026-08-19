import * as path from "path";
import * as fs from "fs";
import { ChatMessage } from "./provider";
import { reflectConversation } from "./provider";
import { evaluateHookifyRules, runCommandHooks } from "./hookify";
import { DANGEROUS_PATTERNS } from "./dangerous";
import { GoalState } from "./goal";

export interface PreResult {
  ok: boolean;
  message?: string;
  /** 不阻断但需要提示给模型的警告（hookify warn / 文件内容安全提示） */
  warnings?: string[];
}

/**
 * 权限规则（对标 Claude Code 的 allow/deny 权限规则）：对「工具名 + 参数 JSON」
 * 做正则匹配，决定放行 / 拒绝 / 默认（进入危险命令拦截）。
 *  - deny 命中：硬阻断（优先级最高）；
 *  - allow 命中：跳过 L2 危险命令硬阻断直接放行；
 *  - 都不命中：走常规危险命令拦截。
 */
export interface PermDecision {
  decision: "deny" | "allow" | "none";
  reason?: string;
}

export function applyPermissionRules(
  toolName: string,
  input: any,
  allowRules: string[] = [],
  denyRules: string[] = []
): PermDecision {
  const deny = (denyRules || []).map((s) => s.trim()).filter(Boolean);
  const allow = (allowRules || []).map((s) => s.trim()).filter(Boolean);
  const target = `${toolName} ${JSON.stringify(input ?? "")}`;
  for (const p of deny) {
    try {
      if (new RegExp(p, "i").test(target)) return { decision: "deny", reason: `命中拒绝规则 /${p}/` };
    } catch {
      /* 非法正则忽略 */
    }
  }
  for (const p of allow) {
    try {
      if (new RegExp(p, "i").test(target)) return { decision: "allow", reason: `命中放行规则 /${p}/` };
    } catch {
      /* 非法正则忽略 */
    }
  }
  return { decision: "none" };
}

/**
 * pre_tool_use：在工具真正执行前拦截危险命令（Layer 2「硬阻断」）。
 * 返回 ok=false 时，扩展会把 message 作为工具结果回灌模型，模型可据此改走安全方式。
 *
 * @param osSandboxed 该命令是否将运行在 OS 级沙箱内。若为 true，则跳过危险命令硬阻断
 *   —— 对标 Claude Code `autoAllowBashIfSandboxed`：沙箱已在内核级收口文件/网络，blast radius
 *   被隔离（如 worktree 内 `rm -rf` 不会触及宿主），故无需再对命令内容做审批，消除「审批疲劳」。
 *   注意：failIfUnavailable 且引擎缺失时 osSandboxed 为 false，仍会走本硬阻断作为兜底。
 */
/**
 * 文件编辑内容安全模式（对标 Claude Code security-guidance 插件）：
 * 对 edit_file/write_file 的「新增内容」做静态扫描，命中返回 warn（不阻断，
 * 但把警告回灌给模型，让它自行收敛）。覆盖 9 类常见风险。
 */
const FILE_SECURITY_PATTERNS: { pattern: RegExp; label: string; hint: string }[] = [
  {
    pattern: /\beval\s*\(|new\s+Function\s*\(|Function\s*\(\s*["'`]/i,
    label: "动态代码执行",
    hint: "避免 eval/new Function，改用安全解析方式",
  },
  {
    pattern: /\binnerHTML\s*=|document\.write\s*\(/i,
    label: "XSS 风险（innerHTML）",
    hint: "使用 textContent 或框架转义机制",
  },
  {
    pattern: /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY)\s*[:=]\s*["'][^"'\n]{6,}["']/i,
    label: "硬编码凭据",
    hint: "改用环境变量 / 密钥管理，勿把密钥写入代码",
  },
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+[\s\S]{0,80}?(?:\$\{|\.\.\.|concat\s*\(|join\s*\()/i,
    label: "SQL 注入风险（字符串拼接）",
    hint: "使用参数化查询 / ORM",
  },
  {
    pattern: /child_process\.(exec|spawn)\s*\([^)]*["'`+\s]/i,
    label: "命令注入风险",
    hint: "避免拼接外部输入进 shell 命令",
  },
  {
    pattern: /chmod\s+(-R\s+)?(777|666|a\+w)/i,
    label: "危险文件权限",
    hint: "收紧权限，避免 777/666",
  },
  {
    pattern: /atob\s*\(|btoa\s*\(|Buffer\.from\s*\([^)]*base64/i,
    label: "Base64 混淆",
    hint: "可能用于隐藏恶意载荷，确认必要性",
  },
  {
    pattern: /require\s*\(\s*["']child_process["']\s*\)|import\s+["']child_process["']/i,
    label: "subprocess 滥用",
    hint: "确认是否真的需要执行外部命令",
  },
  {
    pattern: /(?:\/etc\/|\\etc\\|authorized_keys|\.bashrc|\.zshrc)/i,
    label: "敏感系统文件写入",
    hint: "写入系统级配置文件需谨慎",
  },
];

/** 对文件编辑内容做安全扫描，返回警告列表（无命中返回空数组） */
export function scanFileContent(toolName: string, input: any): string[] {
  const warnings: string[] = [];
  if (toolName !== "edit_file" && toolName !== "write_file") {
    return warnings;
  }
  const texts: { label: string; content: string }[] = [];
  if (typeof input?.content === "string") texts.push({ label: "content", content: input.content });
  if (typeof input?.newText === "string") texts.push({ label: "newText", content: input.newText });
  if (typeof input?.new_text === "string") texts.push({ label: "new_text", content: input.new_text });
  if (typeof input?.new_string === "string") texts.push({ label: "new_string", content: input.new_string });
  if (typeof input?.text === "string") texts.push({ label: "text", content: input.text });
  if (typeof input?.newContent === "string") texts.push({ label: "newContent", content: input.newContent });
  if (Array.isArray(input?.edits)) {
    for (const e of input.edits) {
      if (typeof e?.newText === "string") texts.push({ label: "edit.newText", content: e.newText });
      if (typeof e?.new_text === "string") texts.push({ label: "edit.new_text", content: e.new_text });
      if (typeof e?.new_string === "string") texts.push({ label: "edit.new_string", content: e.new_string });
      if (typeof e?.text === "string") texts.push({ label: "edit.text", content: e.text });
    }
  }
  const filePath = String(input?.path ?? input?.filePath ?? "");
  for (const t of texts) {
    for (const s of FILE_SECURITY_PATTERNS) {
      if (s.pattern.test(t.content)) {
        warnings.push(
          `🔒 内容安全提示：${s.label}（${s.hint}）${filePath ? `，文件: ${filePath}` : ""}`
        );
      }
    }
  }
  return warnings;
}

export async function preToolUse(
  toolName: string,
  input: any,
  osSandboxed = false,
  workspaceRoot = "",
  allowRules: string[] = [],
  denyRules: string[] = [],
  allowCommandHooks = false
): Promise<PreResult> {
  const perm = applyPermissionRules(toolName, input, allowRules, denyRules);
  if (perm.decision === "deny") {
    return { ok: false, message: `⛔ 被权限规则拒绝（${perm.reason}）：${toolName}` };
  }
  return runPreToolHooks(
    toolName,
    input,
    osSandboxed,
    workspaceRoot,
    perm.decision === "allow",
    allowCommandHooks
  );
}

/**
 * ToolRuntime 专用的 pre-execute hook 层：权限规则已由 Runtime 单独裁决，
 * 此处只处理 hookify、外部 command hook、危险命令静态拦截与文件内容安全扫描。
 * allowByRule=true 表示用户显式 allowRules 已放行，可跳过 run_command 的危险文本硬阻断。
 */
export async function runPreToolHooks(
  toolName: string,
  input: any,
  osSandboxed = false,
  workspaceRoot = "",
  allowByRule = false,
  allowCommandHooks = false
): Promise<PreResult> {
  const warnings: string[] = [];

  // Hookify 可编程规则（对标 Claude Code hookify 插件）：用户 markdown 规则，热加载
  const hf = evaluateHookifyRules("bash", toolName, input, workspaceRoot);
  if (hf.blocked) return { ok: false, message: hf.blocked };
  warnings.push(...hf.warnings);
  const hfFile = evaluateHookifyRules("file", toolName, input, workspaceRoot);
  if (hfFile.blocked) return { ok: false, message: hfFile.blocked };
  warnings.push(...hfFile.warnings);

  // 外部命令 hook（对标 QwenWork hooks：命令 + stdin JSON + exit code，0=成功/2=阻塞）
  const hookEvent: "bash" | "file" | "all" =
    toolName === "run_command" || toolName === "run_code"
      ? "bash"
      : toolName === "edit_file" || toolName === "write_file"
        ? "file"
        : "all";
  const ch = await runCommandHooks(workspaceRoot, hookEvent, toolName, input, allowCommandHooks);
  if (ch.blocked) return { ok: false, message: ch.blocked };
  warnings.push(...ch.notes);

  // run_command 与 run_code(language=bash) 都属于 shell 文本入口。OS 沙箱内或 allowRules
  // 显式放行时跳过；其它场景按危险命令模式硬阻断。
  const shellText = toolName === "run_command"
    ? String(input?.command ?? (Array.isArray(input?.argv) ? input.argv.join(" ") : ""))
    : toolName === "run_code" && ["bash", "sh", "shell"].includes(String(input?.language ?? "python").toLowerCase())
      ? String(input?.code ?? "")
      : "";
  if (shellText && !osSandboxed && !allowByRule) {
    for (const p of DANGEROUS_PATTERNS) {
      if (p.test(shellText)) {
        return {
          ok: false,
          message:
            `⚠️ 危险操作被拦截（命中规则 ${p}）：\n${shellText}\n\n` +
            `该操作可能破坏数据或系统。如需执行，请在项目 AGENTS.md 中显式说明并改用更安全的方式；` +
            `或开启 freesek.sandboxMode=sandbox（OS 沙箱内执行可自动放行）；` +
            `或在 freesek.allowRules 中显式放行。`,
        };
      }
    }
  }

  warnings.push(...scanFileContent(toolName, input));
  return { ok: true, warnings: warnings.length ? warnings : undefined };
}

/**
 * post_tool_use：编辑后自动格式化（四级分级中的「静默放行/日志记录」）。
 * 复用 VS Code 已注册的 formatter；无 formatter 或失败则静默跳过，绝不阻断主流程。
 * 返回追加到工具结果的说明（仅当确实格式化了）。
 */
export async function postToolUse(
  toolName: string,
  input: any,
  workspaceRoot: string,
  autoFormat = true
): Promise<string | null> {
  if (!autoFormat) return null;
  if (toolName !== "edit_file" && toolName !== "write_file") return null;

  const fp = String(input?.path ?? "");
  const ext = path.extname(fp).toLowerCase();
  const supported = [
    ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".html", ".md", ".vue", ".yaml", ".yml",
  ];
  if (!supported.includes(ext)) return null;

  try {
    const vscode = require("vscode") as typeof import("vscode");
    const abs =
      path.isAbsolute(fp) || /^[A-Za-z]:[\\/]/.test(fp)
        ? fp
        : path.resolve(workspaceRoot, fp);
    const uri = vscode.Uri.file(abs);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edits: any[] | undefined = await vscode.commands.executeCommand(
      "vscode.executeFormatDocumentProvider",
      doc.uri,
      { tabSize: 2, insertSpaces: true }
    );
    if (edits && edits.length) {
      const wsEdit = new vscode.WorkspaceEdit();
      for (const e of edits) {
        wsEdit.replace(
          doc.uri,
          new vscode.Range(
            e.range.start.line,
            e.range.start.character,
            e.range.end.line,
            e.range.end.character
          ),
          e.newText
        );
      }
      const ok = await vscode.workspace.applyEdit(wsEdit);
      if (ok) {
        await doc.save();
        return `\n[hook] 已自动格式化 ${fp}`;
      }
    }
  } catch {
    /* 无 formatter 或失败，静默跳过 */
  }
  return null;
}

/**
 * SessionStart Hook（会话/恢复起点）：扫描项目约定文件，返回一句上下文加载摘要，
 * 供前端状态栏提示「已自动加载哪些项目约定」。确定性、零模型调用。
 */
export async function sessionStartHook(workspaceRoot: string): Promise<string> {
  const loaded: string[] = [];
  if (fs.existsSync(path.join(workspaceRoot, "AGENTS.md"))) loaded.push("AGENTS.md");
  if (fs.existsSync(path.join(workspaceRoot, "CLAUDE.md"))) loaded.push("CLAUDE.md");
  if (fs.existsSync(path.join(workspaceRoot, ".agent", "system_prompt.md"))) loaded.push("system_prompt.md");
  const rulesDir = path.join(workspaceRoot, ".agent", "rules");
  if (fs.existsSync(rulesDir)) {
    try {
      const n = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md")).length;
      if (n) loaded.push(`.agent/rules ×${n}`);
    } catch {
      /* 忽略 */
    }
  }
  if (loaded.length) return `📂 已自动加载项目约定：${loaded.join("、")}`;
  return "";
}

/**
 * UserPromptSubmit Hook（用户提交提示、模型处理前）：注入 hookify prompt 事件规则
 * （对标 Claude Code hookify 的 `event: prompt`）。命中 warn 规则的提示以 note
 * 形式返回，由调用方展示给用户/回灌模型。当前不做文本改写。
 */
export async function userPromptSubmitHook(
  text: string,
  workspaceRoot: string
): Promise<{ text: string; note: string }> {
  const hf = evaluateHookifyRules("prompt", "UserPromptSubmit", { user_prompt: text }, workspaceRoot);
  if (hf.blocked) return { text, note: hf.blocked };
  if (hf.warnings.length) return { text, note: hf.warnings.join("\n") };
  return { text, note: "" };
}

/**
 * PreCompact Hook（分级压缩前，确定性保证）：把「当前任务目标」钉进
 * `.agent/.last_compact_state.md`，使其跨越压缩持久——即使早期对话被压缩摘要，
 * 主线目标仍由 SessionStart/系统提示词重新注入（对标 Claude Code PreCompact
 * 「压缩前保存关键状态」，但我们用文件钉住而非内存摘要）。
 */
export async function preCompactHook(
  messages: ChatMessage[],
  workspaceRoot: string,
  goal?: GoalState
): Promise<string> {
  // 锚定目标优先级：goal 状态机（确定性）> 最近一条 user 消息（启发式兜底）
  let objective = "";
  if (goal?.objective && goal.phase !== "complete") {
    objective = goal.objective.slice(0, 300).trim();
  }
  if (!objective) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        objective = String(messages[i].content ?? "").slice(0, 300).trim();
        break;
      }
    }
  }
  if (!objective) return "";
  try {
    const dir = path.join(workspaceRoot, ".agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".last_compact_state.md"), objective, "utf8");
    return "🧷 已钉住当前任务目标（跨压缩持久）。";
  } catch {
    return "";
  }
}

/** SubagentStart Hook：子智能体启动时记录（供审计/通知）。 */
export function subagentStartHook(name: string): string {
  return `🧩 子智能体启动：${name}`;
}

/** SubagentStop Hook：子智能体结束时记录。 */
export function subagentStopHook(name: string): string {
  return `🧩 子智能体结束：${name}`;
}

/**
 * OnStop 钩子（对应文档「反思并建议规则更新」）：会话结束（一轮 Agent 跑完）后，
 * 让模型轻量回顾本次会话，判断是否需要固化规则 / 新建技能。命中的建议写入
 * `<root>/.agent/rule_suggestions.md`，等人类审核后手动固化进 AGENTS.md——
 * 不自动改规则，保持「配置自我进化」但「人来把关」。
 *
 * best-effort：无 API Key、服务不可用、消息太少时静默返回 null。
 */
export async function reflectAndSuggest(
  messages: ChatMessage[],
  workspaceRoot: string
): Promise<string | null> {
  // 仅在对话足够长时反思，避免每次都白调一次模型
  if (!messages || messages.length < 6) return null;

  const recent = messages
    .slice(-10)
    .map((m) => `[${m.role}] ${String(m.content ?? "").slice(0, 400)}`)
    .join("\n");

  const prompt = `请回顾本次会话（仅基于以下最近若干条，不要臆测）：
${recent}

请回答：
1. 是否犯了同类错误超过 2 次？如果有，什么规则能避免？
2. 用户是否反复纠正你的某个行为？如果是，应该加什么规则？
3. 是否有高频操作还没写成技能（skill）？

若有发现，严格用如下格式输出（可多行）：
[SUGGESTION] 建议添加规则: <具体内容>
[SUGGESTION] 建议新建 skill: <技能名称 + 用途>
如果没有发现，只输出: [NO_SUGGESTION]`;

  let text = "";
  try {
    text = await reflectConversation(prompt);
  } catch {
    return null;
  }
  if (!text || !text.includes("[SUGGESTION]")) return null;

  try {
    const dir = path.join(workspaceRoot, ".agent");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "rule_suggestions.md");
    const stamp = new Date().toLocaleString("zh-CN");
    fs.appendFileSync(fp, `\n## ${stamp}\n${text}\n`, "utf8");
    return `📝 会话反思已生成建议，写入 ${fp}，供你审核后固化到 AGENTS.md。`;
  } catch {
    return null;
  }
}
