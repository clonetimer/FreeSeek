import * as fs from "fs";
import * as path from "path";

/**
 * Layer 1: Agent Rules（规则层）——分层加载。
 *
 * 设计遵循文档「路径即相关性」原则：
 *  - 读取工作区根的 `.agent/system_prompt.md`（项目人格定义）；
 *  - 向上遍历目录树，收集沿途每个 `AGENTS.md` / `CLAUDE.md`（项目/子目录规则），
 *    按「根→当前目录」顺序注入（通用在前、具体在后）。CLAUDE.md 对标 Claude Code
 *    的同名约定文件，使 FreeSeek 能直接复用为 Claude Code 编写的项目规则。
 *  - 加载 `<root>/.agent/rules/*.md`（项目约定片段集合，可多文件拆分维护）。
 * 这样 Agent 启动时自动获得项目约定，无需把规则写死在代码里。
 */
export function loadRules(workingDir: string): string {
  const parts: string[] = [];

  // 1) 项目人格定义
  const sysPrompt = path.join(workingDir, ".agent", "system_prompt.md");
  if (fs.existsSync(sysPrompt)) {
    parts.push(
      `# 项目人格定义 (.agent/system_prompt.md)\n${fs.readFileSync(sysPrompt, "utf8").trim()}`
    );
  }

  // 2) 向上遍历 AGENTS.md / CLAUDE.md（限制深度，避免一路走到文件系统根）
  const found: { file: string; name: string }[] = [];
  let dir = path.resolve(workingDir);
  for (let i = 0; i < 20; i++) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) found.push({ file: f, name });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 从根到当前目录顺序注入（通用在前、具体在后）
  for (const { file, name } of found.reverse()) {
    const rel = path.relative(path.resolve(workingDir), path.dirname(file)) || ".";
    parts.push(`# 规则 (${rel}/${name})\n${fs.readFileSync(file, "utf8").trim()}`);
  }

  // 3) .agent/rules/*.md（项目约定片段集合，自动加载；便于多文件拆分维护）
  const rulesDir = path.join(workingDir, ".agent", "rules");
  if (fs.existsSync(rulesDir)) {
    try {
      const files = fs
        .readdirSync(rulesDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      for (const f of files) {
        const txt = fs.readFileSync(path.join(rulesDir, f), "utf8").trim();
        if (txt) parts.push(`# 约定 (.agent/rules/${f})\n${txt}`);
      }
    } catch {
      /* 忽略读取错误 */
    }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 加载「压缩前快照」：PreCompact Hook 会在每次自动压缩前，把当前任务目标写进
 * `.agent/.last_compact_state.md`；本函数在会话起点把它作为「跨压缩持久」的钉住
 * 上下文注入系统提示词，确保即使历史被分级压缩，任务主线也不丢失（对标 Claude Code
 * 的 PreCompact「压缩前保存关键状态」）。
 */
export function loadLastCompactState(projectRoot: string): string {
  const fp = path.join(projectRoot, ".agent", ".last_compact_state.md");
  try {
    if (fs.existsSync(fp)) {
      const txt = fs.readFileSync(fp, "utf8").trim();
      if (txt) return `# 压缩前快照（本任务目标，跨压缩持久）\n${txt}`;
    }
  } catch {
    /* 忽略 */
  }
  return "";
}
