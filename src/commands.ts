import * as fs from "fs";
import * as path from "path";
import { parseFrontmatter, fmString } from "./frontmatter";

/**
 * Slash 自定义命令（对标 Claude Code 的 /commands）：
 *   项目级命令放在 `<root>/.agent/commands/<name>.md`，文件可选 YAML frontmatter
 *   （description），正文可含 `$ARGUMENTS` 占位符，调用时由参数替换。
 *   用户可通过顶栏「📜 命令」调色板选择执行，也可在对话中由 Agent 用 slash_command 工具调用。
 */

export interface SlashCommand {
  name: string;
  description: string;
  body: string;
  source: string;
}

interface ParsedCommand {
  description?: string;
  body: string;
}

function parseCommandFrontmatter(raw: string): ParsedCommand {
  const { fm, body } = parseFrontmatter(raw);
  return { description: fmString(fm, "description"), body: body.trim() };
}

function scanDir(dir: string, sourceLabel: string, out: Map<string, SlashCommand>) {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md")) {
      const name = e.name.replace(/\.md$/, "");
      try {
        const parsed = parseCommandFrontmatter(fs.readFileSync(path.join(dir, e.name), "utf8"));
        out.set(name, {
          name,
          description: parsed.description || "(无描述)",
          body: parsed.body,
          source: sourceLabel,
        });
      } catch {
        /* 忽略单个坏文件 */
      }
    }
  }
}

/** 自动发现项目级 Slash 命令（<root>/.agent/commands/*.md）。 */
export function loadCommands(projectRoot: string): SlashCommand[] {
  const map = new Map<string, SlashCommand>();
  scanDir(path.join(projectRoot, ".agent", "commands"), ".agent/commands", map);
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getCommand(projectRoot: string, name: string): SlashCommand | null {
  return loadCommands(projectRoot).find((c) => c.name === name) || null;
}

/** 解析命令：把正文中的 $ARGUMENTS 替换为传入参数，返回展开后的提示词。 */
export function resolveCommand(
  projectRoot: string,
  name: string,
  args?: string
): { command: SlashCommand; prompt: string } | null {
  const cmd = getCommand(projectRoot, name);
  if (!cmd) return null;
  const argText = args && args.trim() ? args.trim() : "";
  const prompt = cmd.body.replace(/\$ARGUMENTS\b/g, argText);
  return { command: cmd, prompt };
}
